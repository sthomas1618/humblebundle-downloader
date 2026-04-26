import { access, copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { AppConfig } from '../config'
import { markConfigLibrariesFlat } from '../config'
import {
  buildAuditCandidatePaths,
  buildLocalDirectoryIndex,
  buildFlatCacheKey,
  findAuditFile,
  getScanPaths,
  inferBundleFolder,
  selectRoutedDownloadCandidates,
  type LocalDirectoryIndex,
  type RoutedDownloadCandidate,
  type WebDownloadCandidate,
} from '../download/downloader'
import { loadCache, saveCache, upsertFlatIndexEntry, type FlatIndexEntry } from '../download/cache'
import { loadMetadata } from '../download/metadata'
import {
  buildProductFolder,
  buildLibraryProductFolder,
  inferPublisherFolder,
  inferSeriesFolder,
  normalizeFlatProductKey,
  normalizeFlatPublisherKey,
} from '../utils/fs'

export type OrganizeActionStatus =
  | 'already-correct'
  | 'would-move'
  | 'moved'
  | 'missing'
  | 'conflict'

export type OrganizeAction = {
  cacheKey: string
  filename: string
  bundleTitle: string
  productTitle: string
  expectedLibraryName?: string
  selected: boolean
  sourcePath?: string
  destinationPath: string
  status: OrganizeActionStatus
  reason?: string
}

export type OrganizeSummary = {
  dryRun: boolean
  ordersProcessed: number
  productsProcessed: number
  selectedCandidates: number
  alreadyCorrect: number
  wouldMove: number
  moved: number
  missing: number
  conflicts: number
  reportPath?: string
}

export type OrganizeReport = OrganizeSummary & {
  actions: OrganizeAction[]
}

export type OrganizeOptions = {
  config: AppConfig
  apply?: boolean
  canonical?: boolean
  flat?: boolean
  reportPath?: string
  onProgress?: (message: string) => void
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function samePathExact(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

function getExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? ''
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = path.relative(parent, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function topLevelDirectoryName(rootPath: string, candidatePath: string): string | undefined {
  const relativePath = path.relative(rootPath, candidatePath)
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined
  }
  return relativePath.split(path.sep)[0]
}

function isHumbleBundleFolder(folderName: string | undefined): boolean {
  return folderName?.toLowerCase().startsWith('humble ') ?? false
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function renamePathCasing(sourcePath: string, destinationPath: string): Promise<void> {
  const source = path.resolve(sourcePath)
  const destination = path.resolve(destinationPath)
  const sourceParsed = path.parse(source)
  const destinationParsed = path.parse(destination)
  const sourceParts = path.relative(sourceParsed.root, source).split(path.sep)
  const destinationParts = path.relative(destinationParsed.root, destination).split(path.sep)
  let currentPath = sourceParsed.root

  for (const [index, sourcePart] of sourceParts.entries()) {
    const destinationPart = destinationParts[index]
    if (!destinationPart) {
      return
    }

    if (sourcePart.toLowerCase() !== destinationPart.toLowerCase()) {
      return
    }

    if (sourcePart !== destinationPart) {
      const oldPath = path.join(currentPath, sourcePart)
      const temporaryPath = path.join(
        currentPath,
        `.hbd-case-rename-${process.pid}-${Date.now()}-${index}-${sourcePart}`
      )
      const newPath = path.join(currentPath, destinationPart)
      await rename(oldPath, temporaryPath)
      await rename(temporaryPath, newPath)
    }

    currentPath = path.join(currentPath, destinationPart)
  }
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  if (samePath(sourcePath, destinationPath) && !samePathExact(sourcePath, destinationPath)) {
    await renamePathCasing(sourcePath, destinationPath)
    return
  }
  await mkdir(path.dirname(destinationPath), { recursive: true })
  try {
    await rename(sourcePath, destinationPath)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      await copyFile(sourcePath, destinationPath)
      await rm(sourcePath, { force: true })
      return
    }
    throw error
  }
}

function summarizeActions(
  actions: OrganizeAction[],
  options: {
    dryRun: boolean
    ordersProcessed: number
    productsProcessed: number
    selectedCandidates: number
    reportPath?: string
  }
): OrganizeSummary {
  return {
    ...options,
    alreadyCorrect: actions.filter((action) => action.status === 'already-correct').length,
    wouldMove: actions.filter((action) => action.status === 'would-move').length,
    moved: actions.filter((action) => action.status === 'moved').length,
    missing: actions.filter((action) => action.status === 'missing').length,
    conflicts: actions.filter((action) => action.status === 'conflict').length,
  }
}

function metadataCandidate(download: {
  filename: string
  platform: string
  fileSize?: number
  md5?: string
}): WebDownloadCandidate {
  return {
    filename: download.filename,
    platform: download.platform,
    url: '',
    fileSize: download.fileSize,
    md5: download.md5,
  }
}

function buildPublisherFoldersByProduct(
  orders: Array<{ bundleTitle: string; products: Array<{ productTitle: string }> }>
): Map<string, string> {
  const publishersByProduct = new Map<string, Map<string, { folder: string; count: number }>>()

  for (const order of orders) {
    const publisherFolder = inferPublisherFolder(order.bundleTitle)
    const publisherKey = normalizeFlatPublisherKey(publisherFolder)
    for (const product of order.products) {
      const productKey = normalizeFlatProductKey(product.productTitle)
      if (!productKey) {
        continue
      }
      const publishers = publishersByProduct.get(productKey) ?? new Map()
      const current = publishers.get(publisherKey) ?? { folder: publisherFolder, count: 0 }
      current.count += 1
      publishers.set(publisherKey, current)
      publishersByProduct.set(productKey, publishers)
    }
  }

  const selectedPublishers = new Map<string, string>()
  for (const [productKey, publishers] of publishersByProduct) {
    const ranked = [...publishers.entries()]
      .filter(([publisherKey]) => publisherKey !== 'humble')
      .sort((left, right) => right[1].count - left[1].count)
    selectedPublishers.set(productKey, ranked[0]?.[1].folder ?? 'humble')
  }

  return selectedPublishers
}

function flatPlannedFileKey(
  routedCandidate: RoutedDownloadCandidate,
  productTitle: string,
  filename: string
): string {
  return [
    routedCandidate.library.name ?? path.resolve(routedCandidate.library.path).toLowerCase(),
    normalizeFlatProductKey(productTitle),
    filename.toLowerCase(),
  ].join('\0')
}

function shouldReserveFlatPlannedFile(action: OrganizeAction): boolean {
  return action.status !== 'missing' && action.status !== 'conflict'
}

async function findExistingFlatSeriesFolder(
  libraryPath: string,
  publisherFolder: string,
  productTitle: string
): Promise<string | undefined> {
  const publisherPath = path.join(libraryPath, publisherFolder)
  const seriesKey = normalizeFlatPublisherKey(inferSeriesFolder(productTitle))
  try {
    const entries = await readdir(publisherPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .find((entryName) => normalizeFlatPublisherKey(entryName) === seriesKey)
  } catch {
    return undefined
  }
}

function getFlatSeriesFolderFromSource(
  libraryPath: string,
  publisherFolder: string,
  productTitle: string,
  sourcePath: string
): string | undefined {
  const publisherPath = path.join(libraryPath, publisherFolder)
  const relativePath = path.relative(publisherPath, sourcePath)
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined
  }
  const [seriesFolder] = relativePath.split(path.sep)
  if (!seriesFolder) {
    return undefined
  }
  return normalizeFlatPublisherKey(seriesFolder) ===
    normalizeFlatPublisherKey(inferSeriesFolder(productTitle))
    ? seriesFolder
    : undefined
}

async function planOrganizeAction({
  cacheKey,
  routedCandidate,
  bundleTitle,
  productTitle,
  selected,
  trackMissing,
  requireSameExtension,
  scanPaths,
  inferredBundleFolder,
  config,
  localDirectoryIndex,
  canonical,
  flat,
  publisherFolder,
  plannedMovesBySource,
  plannedDestinations,
}: {
  cacheKey: string
  routedCandidate: RoutedDownloadCandidate
  bundleTitle: string
  productTitle: string
  selected: boolean
  trackMissing: boolean
  requireSameExtension: boolean
  scanPaths: string[]
  inferredBundleFolder?: LocalDirectoryIndex['topLevelDirectories'][number]
  config: AppConfig
  localDirectoryIndex: LocalDirectoryIndex
  canonical: boolean
  flat: boolean
  publisherFolder?: string
  plannedMovesBySource: Map<string, string>
  plannedDestinations: Set<string>
}): Promise<OrganizeAction | undefined> {
  const { candidate, library } = routedCandidate
  const destinationLibrary = flat ? { ...library, layout: 'flat' as const } : library
  const sourcePath = await findAuditFile(
    await buildAuditCandidatePaths(
      scanPaths,
      bundleTitle,
      productTitle,
      inferredBundleFolder?.path,
      candidate.filename
    ),
    candidate.filename,
    config,
    localDirectoryIndex,
    inferredBundleFolder,
    routedCandidate.routing.fallback ? undefined : library,
    { allowEquivalentFormats: !requireSameExtension, allowGlobalAliasMatches: canonical }
  )

  if (
    requireSameExtension &&
    sourcePath &&
    getExtension(path.basename(sourcePath)) !== getExtension(candidate.filename)
  ) {
    return undefined
  }

  const sourceFilename = sourcePath ? path.basename(sourcePath) : undefined
  const stableSeriesFolder =
    flat && publisherFolder
      ? (sourcePath &&
          getFlatSeriesFolderFromSource(library.path, publisherFolder, productTitle, sourcePath)) ||
        (await findExistingFlatSeriesFolder(library.path, publisherFolder, productTitle))
      : undefined
  const productFolder = buildLibraryProductFolder(
    destinationLibrary,
    bundleTitle,
    productTitle,
    publisherFolder,
    stableSeriesFolder
  )
  const destinationFilename =
    (canonical || flat) &&
    sourceFilename &&
    !requireSameExtension &&
    sourceFilename.toLowerCase() !== candidate.filename.toLowerCase()
      ? sourceFilename
      : candidate.filename
  const destinationPath = path.join(productFolder, destinationFilename)

  const action: OrganizeAction = {
    cacheKey,
    filename: destinationFilename,
    bundleTitle,
    productTitle,
    expectedLibraryName: library.name,
    selected,
    sourcePath,
    destinationPath,
    status: 'missing',
  }

  if (!sourcePath) {
    if (!trackMissing) {
      return undefined
    }
    action.reason = 'Selected file was not found in configured scan roots.'
    return action
  }

  const normalizedSource = path.resolve(sourcePath).toLowerCase()
  const normalizedDestination = path.resolve(destinationPath).toLowerCase()
  if (flat && normalizedSource !== normalizedDestination && (await pathExists(destinationPath))) {
    action.status = 'already-correct'
    action.reason = 'Flat destination already satisfies this file.'
    plannedDestinations.add(normalizedDestination)
    return action
  }
  const plannedDestinationForSource = plannedMovesBySource.get(normalizedSource)
  if (plannedDestinationForSource === normalizedDestination) {
    return undefined
  }
  if (plannedDestinationForSource) {
    if (flat) {
      action.destinationPath = sourcePath
      action.status = 'already-correct'
      action.reason = 'Flat source already satisfies another duplicate candidate.'
      return action
    }
    action.status = 'conflict'
    action.reason = 'Source file is already planned for another candidate.'
    return action
  }
  if (normalizedSource === normalizedDestination && samePathExact(sourcePath, destinationPath)) {
    action.status = 'already-correct'
    plannedMovesBySource.set(normalizedSource, normalizedDestination)
    plannedDestinations.add(normalizedDestination)
    return action
  }
  if (canonical) {
    const sourceTopLevel = topLevelDirectoryName(library.path, sourcePath)
    const destinationTopLevel = topLevelDirectoryName(library.path, destinationPath)
    if (
      sourceTopLevel &&
      destinationTopLevel &&
      sourceTopLevel.toLowerCase() !== destinationTopLevel.toLowerCase() &&
      isHumbleBundleFolder(sourceTopLevel) &&
      isHumbleBundleFolder(destinationTopLevel)
    ) {
      action.status = 'conflict'
      action.reason = 'Source file is already inside another canonical Humble bundle folder.'
      return action
    }
  }
  if (!canonical && !flat && isPathInside(path.resolve(library.path), path.resolve(sourcePath))) {
    action.status = 'already-correct'
    action.reason = 'File is already inside the routed library.'
    return action
  }
  if (getExtension(path.basename(sourcePath)) !== getExtension(destinationFilename)) {
    action.status = 'conflict'
    action.reason =
      'Matched local file uses a different extension; organize will not rename formats.'
    return action
  }
  if (plannedDestinations.has(normalizedDestination)) {
    if (flat) {
      action.status = 'already-correct'
      action.reason = 'Flat destination is already planned by another duplicate candidate.'
      return action
    }
    action.status = 'conflict'
    action.reason = 'Destination file is already planned for another candidate.'
    return action
  }
  if (normalizedSource !== normalizedDestination && (await pathExists(destinationPath))) {
    action.status = 'conflict'
    action.reason = 'Destination file already exists.'
    return action
  }

  action.status = 'would-move'
  plannedMovesBySource.set(normalizedSource, normalizedDestination)
  plannedDestinations.add(normalizedDestination)
  return action
}

async function applyOrganizeActions(
  actions: OrganizeAction[],
  onProgress?: (message: string) => void
): Promise<void> {
  const moves = actions.filter((action) => action.status === 'would-move')
  let index = 0
  for (const action of moves) {
    index += 1
    if (!action.sourcePath) {
      action.status = 'conflict'
      action.reason = 'Move action is missing a source path.'
      continue
    }
    onProgress?.(`Moving ${index}/${moves.length}: ${action.filename}`)
    if (!(await pathExists(action.sourcePath))) {
      action.status = 'conflict'
      action.reason = 'Source file is missing.'
      continue
    }
    if (
      (await pathExists(action.destinationPath)) &&
      !samePath(action.sourcePath, action.destinationPath)
    ) {
      action.status = 'conflict'
      action.reason = 'Destination file already exists.'
      continue
    }
    try {
      await moveFile(action.sourcePath, action.destinationPath)
      action.status = 'moved'
    } catch (error) {
      action.status = 'conflict'
      action.reason = error instanceof Error ? error.message : String(error)
    }
  }
}

function getOrderIdFromCacheKey(cacheKey: string): string | undefined {
  const separatorIndex = cacheKey.indexOf(':')
  return separatorIndex === -1 ? undefined : cacheKey.slice(0, separatorIndex)
}

function getFlatPathParts(
  libraryPath: string,
  canonicalPath: string,
  bundleTitle: string,
  productTitle: string
): { publisher: string; series: string } {
  const relativePath = path.relative(libraryPath, canonicalPath)
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    const [publisher, series] = relativePath.split(path.sep)
    if (publisher && series) {
      return { publisher, series }
    }
  }
  return {
    publisher: inferPublisherFolder(bundleTitle),
    series: inferSeriesFolder(productTitle),
  }
}

async function recordFlatOrganizeCache({
  config,
  actions,
}: {
  config: AppConfig
  actions: OrganizeAction[]
}): Promise<void> {
  const cache = await loadCache(config.libraryPath, config.cachePath)
  const now = new Date().toUTCString()

  for (const action of actions) {
    if (action.status !== 'moved' && action.status !== 'already-correct') {
      continue
    }
    const library = config.scanLibraries.find(
      (scanLibrary) => scanLibrary.name === action.expectedLibraryName
    )
    if (!library) {
      continue
    }
    const flatLibrary = { ...library, layout: 'flat' as const }
    const flatCacheKey = buildFlatCacheKey(flatLibrary, action.productTitle, action.filename)
    if (!flatCacheKey) {
      continue
    }

    const cacheEntry = cache[action.cacheKey] ?? { urlLastModified: now }
    cache[action.cacheKey] = cacheEntry
    cache[flatCacheKey] = cacheEntry
    const flatPathParts = getFlatPathParts(
      library.path,
      action.destinationPath,
      action.bundleTitle,
      action.productTitle
    )
    const flatIndexEntry: Omit<FlatIndexEntry, 'bundleLocations'> & {
      bundleLocation: FlatIndexEntry['bundleLocations'][number]
    } = {
      flatCacheKey,
      canonicalPath: action.destinationPath,
      libraryName: library.name,
      libraryPath: library.path,
      publisher: flatPathParts.publisher,
      series: flatPathParts.series,
      productKey: normalizeFlatProductKey(action.productTitle),
      productTitle: action.productTitle,
      filename: action.filename,
      bundleLocation: {
        cacheKey: action.cacheKey,
        orderId: getOrderIdFromCacheKey(action.cacheKey),
        bundleTitle: action.bundleTitle,
        productTitle: action.productTitle,
        bundlePath: path.join(
          buildProductFolder(library.path, action.bundleTitle, action.productTitle),
          action.filename
        ),
      },
    }
    upsertFlatIndexEntry(cache, flatIndexEntry)
  }

  await saveCache(config.libraryPath, cache, config.cachePath)
}

export async function organizeLibrary({
  config,
  apply = false,
  canonical = false,
  flat = false,
  reportPath,
  onProgress,
}: OrganizeOptions): Promise<OrganizeReport> {
  if (flat && apply && !config.configPath) {
    throw new Error(
      'organize --flat --apply requires a loaded config file so libraries can be marked as flat.'
    )
  }

  onProgress?.('Loading metadata...')
  const metadata = await loadMetadata(config.libraryPath, config.metadataPath)
  const orders = Object.values(metadata.orders)
  if (orders.length === 0) {
    throw new Error('No metadata orders found. Run audit or download first.')
  }
  const flatPublisherFoldersByProduct = flat ? buildPublisherFoldersByProduct(orders) : new Map()

  const scanPaths = getScanPaths(config)
  onProgress?.('Indexing local files...')
  const localDirectoryIndex = await buildLocalDirectoryIndex(scanPaths)
  const actions: OrganizeAction[] = []
  const plannedMovesBySource = new Map<string, string>()
  const plannedDestinations = new Set<string>()
  const plannedFlatFiles = new Set<string>()
  let productsProcessed = 0
  let selectedCandidates = 0

  let orderIndex = 0
  for (const order of orders) {
    orderIndex += 1
    onProgress?.(`Planning order ${orderIndex}/${orders.length}...`)
    const expectedFilenames = new Set(
      order.products
        .flatMap((product) => product.downloads)
        .map((download) => download.filename.toLowerCase())
    )
    const inferredBundleFolder = inferBundleFolder(localDirectoryIndex, expectedFilenames)

    for (const product of order.products) {
      productsProcessed += 1
      const selected = selectRoutedDownloadCandidates(
        product.downloads.map((download) => metadataCandidate(download)),
        config,
        {
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
        }
      )
      selectedCandidates += selected.length

      for (const routedCandidate of selected) {
        const { candidate } = routedCandidate
        const flatKey = flatPlannedFileKey(
          routedCandidate,
          product.productTitle,
          candidate.filename
        )
        if (flat && plannedFlatFiles.has(flatKey)) {
          continue
        }
        const action = await planOrganizeAction({
          cacheKey: `${order.orderId}:${candidate.filename}`,
          routedCandidate,
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
          selected: true,
          trackMissing: true,
          requireSameExtension: false,
          scanPaths,
          inferredBundleFolder,
          config,
          localDirectoryIndex,
          canonical,
          flat,
          publisherFolder: flatPublisherFoldersByProduct.get(
            normalizeFlatProductKey(product.productTitle)
          ),
          plannedMovesBySource,
          plannedDestinations,
        })
        if (action) {
          actions.push(action)
          if (flat && shouldReserveFlatPlannedFile(action)) {
            plannedFlatFiles.add(flatKey)
          }
        }
      }

      const selectedCacheKeys = new Set(
        selected.map(({ candidate }) => `${order.orderId}:${candidate.filename.toLowerCase()}`)
      )
      for (const download of product.downloads) {
        const candidate = metadataCandidate(download)
        const cacheKey = `${order.orderId}:${candidate.filename.toLowerCase()}`
        if (selectedCacheKeys.has(cacheKey)) {
          continue
        }
        const [routedCandidate] = selectRoutedDownloadCandidates([candidate], config, {
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
        })
        if (!routedCandidate) {
          continue
        }
        const flatKey = flatPlannedFileKey(
          routedCandidate,
          product.productTitle,
          candidate.filename
        )
        if (flat && plannedFlatFiles.has(flatKey)) {
          continue
        }
        const action = await planOrganizeAction({
          cacheKey: `${order.orderId}:${candidate.filename}`,
          routedCandidate,
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
          selected: false,
          trackMissing: false,
          requireSameExtension: true,
          scanPaths,
          inferredBundleFolder,
          config,
          localDirectoryIndex,
          canonical,
          flat,
          publisherFolder: flatPublisherFoldersByProduct.get(
            normalizeFlatProductKey(product.productTitle)
          ),
          plannedMovesBySource,
          plannedDestinations,
        })
        if (action) {
          actions.push(action)
          if (flat && shouldReserveFlatPlannedFile(action)) {
            plannedFlatFiles.add(flatKey)
          }
        }
      }
    }
  }

  if (apply) {
    await applyOrganizeActions(actions, onProgress)
    if (flat && config.configPath) {
      await recordFlatOrganizeCache({ config, actions })
      await markConfigLibrariesFlat(config.configPath)
    }
  }

  const summary = summarizeActions(actions, {
    dryRun: !apply,
    ordersProcessed: orders.length,
    productsProcessed,
    selectedCandidates,
    reportPath,
  })
  const report: OrganizeReport = {
    ...summary,
    actions,
  }

  if (reportPath) {
    const reportDirectory = path.dirname(reportPath)
    if (reportDirectory && reportDirectory !== '.') {
      await mkdir(reportDirectory, { recursive: true })
    }
    await writeFile(reportPath, `${JSON.stringify(report, undefined, 2)}\n`)
  }

  return report
}
