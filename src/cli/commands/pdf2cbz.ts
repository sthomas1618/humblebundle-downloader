import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import { Option, type Command } from 'commander'

import type { AppConfig, Pdf2CbzArchiveMode, ScanLibraryConfig } from '../../config'
import {
  getPdfCbzEntry,
  getPdfCbzEntries,
  loadCache,
  saveCache,
  setPdfCbzEntry,
  shouldRegeneratePdfCbz,
  shouldSkipFailedPdfCbz,
  type PdfFileStats,
} from '../../download/cache'
import { getArchiveLibraryPath } from '../../download/downloader'
import {
  inspectEnrichedMetadataFile,
  loadEnrichedMetadata,
  type EnrichedMetadataData,
  type EnrichedMetadataFile,
  type EnrichedMetadataMatch,
} from '../../download/enriched-metadata'
import { loadMetadata, type MetadataData, type MetadataProduct } from '../../download/metadata'
import { convertPdfToCbz } from '../../tools/pdf2cbz'
import {
  validateCbzAgainstPdf,
  type ComicInfoFields,
  type PdfRenderImageFormat,
} from '../../tools/pdf2cbz-helpers'
import { runWithConcurrency } from '../../utils/async'
import { normalizeFlatProductKey } from '../../utils/fs'
import { commonParentDirectory } from '../../utils/path'
import { assertPdf2CbzDependencies } from '../pdf2cbz-dependencies'
import { getOutputPath, isGlobInput, resolveInputFiles } from '../pdf2cbz-utils'
import { resolveCommandConfig } from '../utils/config'

type Pdf2CbzOptions = {
  config?: string
  library?: string
  libraryPath?: string
  cachePath?: string
  out?: string
  overwrite?: boolean
  force?: boolean
  keepTemp?: boolean
  concurrency?: number
  limit?: number
  dryRun?: boolean
  render?: boolean
  validate?: boolean
  repair?: boolean
  trackLocalProducts?: boolean
  archiveLocalProducts?: boolean
  archiveMode?: Pdf2CbzArchiveMode
}

type ArchiveResult = {
  archivePdfPath?: string
  archiveStatus: 'not-configured' | 'moved' | 'duplicate-removed' | 'conflict' | 'kept'
  archiveConflictReason?: string
}

type ComicInfoContext = {
  enrichedMetadata?: EnrichedMetadataData
  humbleMetadata?: MetadataData
}

type LocalProductIdentity = {
  source: 'local'
  localProductKey: string
  productTitle: string
  series?: string
  publisher?: string
  metadataSources?: {
    title?: string
    series?: string
    publisher?: string
  }
  comicInfoFields: ComicInfoFields
}

type Pdf2CbzTransformConfig = {
  trackLocalProducts: boolean
  archiveLocalProducts: boolean
  pdf2cbzConcurrency: number
  pdf2cbzArchiveMode: Pdf2CbzArchiveMode
}

type Pdf2CbzProgressCounts = {
  converted: number
  adopted: number
  skipped: number
  archived: number
  archiveConflicts: number
  dryRun: number
  failed: number
}

type PendingArchiveJob = {
  pdfPath: string
  pdfStats: PdfFileStats
  cbzPath: string
  cbzStats?: PdfFileStats
  cacheKey: string
  targetArchivePath: string
  localProduct?: LocalProductIdentity
}

type FailedTransformContext = {
  entry?: ReturnType<typeof getPdfCbzEntry>
  pdfPath: string
  pdfStats: PdfFileStats
  cbzPath: string
  cacheKey: string
  pdfLibrary?: ScanLibraryConfig
  humbleComicInfoFields?: ComicInfoFields
  localProduct?: LocalProductIdentity
}

type PdfDryRunDetails = {
  humbleComicInfoFields?: ComicInfoFields
  localProduct?: LocalProductIdentity
  trackLocalProducts: boolean
  targetArchivePath?: string
}

type RenderFormatContext = {
  pdfPath: string
  library?: ScanLibraryConfig
  humbleComicInfoFields?: ComicInfoFields
  localProduct?: LocalProductIdentity
}

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function isPathInsideOrSame(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath))
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function hasMangaSignal(value: string | undefined): boolean {
  return Boolean(value && /\bmanga\b/i.test(value))
}

function selectRenderImageFormat(context: RenderFormatContext): PdfRenderImageFormat {
  const signalValues = [
    context.pdfPath,
    context.library?.name,
    context.library?.path,
    context.humbleComicInfoFields?.Title,
    context.humbleComicInfoFields?.Series,
    context.humbleComicInfoFields?.Publisher,
    context.localProduct?.productTitle,
    context.localProduct?.series,
    context.localProduct?.publisher,
  ]
  return signalValues.some((value) => hasMangaSignal(value)) ? 'png' : 'jpg'
}

async function fileStats(filePath: string): Promise<PdfFileStats | undefined> {
  try {
    const stats = await stat(filePath)
    return { mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    return undefined
  }
}

async function fileSha256(filePath: string): Promise<string | undefined> {
  try {
    return await new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(filePath)
      stream.on('error', reject)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  } catch {
    return undefined
  }
}

async function sameFileContent(left: string, right: string): Promise<boolean | undefined> {
  const [leftHash, rightHash] = await Promise.all([fileSha256(left), fileSha256(right)])
  if (!leftHash || !rightHash) {
    return undefined
  }
  return leftHash === rightHash
}

function isCrossDeviceRenameError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EXDEV'
  )
}

async function moveFileAcrossDevices(sourcePath: string, targetPath: string): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  )

  try {
    await copyFile(sourcePath, temporaryPath)
    const copied = await sameFileContent(sourcePath, temporaryPath)
    if (!copied) {
      throw new Error(`Archive copy verification failed: ${sourcePath} -> ${targetPath}`)
    }
    await rename(temporaryPath, targetPath)
    await rm(sourcePath, { force: false })
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

function selectedLibrary(config: AppConfig): ScanLibraryConfig {
  return (
    config.scanLibraries.find((library) => library.name && library.name === config.libraryName) ??
    config.scanLibraries.find((library) => isSamePath(library.path, config.libraryPath)) ?? {
      name: config.libraryName,
      path: config.libraryPath,
      layout: 'bundle',
      formatPriority: config.formatPriority,
      extInclude: config.extInclude,
      extExclude: config.extExclude,
      archiveFormats: config.archiveFormats,
      platformInclude: config.platformInclude,
    }
  )
}

function libraryOutputPath(pdfPath: string, libraryRoot: string, outDirectory?: string): string {
  if (!outDirectory) {
    return getOutputPath(pdfPath)
  }
  const relativePath = path.relative(libraryRoot, pdfPath)
  const parsed = path.parse(relativePath)
  return path.join(path.resolve(outDirectory), parsed.dir, `${parsed.name}.cbz`)
}

async function collectCbzFiles(rootPath: string): Promise<string[]> {
  const files: string[] = []

  async function visit(currentPath: string): Promise<void> {
    let entries
    try {
      entries = await readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.cbz') {
        files.push(entryPath)
      }
    }
  }

  await visit(rootPath)
  return files.sort((left, right) => left.localeCompare(right))
}

function libraryForPath(
  config: AppConfig | undefined,
  pdfPath: string
): ScanLibraryConfig | undefined {
  if (!config) {
    return undefined
  }
  return [...config.scanLibraries]
    .filter((library) => isPathInsideOrSame(pdfPath, library.path))
    .sort((left, right) => path.resolve(right.path).length - path.resolve(left.path).length)[0]
}

function archivePdfPath(
  config: AppConfig,
  library: ScanLibraryConfig,
  pdfPath: string
): string | undefined {
  if (!library.archiveFormats?.includes('pdf')) {
    return undefined
  }
  const archiveLibraryPath = getArchiveLibraryPath(config, library)
  if (!archiveLibraryPath) {
    return undefined
  }
  const targetPath = path.join(archiveLibraryPath, path.relative(library.path, pdfPath))
  if (!isSamePath(pdfPath, targetPath) && isPathInsideOrSame(targetPath, library.path)) {
    throw new Error(
      `Refusing to archive source PDF into its source library: ${pdfPath} -> ${targetPath}`
    )
  }
  return targetPath
}

function resolvePdfArchivePath(
  config: AppConfig | undefined,
  library: ScanLibraryConfig | undefined,
  pdfPath: string,
  hasHumbleMatch: boolean,
  hasLocalProduct: boolean,
  transformConfig: Pdf2CbzTransformConfig
): string | undefined {
  if (!config || !library) {
    return undefined
  }
  if (hasHumbleMatch || (hasLocalProduct && transformConfig.archiveLocalProducts)) {
    return archivePdfPath(config, library, pdfPath)
  }
  return undefined
}

function effectiveTransformConfig(
  config: AppConfig | undefined,
  options: Pick<Pdf2CbzOptions, 'trackLocalProducts' | 'archiveLocalProducts' | 'archiveMode'>
): Pdf2CbzTransformConfig {
  return {
    trackLocalProducts: options.trackLocalProducts ?? config?.transform.trackLocalProducts ?? true,
    archiveLocalProducts:
      options.archiveLocalProducts ?? config?.transform.archiveLocalProducts ?? true,
    pdf2cbzConcurrency: config?.transform.pdf2cbzConcurrency ?? 2,
    pdf2cbzArchiveMode: options.archiveMode ?? config?.transform.pdf2cbzArchiveMode ?? 'after',
  }
}

async function archivePdf(
  pdfPath: string,
  pdfStats: PdfFileStats,
  targetPath?: string
): Promise<ArchiveResult> {
  if (!targetPath) {
    return { archiveStatus: 'not-configured' }
  }
  if (isSamePath(pdfPath, targetPath)) {
    return { archivePdfPath: targetPath, archiveStatus: 'kept' }
  }

  const existingStats = await fileStats(targetPath)
  if (existingStats) {
    if (existingStats.size === pdfStats.size) {
      const duplicate = await sameFileContent(pdfPath, targetPath)
      if (duplicate) {
        await rm(pdfPath, { force: false })
        return { archivePdfPath: targetPath, archiveStatus: 'duplicate-removed' }
      }
      return {
        archivePdfPath: targetPath,
        archiveStatus: 'conflict',
        archiveConflictReason:
          duplicate === false
            ? 'Archive target already exists with the same file size but different content.'
            : 'Archive target already exists and content identity could not be verified.',
      }
    }
    return {
      archivePdfPath: targetPath,
      archiveStatus: 'conflict',
      archiveConflictReason: 'Archive target already exists with a different file size.',
    }
  }

  await mkdir(path.dirname(targetPath), { recursive: true })
  try {
    await rename(pdfPath, targetPath)
  } catch (error) {
    if (!isCrossDeviceRenameError(error)) {
      throw error
    }
    await moveFileAcrossDevices(pdfPath, targetPath)
  }
  return { archivePdfPath: targetPath, archiveStatus: 'moved' }
}

function formatArchiveResultMessage(pdfPath: string, result: ArchiveResult): string {
  switch (result.archiveStatus) {
    case 'moved': {
      return `Archived source PDF: ${pdfPath} -> ${result.archivePdfPath}`
    }
    case 'duplicate-removed': {
      return `Removed duplicate source PDF already archived: ${pdfPath}`
    }
    case 'conflict': {
      const reason = result.archiveConflictReason ? ` ${result.archiveConflictReason}` : ''
      return `Archive conflict for source PDF: ${pdfPath}.${reason}`
    }
    default: {
      return `Kept source PDF: ${pdfPath}`
    }
  }
}

function formatDryRunDetails(details: PdfDryRunDetails): string {
  const parts: string[] = []

  if (details.humbleComicInfoFields) {
    const title = details.humbleComicInfoFields.Title ?? details.humbleComicInfoFields.Series
    parts.push(title ? `Humble product "${title}"` : 'Humble product')
  } else if (details.localProduct) {
    const localDetails = [`local product "${details.localProduct.productTitle}"`]
    if (details.localProduct.series) {
      localDetails.push(`series: ${details.localProduct.series}`)
    }
    if (details.localProduct.publisher) {
      localDetails.push(`publisher: ${details.localProduct.publisher}`)
    }
    parts.push(localDetails.join(', '))
  } else if (details.trackLocalProducts) {
    parts.push('bare PDF')
  } else {
    parts.push('local product tracking disabled')
  }

  parts.push(
    details.targetArchivePath ? `archive PDF -> ${details.targetArchivePath}` : 'keep source PDF'
  )

  return parts.length > 0 ? `; ${parts.join('; ')}` : ''
}

function formatByteSize(size: number | undefined): string {
  if (size === undefined) {
    return 'unknown'
  }
  if (size >= 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
  }
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1)} KB`
  }
  return `${size} B`
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds / 1000)
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

function formatProgressTotals(
  counts: Pdf2CbzProgressCounts,
  completed: number,
  total: number,
  startedAt: number
): string {
  const elapsedMs = Date.now() - startedAt
  const averageMs = completed > 0 ? elapsedMs / completed : 0
  const remaining = Math.max(0, total - completed)
  const eta = completed > 0 ? formatElapsed(averageMs * remaining) : 'unknown'
  return [
    `Progress: ${completed}/${total}`,
    `converted ${counts.converted}`,
    `adopted ${counts.adopted}`,
    `skipped ${counts.skipped}`,
    `archived ${counts.archived}`,
    `conflicts ${counts.archiveConflicts}`,
    `failed ${counts.failed}`,
    `avg ${formatElapsed(averageMs)}/item`,
    `ETA ${eta}`,
  ].join('; ')
}

function sameResolvedPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function findEnrichedFile(
  enrichedMetadata: EnrichedMetadataData | undefined,
  pdfPath: string
): EnrichedMetadataFile | undefined {
  return enrichedMetadata?.files.find((file) => sameResolvedPath(file.path, pdfPath))
}

async function getEnrichedFile(
  enrichedMetadata: EnrichedMetadataData | undefined,
  pdfPath: string
): Promise<EnrichedMetadataFile | undefined> {
  return findEnrichedFile(enrichedMetadata, pdfPath) ?? (await inspectEnrichedMetadataFile(pdfPath))
}

function firstRawMetadataValue(
  enrichedFile: EnrichedMetadataFile | undefined,
  keys: string[]
): { value: string; source: string } | undefined {
  for (const key of keys) {
    const rawValue = enrichedFile?.rawFields[key]
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue
    if (value) {
      return { value, source: key }
    }
  }
}

function findMetadataProduct(
  metadata: MetadataData | undefined,
  match: EnrichedMetadataMatch | undefined
): MetadataProduct | undefined {
  if (!metadata || !match) {
    return undefined
  }
  return metadata.orders[match.orderId]?.products.find(
    (product) => product.productTitle === match.productTitle
  )
}

function findUniqueMetadataMatch(
  metadata: MetadataData | undefined,
  pdfPath: string
): EnrichedMetadataMatch | undefined {
  if (!metadata) {
    return undefined
  }
  const filename = path.basename(pdfPath).toLowerCase()
  const matches: EnrichedMetadataMatch[] = []
  for (const order of Object.values(metadata.orders)) {
    for (const product of order.products) {
      for (const download of product.downloads) {
        if (download.filename.toLowerCase() !== filename) {
          continue
        }
        matches.push({
          cacheKey: download.cacheKey,
          orderId: order.orderId,
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
          filename: download.filename,
        })
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined
}

export function buildComicInfoFields(
  pdfPath: string,
  context: ComicInfoContext
): ComicInfoFields | undefined {
  const enrichedFile = findEnrichedFile(context.enrichedMetadata, pdfPath)
  const match =
    enrichedFile?.matches.length === 1
      ? enrichedFile.matches[0]
      : findUniqueMetadataMatch(context.humbleMetadata, pdfPath)
  if (!match) {
    return undefined
  }

  const product = findMetadataProduct(context.humbleMetadata, match)
  const enrichedProduct =
    context.enrichedMetadata?.products[normalizeFlatProductKey(match.productTitle)]
  const title = product?.productTitle ?? match.productTitle
  const publisher = enrichedFile?.publisher?.value ?? enrichedProduct?.publisher?.value
  const notes = [
    `Bundle: ${match.bundleTitle}`,
    `Order: ${match.orderId}`,
    `Source PDF: ${path.basename(pdfPath)}`,
    'Generated by humblebundle-downloader pdf2cbz.',
  ].join('\n')

  return {
    Title: title,
    Series: product?.productTitle ?? match.productTitle,
    Publisher: publisher,
    Notes: notes,
  }
}

async function buildLocalProductIdentity(
  pdfPath: string,
  context: ComicInfoContext,
  cacheKey: string,
  library?: ScanLibraryConfig
): Promise<LocalProductIdentity> {
  const enrichedFile = await getEnrichedFile(context.enrichedMetadata, pdfPath)
  const relativePath = library ? path.relative(library.path, pdfPath) : cacheKey
  const filenameTitle = path.basename(pdfPath, path.extname(pdfPath))
  const parentFolder = path.basename(path.dirname(pdfPath))
  const metadataSeries = firstRawMetadataValue(enrichedFile, [
    'xmp:calibre:series',
    'xmp:prism:publicationName',
  ])
  const productTitle = filenameTitle
  const series =
    metadataSeries?.value ?? (parentFolder && parentFolder !== '.' ? parentFolder : undefined)
  const publisher = enrichedFile?.publisher?.value
  const metadataSources = {
    title: 'filename',
    ...(series ? { series: metadataSeries?.source ?? 'path-parent' } : {}),
    ...(enrichedFile?.publisher ? { publisher: enrichedFile.publisher.source } : {}),
  }
  const notes = [
    'Source: local PDF',
    `Source PDF: ${path.basename(pdfPath)}`,
    'Generated by humblebundle-downloader pdf2cbz.',
  ].join('\n')

  return {
    source: 'local',
    localProductKey: library?.name ? `${library.name}:${relativePath}` : relativePath,
    productTitle,
    series,
    publisher,
    metadataSources,
    comicInfoFields: {
      Title: productTitle,
      Series: series ?? productTitle,
      Publisher: publisher,
      Notes: notes,
    },
  }
}

function localProductCacheFields(localProduct: LocalProductIdentity | undefined): Partial<{
  source: 'local'
  localProductKey: string
  productTitle: string
  series: string
  publisher: string
  metadataSources: LocalProductIdentity['metadataSources']
}> {
  if (!localProduct) {
    return {}
  }
  return {
    source: localProduct.source,
    localProductKey: localProduct.localProductKey,
    productTitle: localProduct.productTitle,
    series: localProduct.series,
    publisher: localProduct.publisher,
    metadataSources: localProduct.metadataSources,
  }
}

type Pdf2CbzRepairCounts = {
  checked: number
  ok: number
  repaired: number
  repairNeeded: number
  unverifiable: number
  failed: number
  dryRun: number
}

type RepairCandidate = {
  cacheKey: string
  entry: NonNullable<ReturnType<typeof getPdfCbzEntry>>
}

function resolveRepairSourcePdf(entry: RepairCandidate['entry']): string | undefined {
  if (entry.archivePdfPath && existsSync(entry.archivePdfPath)) {
    return entry.archivePdfPath
  }
  if (entry.pdfOriginalPath && existsSync(entry.pdfOriginalPath)) {
    return entry.pdfOriginalPath
  }
  return undefined
}

function shouldIncludeRepairCandidate(
  candidate: RepairCandidate,
  library: ScanLibraryConfig | undefined,
  selectedFiles: Set<string> | undefined
): boolean {
  const cbzPath = candidate.entry.cbzPath
  const pdfPath = candidate.entry.pdfOriginalPath
  if (selectedFiles) {
    return Boolean(
      (pdfPath && selectedFiles.has(path.resolve(pdfPath).toLowerCase())) ||
      (candidate.entry.archivePdfPath &&
        selectedFiles.has(path.resolve(candidate.entry.archivePdfPath).toLowerCase()))
    )
  }
  if (!library) {
    return true
  }
  return (
    isPathInsideOrSame(cbzPath, library.path) ||
    Boolean(pdfPath && isPathInsideOrSame(pdfPath, library.path))
  )
}

function formatValidationSummary(
  valid: boolean,
  pageCount: number,
  imageCount: number,
  imageExtensions: string[],
  reasons: string[]
): string {
  const status = valid ? 'ok' : 'repair-needed'
  const extensionLabel = imageExtensions.length > 0 ? imageExtensions.join(',') : 'none'
  const reasonLabel = reasons.length > 0 ? `; ${reasons.join('; ')}` : ''
  return `${status}; pages ${pageCount}; images ${imageCount}; formats ${extensionLabel}${reasonLabel}`
}

function shouldForceRerenderValidEntry(
  entry: RepairCandidate['entry'],
  selectedRenderImageFormat: PdfRenderImageFormat
): boolean {
  if (entry.conversionMode !== 'rendered') {
    return false
  }
  if (entry.renderImageFormat) {
    return entry.renderImageFormat !== selectedRenderImageFormat
  }
  return selectedRenderImageFormat === 'jpg'
}

async function runPdf2CbzRepairMode(options: {
  cache: Awaited<ReturnType<typeof loadCache>>
  cacheLibraryPath: string
  cachePath?: string
  library?: ScanLibraryConfig
  selectedFiles?: string[]
  comicInfoContext: ComicInfoContext
  transformConfig: Pdf2CbzTransformConfig
  dryRun: boolean
  repair: boolean
  force: boolean
  limit?: number
  keepTemp?: boolean
  concurrency: number
}): Promise<Pdf2CbzRepairCounts> {
  const selectedFileSet = options.selectedFiles
    ? new Set(options.selectedFiles.map((file) => path.resolve(file).toLowerCase()))
    : undefined
  const candidates = getPdfCbzEntries(options.cache)
    .map(([cacheKey, entry]) => ({ cacheKey, entry }))
    .filter((candidate) =>
      shouldIncludeRepairCandidate(candidate, options.library, selectedFileSet)
    )
  const counts: Pdf2CbzRepairCounts = {
    checked: 0,
    ok: 0,
    repaired: 0,
    repairNeeded: 0,
    unverifiable: 0,
    failed: 0,
    dryRun: 0,
  }
  let limitedWorkCount = 0
  let limitReached = false
  let cacheSaveQueue = Promise.resolve()

  async function checkpointCache(): Promise<void> {
    if (options.dryRun) {
      return
    }
    const save = cacheSaveQueue.then(() =>
      saveCache(options.cacheLibraryPath, options.cache, options.cachePath)
    )
    cacheSaveQueue = save.catch(() => {})
    await save
  }

  function claimRepairWork(): boolean {
    if (options.limit === undefined) {
      return true
    }
    if (limitedWorkCount >= options.limit) {
      limitReached = true
      return false
    }
    limitedWorkCount += 1
    if (limitedWorkCount >= options.limit) {
      limitReached = true
    }
    return true
  }

  await runWithConcurrency(candidates, options.concurrency, async ({ cacheKey, entry }) => {
    if (limitReached) {
      return
    }
    const sourcePdfPath = resolveRepairSourcePdf(entry)
    if (!sourcePdfPath || !existsSync(entry.cbzPath)) {
      counts.unverifiable += 1
      console.log(`Unverifiable: ${entry.cbzPath}; missing ${sourcePdfPath ? 'CBZ' : 'source PDF'}`)
      return
    }

    try {
      const validation = await validateCbzAgainstPdf(sourcePdfPath, entry.cbzPath)
      counts.checked += 1
      const summary = formatValidationSummary(
        validation.valid,
        validation.pageCount,
        validation.imageCount,
        validation.imageExtensions,
        validation.reasons
      )
      const pdfLibrary = entry.libraryPath
        ? ({ name: entry.libraryName, path: entry.libraryPath } satisfies ScanLibraryConfig)
        : options.library
      const humbleComicInfoFields = buildComicInfoFields(entry.pdfOriginalPath ?? sourcePdfPath, {
        ...options.comicInfoContext,
      })
      const localProduct =
        !humbleComicInfoFields && options.transformConfig.trackLocalProducts
          ? await buildLocalProductIdentity(
              entry.pdfOriginalPath ?? sourcePdfPath,
              options.comicInfoContext,
              cacheKey,
              pdfLibrary
            )
          : undefined
      const renderImageFormat = selectRenderImageFormat({
        pdfPath: entry.pdfOriginalPath ?? sourcePdfPath,
        library: pdfLibrary,
        humbleComicInfoFields,
        localProduct,
      })
      const forceRerender =
        validation.valid && options.repair && options.force
          ? shouldForceRerenderValidEntry(entry, renderImageFormat)
          : false

      if (validation.valid && !forceRerender) {
        counts.ok += 1
        console.log(`Validated CBZ: ${entry.cbzPath}; ${summary}`)
        if (
          !options.dryRun &&
          (entry.pageCount !== validation.pageCount ||
            entry.imageCount !== validation.imageCount ||
            entry.conversionMode === undefined)
        ) {
          const cbzStats = await fileStats(entry.cbzPath)
          setPdfCbzEntry(options.cache, cacheKey, {
            ...entry,
            transformStatus: 'generated',
            pageCount: validation.pageCount,
            imageCount: validation.imageCount,
            conversionMode: entry.conversionMode ?? 'extracted',
            validationWarnings: [],
            cbzMtimeMs: cbzStats?.mtimeMs ?? entry.cbzMtimeMs,
            cbzSize: cbzStats?.size ?? entry.cbzSize,
          })
          await checkpointCache()
        }
        return
      }

      if (validation.valid) {
        counts.ok += 1
      } else {
        counts.repairNeeded += 1
      }
      if (!options.repair) {
        console.log(`Repair needed: ${entry.cbzPath}; ${summary}`)
        return
      }
      if (!claimRepairWork()) {
        return
      }
      if (options.dryRun) {
        counts.dryRun += 1
        const action = forceRerender ? 'rerender' : 'repair'
        console.log(`Dry run: ${action} ${sourcePdfPath} -> ${entry.cbzPath}; ${summary}`)
        return
      }

      const startedAt = Date.now()
      const actionLabel = forceRerender ? 'Rerendering CBZ' : 'Repairing CBZ'
      console.log(`${actionLabel}: ${sourcePdfPath} -> ${entry.cbzPath}; ${summary}`)
      const result = await convertPdfToCbz(sourcePdfPath, {
        cbzPath: entry.cbzPath,
        keepTemp: options.keepTemp,
        renderFallback: true,
        renderImageFormat,
        comicInfoFields: humbleComicInfoFields ?? localProduct?.comicInfoFields,
      })
      const pdfStats = await fileStats(sourcePdfPath)
      const cbzStats = await fileStats(entry.cbzPath)
      setPdfCbzEntry(options.cache, cacheKey, {
        ...entry,
        version: 1,
        transformStatus: 'generated',
        source: humbleComicInfoFields ? 'humble' : (localProduct?.source ?? entry.source),
        libraryName: pdfLibrary?.name,
        libraryPath: pdfLibrary?.path,
        ...localProductCacheFields(localProduct),
        pdfMtimeMs: pdfStats?.mtimeMs ?? entry.pdfMtimeMs,
        pdfSize: pdfStats?.size ?? entry.pdfSize,
        cbzMtimeMs: cbzStats?.mtimeMs,
        cbzSize: cbzStats?.size,
        lastGeneratedMs: Date.now(),
        imageCount: result.imageCount,
        pageCount: result.pageCount,
        conversionMode: result.conversionMode,
        renderImageFormat: result.renderImageFormat,
        validationWarnings: result.validationWarnings,
        renderFallbackUsed: result.usedRenderFallback,
        comicInfoPreserved: result.comicInfoPreserved,
        comicInfoGenerated: result.comicInfoGenerated,
        comicInfoMerged: result.comicInfoMerged,
        comicInfoFields: result.comicInfoFields,
      })
      counts.repaired += 1
      await checkpointCache()
      console.log(
        `${forceRerender ? 'Rerendered' : 'Repaired'} CBZ: ${entry.cbzPath}; elapsed ${formatElapsed(
          Date.now() - startedAt
        )}; pages ${result.pageCount}; images ${result.imageCount}; render ${
          result.renderImageFormat ?? 'extracted'
        }; cbz ${formatByteSize(cbzStats?.size)}`
      )
    } catch (error) {
      counts.failed += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Failed validation/repair for ${entry.cbzPath}: ${message}`)
    }
  })

  await checkpointCache()
  if (limitReached && options.limit !== undefined) {
    console.log(`Reached repair limit: ${options.limit}.`)
  }
  return counts
}

export const pdf2cbzCommandTestUtils = {
  archivePdf,
  buildLocalProductIdentity,
  formatValidationSummary,
  formatDryRunDetails,
  formatArchiveResultMessage,
  formatProgressTotals,
  moveFileAcrossDevices,
  resolvePdfArchivePath,
  selectRenderImageFormat,
  shouldForceRerenderValidEntry,
}

export function registerPdf2CbzCommand(program: Command): void {
  program
    .command('pdf2cbz')
    .description('Convert comic PDFs into CBZ archives')
    .argument('[glob-or-path]', 'PDF path or glob to process')
    .option('--config <path>', 'Path to .hbd/config.json')
    .option('--library <name>', 'Configured library to transform')
    .option('-l, --library-path <path>', 'Library directory when no config is used')
    .option('--cache-path <path>', 'Cache file path (defaults to <library-path>/.cache.json)')
    .option('-o, --out <dir>', 'Output directory (defaults to the PDF directory)')
    .option('--overwrite', 'Overwrite existing CBZ files', false)
    .option('--force', 'Regenerate CBZ even if cache is up-to-date', false)
    .option('--keep-temp', 'Keep temporary extraction directory', false)
    .option('--concurrency <n>', 'Number of concurrent conversions', (value) =>
      Number.parseInt(value, 10)
    )
    .option('--limit <n>', 'Process at most this many eligible PDFs', (value) =>
      Number.parseInt(value, 10)
    )
    .addOption(
      new Option('--archive-mode <mode>', 'Archive mode for source PDFs').choices([
        'after',
        'inline',
        'skip',
        'only',
      ])
    )
    .option('--dry-run', 'Print actions without writing CBZs or cache', false)
    .option('--render', 'Render PDF pages to PNGs instead of extracting embedded images', false)
    .option(
      '--validate',
      'Validate existing CBZs against their source PDFs without regenerating',
      false
    )
    .option('--repair', 'Validate existing CBZs and regenerate only invalid archives', false)
    .addOption(
      new Option('--track-local-products', 'Track unmatched PDFs as local products').preset(true)
    )
    .addOption(
      new Option('--no-track-local-products', 'Do not track unmatched PDFs as local products')
    )
    .addOption(
      new Option(
        '--archive-local-products',
        'Archive unmatched local PDFs when archiveRoot applies'
      ).preset(true)
    )
    .addOption(
      new Option('--no-archive-local-products', 'Keep unmatched local PDFs after CBZ generation')
    )
    .action(async (input: string | undefined, options: Pdf2CbzOptions) => {
      const libraryMode = !input
      const shouldResolveConfig = libraryMode || Boolean(options.config || options.library)
      const resolvedConfig = shouldResolveConfig
        ? await resolveCommandConfig(program, {
            config: options.config,
            library: options.library,
            libraryPath: options.libraryPath,
            cachePath: options.cachePath,
            trackLocalProducts: options.trackLocalProducts,
            archiveLocalProducts: options.archiveLocalProducts,
            pdf2cbzConcurrency: options.concurrency,
            pdf2cbzArchiveMode: options.archiveMode,
          })
        : undefined
      const config = resolvedConfig?.config
      const library = config ? selectedLibrary(config) : undefined
      const resolvedInput = libraryMode ? library?.path : input
      if (!resolvedInput) {
        program.error('No PDF files found to process.', { exitCode: 1 })
      }

      const { files, root } = await resolveInputFiles(resolvedInput)
      if (files.length === 0 && !libraryMode) {
        program.error('No PDF files found to process.', { exitCode: 1 })
      }

      const cacheRoot = libraryMode
        ? (library?.path ?? root)
        : isGlobInput(resolvedInput)
          ? root
          : commonParentDirectory(files)
      const cacheLibraryPath = config?.libraryPath ?? cacheRoot
      const cachePath = config?.cachePath ?? options.cachePath
      const cache = await loadCache(cacheLibraryPath, cachePath)
      const transformConfig = effectiveTransformConfig(config, options)
      const comicInfoContext: ComicInfoContext = config
        ? {
            enrichedMetadata: await loadEnrichedMetadata(
              config.libraryPath,
              config.enrichedMetadataPath
            ),
            humbleMetadata: await loadMetadata(config.libraryPath, config.metadataPath),
          }
        : {}
      const concurrency =
        options.concurrency && Number.isFinite(options.concurrency) && options.concurrency > 0
          ? options.concurrency
          : transformConfig.pdf2cbzConcurrency
      const archiveMode = transformConfig.pdf2cbzArchiveMode
      await assertPdf2CbzDependencies({ ...options, archiveMode }, program)
      if (options.limit !== undefined && (!Number.isFinite(options.limit) || options.limit <= 0)) {
        program.error('--limit must be a positive integer.', { exitCode: 1 })
      }
      const limit =
        options.limit && Number.isFinite(options.limit) && options.limit > 0
          ? Math.floor(options.limit)
          : undefined

      if (options.validate || options.repair) {
        const repairCounts = await runPdf2CbzRepairMode({
          cache,
          cacheLibraryPath,
          cachePath,
          library,
          selectedFiles: libraryMode ? undefined : files,
          comicInfoContext,
          transformConfig,
          dryRun: Boolean(options.dryRun || options.validate),
          repair: options.repair ?? false,
          force: options.force ?? false,
          limit,
          keepTemp: options.keepTemp,
          concurrency,
        })
        const mode = options.repair ? 'repair' : 'validate'
        console.log(
          `Completed pdf2cbz ${mode}. Checked: ${repairCounts.checked}, ok: ${repairCounts.ok}, repair needed: ${repairCounts.repairNeeded}, repaired: ${repairCounts.repaired}, unverifiable: ${repairCounts.unverifiable}, failed: ${repairCounts.failed}, dry-run: ${repairCounts.dryRun}.`
        )
        return
      }

      const counts: Pdf2CbzProgressCounts = {
        converted: 0,
        adopted: 0,
        skipped: 0,
        archived: 0,
        archiveConflicts: 0,
        dryRun: 0,
        failed: 0,
      }
      const startedAt = Date.now()
      let completedCount = 0
      let lastProgressAt = startedAt
      const pendingArchiveJobs: PendingArchiveJob[] = []
      let limitedWorkCount = 0
      let limitReached = false
      let cacheSaveQueue = Promise.resolve()
      async function checkpointCache(): Promise<void> {
        if (options.dryRun) {
          return
        }
        const save = cacheSaveQueue.then(() => saveCache(cacheLibraryPath, cache, cachePath))
        cacheSaveQueue = save.catch(() => {})
        await save
      }
      function noteProgress(): void {
        completedCount += 1
        const now = Date.now()
        if (completedCount % 10 === 0 || now - lastProgressAt >= 60_000) {
          console.log(formatProgressTotals(counts, completedCount, files.length, startedAt))
          lastProgressAt = now
        }
      }
      function claimLimitedWork(): boolean {
        if (limit === undefined) {
          return true
        }
        if (limitedWorkCount >= limit) {
          limitReached = true
          return false
        }
        limitedWorkCount += 1
        if (limitedWorkCount >= limit) {
          limitReached = true
        }
        return true
      }

      await runWithConcurrency(files, concurrency, async (pdfPath) => {
        if (limitReached) {
          return
        }
        const itemStartedAt = Date.now()
        let failedTransformContext: FailedTransformContext | undefined
        try {
          const stats = await stat(pdfPath)
          const pdfStats = { mtimeMs: stats.mtimeMs, size: stats.size }
          const pdfLibrary = libraryMode ? library : libraryForPath(config, pdfPath)
          const cbzPath =
            pdfLibrary && isPathInsideOrSame(pdfPath, pdfLibrary.path)
              ? libraryOutputPath(pdfPath, pdfLibrary.path, options.out)
              : getOutputPath(pdfPath, options.out)
          const cacheKey = path.relative(cacheRoot, pdfPath)
          const entry = getPdfCbzEntry(cache, cacheKey)
          const cbzStats = await fileStats(cbzPath)
          const needsRegeneration = shouldRegeneratePdfCbz(
            entry,
            pdfStats,
            options.force ?? false,
            cbzStats
          )
          const cbzExists = existsSync(cbzPath)
          const humbleComicInfoFields = buildComicInfoFields(pdfPath, comicInfoContext)
          const trackLocalProduct = Boolean(
            !humbleComicInfoFields && transformConfig.trackLocalProducts
          )
          const localProduct = trackLocalProduct
            ? await buildLocalProductIdentity(pdfPath, comicInfoContext, cacheKey, pdfLibrary)
            : undefined
          const targetArchivePath = resolvePdfArchivePath(
            config,
            pdfLibrary,
            pdfPath,
            Boolean(humbleComicInfoFields),
            Boolean(localProduct),
            transformConfig
          )
          const effectiveArchivePath = archiveMode === 'skip' ? undefined : targetArchivePath
          const shouldArchiveFreshPdf =
            effectiveArchivePath &&
            entry?.archiveStatus !== 'moved' &&
            entry?.archiveStatus !== 'duplicate-removed'
          failedTransformContext = {
            entry,
            pdfPath,
            pdfStats,
            cbzPath,
            cacheKey,
            pdfLibrary,
            humbleComicInfoFields,
            localProduct,
          }

          if (
            shouldSkipFailedPdfCbz(entry, pdfStats, options.force ?? false, options.render ?? false)
          ) {
            counts.skipped += 1
            const reason = entry?.lastError ? ` Last error: ${entry.lastError}` : ''
            console.log(`Skipping (previous failure, use --force to retry): ${pdfPath}.${reason}`)
            noteProgress()
            return
          }

          if (!needsRegeneration && !options.overwrite) {
            if (shouldArchiveFreshPdf) {
              if (!claimLimitedWork()) {
                return
              }
              if (options.dryRun) {
                counts.dryRun += 1
                console.log(
                  `Dry run: archive ${pdfPath} -> ${effectiveArchivePath}${formatDryRunDetails({
                    humbleComicInfoFields,
                    localProduct,
                    trackLocalProducts: transformConfig.trackLocalProducts,
                    targetArchivePath: effectiveArchivePath,
                  })}`
                )
                noteProgress()
                return
              }
              const archiveJob = {
                pdfPath,
                pdfStats,
                cbzPath,
                cbzStats,
                cacheKey,
                targetArchivePath: effectiveArchivePath,
                localProduct,
              } satisfies PendingArchiveJob
              if (archiveMode === 'after') {
                pendingArchiveJobs.push(archiveJob)
              } else {
                const archiveResult = await archivePdf(
                  pdfPath,
                  pdfStats,
                  archiveJob.targetArchivePath
                )
                if (
                  archiveResult.archiveStatus === 'moved' ||
                  archiveResult.archiveStatus === 'duplicate-removed'
                ) {
                  counts.archived += 1
                }
                if (archiveResult.archiveStatus === 'conflict') {
                  counts.archiveConflicts += 1
                }
                setPdfCbzEntry(cache, cacheKey, {
                  ...entry!,
                  transformStatus: 'generated',
                  ...localProductCacheFields(localProduct),
                  archivePdfPath: archiveResult.archivePdfPath,
                  archiveStatus: archiveResult.archiveStatus,
                  archiveConflictReason: archiveResult.archiveConflictReason,
                  cbzMtimeMs: cbzStats?.mtimeMs ?? entry?.cbzMtimeMs,
                  cbzSize: cbzStats?.size ?? entry?.cbzSize,
                })
                await checkpointCache()
                console.log(formatArchiveResultMessage(pdfPath, archiveResult))
              }
              noteProgress()
              return
            }
            if (localProduct && entry) {
              setPdfCbzEntry(cache, cacheKey, {
                ...entry,
                transformStatus: 'generated',
                ...localProductCacheFields(localProduct),
                cbzMtimeMs: cbzStats?.mtimeMs ?? entry.cbzMtimeMs,
                cbzSize: cbzStats?.size ?? entry.cbzSize,
              })
              await checkpointCache()
            }
            counts.skipped += 1
            console.log(`Skipping (cache fresh): ${pdfPath}`)
            noteProgress()
            return
          }

          if (archiveMode === 'only') {
            counts.skipped += 1
            console.log(`Skipping (archive only, needs conversion): ${pdfPath}`)
            noteProgress()
            return
          }

          if (cbzExists && !options.overwrite && !options.force && cbzStats) {
            if (!claimLimitedWork()) {
              return
            }
            if (options.dryRun) {
              counts.dryRun += 1
              console.log(`Dry run: adopt existing CBZ ${cbzPath}`)
              noteProgress()
              return
            }
            const archiveStatus = archiveMode === 'skip' || !effectiveArchivePath ? 'kept' : 'kept'
            setPdfCbzEntry(cache, cacheKey, {
              version: 1,
              transformStatus: 'generated',
              source: humbleComicInfoFields ? 'humble' : localProduct?.source,
              libraryName: pdfLibrary?.name,
              libraryPath: pdfLibrary?.path,
              ...localProductCacheFields(localProduct),
              pdfKey: cacheKey,
              pdfOriginalPath: pdfPath,
              pdfMtimeMs: pdfStats.mtimeMs,
              pdfSize: pdfStats.size,
              cbzPath,
              cbzMtimeMs: cbzStats.mtimeMs,
              cbzSize: cbzStats.size,
              archiveStatus,
              lastGeneratedMs: Date.now(),
            })
            counts.adopted += 1
            await checkpointCache()
            if (effectiveArchivePath && archiveMode !== 'skip') {
              pendingArchiveJobs.push({
                pdfPath,
                pdfStats,
                cbzPath,
                cbzStats,
                cacheKey,
                targetArchivePath: effectiveArchivePath,
                localProduct,
              })
            }
            console.log(
              `Adopted existing CBZ: ${pdfPath} -> ${cbzPath}; cbz ${formatByteSize(
                cbzStats.size
              )}; elapsed ${formatElapsed(Date.now() - itemStartedAt)}`
            )
            noteProgress()
            return
          }

          if (cbzExists && !options.overwrite && needsRegeneration) {
            counts.skipped += 1
            console.log(`Skipping (exists, use --overwrite): ${cbzPath}`)
            noteProgress()
            return
          }

          if (!claimLimitedWork()) {
            return
          }
          if (options.dryRun) {
            counts.dryRun += 1
            console.log(
              `Dry run: convert ${pdfPath} -> ${cbzPath}${formatDryRunDetails({
                humbleComicInfoFields,
                localProduct,
                trackLocalProducts: transformConfig.trackLocalProducts,
                targetArchivePath: effectiveArchivePath,
              })}`
            )
            noteProgress()
            return
          }

          const renderImageFormat = selectRenderImageFormat({
            pdfPath,
            library: pdfLibrary,
            humbleComicInfoFields,
            localProduct,
          })
          console.log(`Converting ${pdfPath} -> ${cbzPath}`)
          const result = await convertPdfToCbz(pdfPath, {
            cbzPath,
            keepTemp: options.keepTemp,
            renderFallback: options.render,
            renderImageFormat,
            comicInfoFields: humbleComicInfoFields ?? localProduct?.comicInfoFields,
          })
          const generatedStats = await fileStats(cbzPath)
          let archiveResult: ArchiveResult = { archiveStatus: 'kept' }
          if (effectiveArchivePath && archiveMode === 'inline') {
            archiveResult = await archivePdf(pdfPath, pdfStats, effectiveArchivePath)
            if (
              archiveResult.archiveStatus === 'moved' ||
              archiveResult.archiveStatus === 'duplicate-removed'
            ) {
              counts.archived += 1
            }
            if (archiveResult.archiveStatus === 'conflict') {
              counts.archiveConflicts += 1
            }
          } else if (effectiveArchivePath && archiveMode === 'after') {
            pendingArchiveJobs.push({
              pdfPath,
              pdfStats,
              cbzPath,
              cbzStats: generatedStats,
              cacheKey,
              targetArchivePath: effectiveArchivePath,
              localProduct,
            })
          }

          setPdfCbzEntry(cache, cacheKey, {
            version: 1,
            transformStatus: 'generated',
            source: humbleComicInfoFields ? 'humble' : localProduct?.source,
            libraryName: pdfLibrary?.name,
            libraryPath: pdfLibrary?.path,
            ...localProductCacheFields(localProduct),
            pdfKey: cacheKey,
            pdfOriginalPath: pdfPath,
            pdfMtimeMs: pdfStats.mtimeMs,
            pdfSize: pdfStats.size,
            cbzPath,
            cbzMtimeMs: generatedStats?.mtimeMs,
            cbzSize: generatedStats?.size,
            archivePdfPath: archiveResult.archivePdfPath,
            archiveStatus: archiveResult.archiveStatus,
            archiveConflictReason: archiveResult.archiveConflictReason,
            lastGeneratedMs: Date.now(),
            imageCount: result.imageCount,
            pageCount: result.pageCount,
            conversionMode: result.conversionMode,
            renderImageFormat: result.renderImageFormat,
            validationWarnings: result.validationWarnings,
            renderFallbackUsed: result.usedRenderFallback,
            comicInfoPreserved: result.comicInfoPreserved,
            comicInfoGenerated: result.comicInfoGenerated,
            comicInfoMerged: result.comicInfoMerged,
            comicInfoFields: result.comicInfoFields,
          })
          counts.converted += 1
          await checkpointCache()
          console.log(
            `Converted ${pdfPath}; elapsed ${formatElapsed(
              Date.now() - itemStartedAt
            )}; pages ${result.pageCount}; images ${result.imageCount}; mode ${
              result.conversionMode
            }; render ${result.renderImageFormat ?? 'extracted'}; cbz ${formatByteSize(
              generatedStats?.size
            )}; archive ${archiveResult.archiveStatus}${
              result.validationWarnings.length > 0
                ? `; extraction rejected: ${result.validationWarnings.join('; ')}`
                : ''
            }`
          )
          noteProgress()
        } catch (error) {
          counts.failed += 1
          const message = error instanceof Error ? error.message : String(error)
          if (!options.dryRun && failedTransformContext) {
            setPdfCbzEntry(cache, failedTransformContext.cacheKey, {
              ...failedTransformContext.entry,
              version: 1,
              transformStatus: 'failed',
              source: failedTransformContext.humbleComicInfoFields
                ? 'humble'
                : failedTransformContext.localProduct?.source,
              libraryName: failedTransformContext.pdfLibrary?.name,
              libraryPath: failedTransformContext.pdfLibrary?.path,
              ...localProductCacheFields(failedTransformContext.localProduct),
              pdfKey: failedTransformContext.cacheKey,
              pdfOriginalPath: failedTransformContext.pdfPath,
              pdfMtimeMs: failedTransformContext.pdfStats.mtimeMs,
              pdfSize: failedTransformContext.pdfStats.size,
              cbzPath: failedTransformContext.cbzPath,
              archiveStatus: failedTransformContext.entry?.archiveStatus ?? 'kept',
              lastGeneratedMs: failedTransformContext.entry?.lastGeneratedMs ?? Date.now(),
              lastFailedMs: Date.now(),
              lastError: message,
              renderFallbackRequested: options.render ?? false,
            })
            await checkpointCache()
          }
          console.error(`Failed ${pdfPath}: ${message}`)
          noteProgress()
        }
      })

      if (
        libraryMode &&
        library &&
        config &&
        archiveMode !== 'skip' &&
        !options.force &&
        !options.overwrite
      ) {
        const activePdfKeys = new Set(files.map((file) => path.resolve(file).toLowerCase()))
        const cbzFiles = await collectCbzFiles(library.path)
        for (const cbzPath of cbzFiles) {
          if (limitReached) {
            break
          }
          const pdfPath = path.join(path.dirname(cbzPath), `${path.basename(cbzPath, '.cbz')}.pdf`)
          if (activePdfKeys.has(path.resolve(pdfPath).toLowerCase())) {
            continue
          }
          const cacheKey = path.relative(cacheRoot, pdfPath)
          const existingEntry = getPdfCbzEntry(cache, cacheKey)
          if (existingEntry?.archiveStatus === 'moved') {
            continue
          }
          const archivePath = archivePdfPath(config, library, pdfPath)
          if (!archivePath) {
            continue
          }
          const archivedPdfStats = await fileStats(archivePath)
          const cbzStats = await fileStats(cbzPath)
          if (!archivedPdfStats || !cbzStats) {
            continue
          }
          const humbleComicInfoFields = buildComicInfoFields(pdfPath, comicInfoContext)
          const localProduct =
            !humbleComicInfoFields && transformConfig.trackLocalProducts
              ? await buildLocalProductIdentity(pdfPath, comicInfoContext, cacheKey, library)
              : undefined
          if (options.dryRun) {
            if (!claimLimitedWork()) {
              break
            }
            counts.dryRun += 1
            console.log(`Dry run: adopt archived source PDF ${archivePath} -> ${cbzPath}`)
            continue
          }
          if (!claimLimitedWork()) {
            break
          }
          setPdfCbzEntry(cache, cacheKey, {
            version: 1,
            transformStatus: 'generated',
            source: humbleComicInfoFields ? 'humble' : localProduct?.source,
            libraryName: library.name,
            libraryPath: library.path,
            ...localProductCacheFields(localProduct),
            pdfKey: cacheKey,
            pdfOriginalPath: pdfPath,
            pdfMtimeMs: archivedPdfStats.mtimeMs,
            pdfSize: archivedPdfStats.size,
            cbzPath,
            cbzMtimeMs: cbzStats.mtimeMs,
            cbzSize: cbzStats.size,
            archivePdfPath: archivePath,
            archiveStatus: 'moved',
            lastGeneratedMs: Date.now(),
          })
          counts.adopted += 1
          await checkpointCache()
          console.log(`Adopted archived PDF: ${archivePath}; cbz ${formatByteSize(cbzStats.size)}`)
        }
      }

      if (!options.dryRun && pendingArchiveJobs.length > 0) {
        console.log(`Archiving ${pendingArchiveJobs.length} source PDFs after conversion.`)
        await runWithConcurrency(pendingArchiveJobs, Math.min(concurrency, 2), async (job) => {
          const archiveResult = await archivePdf(job.pdfPath, job.pdfStats, job.targetArchivePath)
          if (
            archiveResult.archiveStatus === 'moved' ||
            archiveResult.archiveStatus === 'duplicate-removed'
          ) {
            counts.archived += 1
          }
          if (archiveResult.archiveStatus === 'conflict') {
            counts.archiveConflicts += 1
          }
          const entry = getPdfCbzEntry(cache, job.cacheKey)
          if (entry) {
            setPdfCbzEntry(cache, job.cacheKey, {
              ...entry,
              ...localProductCacheFields(job.localProduct),
              archivePdfPath: archiveResult.archivePdfPath,
              archiveStatus: archiveResult.archiveStatus,
              archiveConflictReason: archiveResult.archiveConflictReason,
              cbzMtimeMs: job.cbzStats?.mtimeMs ?? entry.cbzMtimeMs,
              cbzSize: job.cbzStats?.size ?? entry.cbzSize,
            })
            await checkpointCache()
          }
          console.log(formatArchiveResultMessage(job.pdfPath, archiveResult))
        })
      }

      if (!options.dryRun) {
        await checkpointCache()
      }

      const modeLabel = libraryMode ? ` in library "${library?.name ?? cacheRoot}"` : ''
      const limitLabel = limitReached && limit !== undefined ? ` Reached limit: ${limit}.` : ''
      console.log(
        `Processed ${files.length} PDFs${modeLabel}. Converted: ${counts.converted}, adopted: ${counts.adopted}, skipped: ${counts.skipped}, archived: ${counts.archived}, archive conflicts: ${counts.archiveConflicts}, failed: ${counts.failed}, dry-run: ${counts.dryRun}.${limitLabel}`
      )
    })
}
