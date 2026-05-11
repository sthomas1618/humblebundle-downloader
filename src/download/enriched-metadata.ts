import { open, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import yauzl from 'yauzl'

import type { AppConfig } from '../config'
import {
  cleanName,
  inferPublisherFolder,
  normalizeFlatPublisherKey,
  normalizeFlatProductKey,
  normalizePublisherFamilyKey,
} from '../utils/fs'
import { loadMetadata, type MetadataData } from './metadata'
import { getArchiveLibraryPath } from './downloader'

export type EnrichedMetadataSource = 'epub-opf' | 'pdf-info' | 'pdf-xmp'

export type EnrichedMetadataField = {
  value: string
  source: EnrichedMetadataSource
  confidence: number
  evidence: string[]
  rejectionReasons?: string[]
}

export type EnrichedMetadataFileSourceRole = 'library' | 'archive' | 'manual'

export type EnrichedMetadataFileSource = {
  role: EnrichedMetadataFileSourceRole
  root: string
  libraryName?: string
  libraryPath?: string
}

export type EnrichedMetadataMatch = {
  cacheKey: string
  orderId: string
  bundleTitle: string
  productTitle: string
  filename: string
}

export type EnrichedMetadataFile = {
  path: string
  source?: EnrichedMetadataFileSource
  extension: 'cbz' | 'epub' | 'pdf'
  status: 'extracted' | 'skipped' | 'error'
  matches: EnrichedMetadataMatch[]
  title?: EnrichedMetadataField
  publisher?: EnrichedMetadataField
  rawFields: Record<string, string | string[]>
  rejectedFields: Record<string, EnrichedMetadataField[]>
  error?: string
}

export type EnrichedMetadataProduct = {
  productKey: string
  productTitle: string
  publisher?: EnrichedMetadataField
  publisherConflicts?: EnrichedMetadataField[]
  files: string[]
  matches: EnrichedMetadataMatch[]
}

export type EnrichedMetadataData = {
  version: 1
  updatedAt: string
  summary: {
    scanned: number
    extracted: number
    skipped: number
    errors: number
    matchedFiles: number
    unmatchedFiles: number
  }
  files: EnrichedMetadataFile[]
  products: Record<string, EnrichedMetadataProduct>
}

export type EnrichMetadataOptions = {
  config: AppConfig
  outputPath?: string
  onProgress?: (message: string) => void
}

const ENRICHED_METADATA_FILE = '.enriched-metadata.json'
const SUPPORTED_EXTENSIONS = new Set(['.cbz', '.epub', '.pdf'])
const PUBLISHER_CONFIDENCE_THRESHOLD = 0.85
const PUBLISHER_CONFLICT_THRESHOLD = 0.75
const FILE_SOURCE_ROLE_PRIORITY: Record<EnrichedMetadataFileSourceRole, number> = {
  library: 0,
  archive: 1,
  manual: 2,
}

type EnrichedMetadataScanFile = {
  path: string
  source?: EnrichedMetadataFileSource
}

type EnrichedMetadataScanRoot = {
  path: string
  source?: EnrichedMetadataFileSource
}

export function resolveEnrichedMetadataPath(
  libraryPath: string,
  enrichedMetadataPath?: string
): string {
  return enrichedMetadataPath
    ? path.resolve(enrichedMetadataPath)
    : path.join(libraryPath, ENRICHED_METADATA_FILE)
}

export async function loadEnrichedMetadata(
  libraryPath: string,
  enrichedMetadataPath?: string
): Promise<EnrichedMetadataData | undefined> {
  try {
    const data = JSON.parse(
      await readFile(resolveEnrichedMetadataPath(libraryPath, enrichedMetadataPath), 'utf8')
    ) as Partial<EnrichedMetadataData>
    if (data.version !== 1 || !Array.isArray(data.files) || !data.products) {
      return undefined
    }
    return data as EnrichedMetadataData
  } catch {
    return undefined
  }
}

export async function saveEnrichedMetadata(
  libraryPath: string,
  metadata: EnrichedMetadataData,
  enrichedMetadataPath?: string
): Promise<string> {
  metadata.updatedAt = new Date().toISOString()
  const outputPath = resolveEnrichedMetadataPath(libraryPath, enrichedMetadataPath)
  const temporaryPath = `${outputPath}.tmp`
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(metadata, undefined, 2)}\n`)
  try {
    await rename(temporaryPath, outputPath)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      await writeFile(outputPath, `${JSON.stringify(metadata, undefined, 2)}\n`)
      await rm(temporaryPath, { force: true })
    } else {
      throw error
    }
  }
  return outputPath
}

export function getEnrichedPublisherForProduct(
  metadata: EnrichedMetadataData | undefined,
  productTitle: string
): string | undefined {
  const publisher = metadata?.products[normalizeFlatProductKey(productTitle)]?.publisher
  if (!publisher || publisher.confidence < PUBLISHER_CONFIDENCE_THRESHOLD) {
    return undefined
  }
  return cleanName(publisher.value) || undefined
}

export async function enrichMetadata({
  config,
  outputPath,
  onProgress,
}: EnrichMetadataOptions): Promise<{ metadata: EnrichedMetadataData; outputPath: string }> {
  onProgress?.('Loading Humble metadata...')
  const humbleMetadata = await loadMetadata(config.libraryPath, config.metadataPath)
  const matchesByFilename = buildMatchesByFilename(humbleMetadata)

  onProgress?.('Scanning local files...')
  const paths = await collectSupportedFiles(buildEnrichedScanRoots(config))
  const files: EnrichedMetadataFile[] = []
  let index = 0

  for (const file of paths) {
    index += 1
    if (index % 250 === 0) {
      onProgress?.(`Scanning file ${index}/${paths.length}...`)
    }
    files.push(
      await inspectFile(file, matchesByFilename.get(path.basename(file.path).toLowerCase()) ?? [])
    )
  }

  const metadata = buildEnrichedMetadata(files)
  const resolvedOutputPath = await saveEnrichedMetadata(
    config.libraryPath,
    metadata,
    outputPath ?? config.enrichedMetadataPath
  )
  return { metadata, outputPath: resolvedOutputPath }
}

function buildEnrichedScanRoots(config: AppConfig): EnrichedMetadataScanRoot[] {
  const roots: EnrichedMetadataScanRoot[] = []

  function addRoot(rootPath: string, source?: EnrichedMetadataFileSource): void {
    roots.push({
      path: rootPath,
      source: source ? { ...source, root: rootPath } : undefined,
    })
  }

  for (const library of config.scanLibraries) {
    const isManual =
      !library.name &&
      path.resolve(library.path).toLowerCase() !== path.resolve(config.libraryPath).toLowerCase()
    const source: EnrichedMetadataFileSource = {
      role: isManual ? 'manual' : 'library',
      root: library.path,
      ...(library.name ? { libraryName: library.name } : {}),
      libraryPath: library.path,
    }
    addRoot(library.path, source)

    if (!isManual && library.archiveFormats && library.archiveFormats.length > 0) {
      const archivePath = getArchiveLibraryPath(config, library)
      if (archivePath) {
        addRoot(archivePath, {
          role: 'archive',
          root: archivePath,
          ...(library.name ? { libraryName: library.name } : {}),
          libraryPath: library.path,
        })
      }
    }
  }

  return roots
}

function buildMatchesByFilename(metadata: MetadataData): Map<string, EnrichedMetadataMatch[]> {
  const matches = new Map<string, EnrichedMetadataMatch[]>()
  for (const order of Object.values(metadata.orders)) {
    for (const product of order.products) {
      for (const download of product.downloads) {
        const filename = download.filename.toLowerCase()
        const items = matches.get(filename) ?? []
        items.push({
          cacheKey: download.cacheKey,
          orderId: order.orderId,
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
          filename: download.filename,
        })
        matches.set(filename, items)
      }
    }
  }
  return matches
}

async function collectSupportedFiles(
  roots: EnrichedMetadataScanRoot[]
): Promise<EnrichedMetadataScanFile[]> {
  const files = new Map<string, EnrichedMetadataScanFile>()

  function addFile(file: EnrichedMetadataScanFile): void {
    const key = path.resolve(file.path).toLowerCase()
    const current = files.get(key)
    if (!current) {
      files.set(key, file)
      return
    }

    const currentPriority = current.source
      ? FILE_SOURCE_ROLE_PRIORITY[current.source.role]
      : Number.POSITIVE_INFINITY
    const nextPriority = file.source
      ? FILE_SOURCE_ROLE_PRIORITY[file.source.role]
      : Number.POSITIVE_INFINITY
    if (nextPriority < currentPriority) {
      files.set(key, file)
    }
  }

  async function visit(currentPath: string, source?: EnrichedMetadataFileSource): Promise<void> {
    let currentStat
    try {
      currentStat = await stat(currentPath)
    } catch {
      return
    }

    if (currentStat.isFile()) {
      if (SUPPORTED_EXTENSIONS.has(path.extname(currentPath).toLowerCase())) {
        addFile({ path: currentPath, source })
      }
      return
    }

    if (!currentStat.isDirectory()) {
      return
    }

    let entries
    try {
      entries = await readdir(currentPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      await visit(path.join(currentPath, entry.name), source)
    }
  }

  for (const root of roots) {
    await visit(root.path, root.source)
  }

  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
}

async function inspectFile(
  file: EnrichedMetadataScanFile,
  matches: EnrichedMetadataMatch[]
): Promise<EnrichedMetadataFile> {
  const filePath = file.path
  const extension = path.extname(filePath).slice(1).toLowerCase() as 'cbz' | 'epub' | 'pdf'
  const base = {
    path: filePath,
    ...(file.source ? { source: file.source } : {}),
    extension,
    matches,
    rawFields: {},
    rejectedFields: {},
  }

  try {
    if (extension === 'cbz') {
      return {
        ...base,
        status: 'skipped',
      }
    }

    const rawFields =
      extension === 'epub' ? await extractEpubFields(filePath) : await extractPdfFields(filePath)
    const publisher = buildPublisherField(rawFields, matches)
    const title = buildTitleField(rawFields)
    return {
      ...base,
      status: 'extracted',
      rawFields,
      ...(publisher.accepted ? { publisher: publisher.accepted } : {}),
      ...(title ? { title } : {}),
      rejectedFields: {
        ...(publisher.rejected.length > 0 ? { publisher: publisher.rejected } : {}),
      },
    }
  } catch (error) {
    return {
      ...base,
      status: 'error',
      error: formatError(error),
    }
  }
}

async function extractEpubFields(filePath: string): Promise<Record<string, string | string[]>> {
  const containerXml = await readZipEntryText(filePath, 'META-INF/container.xml')
  const rootfile = containerXml?.match(/full-path\s*=\s*"([^"]+)"/i)?.[1]
  const packageXml = rootfile ? await readZipEntryText(filePath, rootfile) : undefined
  if (!packageXml) {
    return {}
  }
  return extractXmlFields(packageXml, 'epub-opf')
}

async function extractPdfFields(filePath: string): Promise<Record<string, string | string[]>> {
  const sample = await readPdfMetadataSample(filePath)
  return {
    ...extractPdfInfoFields(sample.latin1),
    ...extractXmlFields(sample.utf8, 'pdf-xmp'),
  }
}

async function readPdfMetadataSample(filePath: string): Promise<{ latin1: string; utf8: string }> {
  const file = await open(filePath, 'r')
  try {
    const { size } = await file.stat()
    const headSize = Math.min(size, 1024 * 1024)
    const tailSize = Math.min(size, 4 * 1024 * 1024)
    const head = Buffer.alloc(headSize)
    const tail = Buffer.alloc(tailSize)

    if (headSize > 0) {
      await file.read(head, 0, headSize, 0)
    }
    if (tailSize > 0) {
      await file.read(tail, 0, tailSize, Math.max(0, size - tailSize))
    }

    const buffer = size <= headSize ? head : Buffer.concat([head, tail])
    return {
      latin1: buffer.toString('latin1'),
      utf8: buffer.toString('utf8'),
    }
  } finally {
    await file.close()
  }
}

function extractPdfInfoFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const key of [
    'Title',
    'Author',
    'Subject',
    'Creator',
    'Producer',
    'CreationDate',
    'ModDate',
  ]) {
    const value = text.match(new RegExp(`/${key}\\s*\\(([^)]*)\\)`, 'i'))?.[1]
    if (value) {
      fields[`pdf-info:${key}`] = cleanText(value)
    }
  }
  return fields
}

function extractXmlFields(
  xml: string,
  source: EnrichedMetadataSource
): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {}
  const prefix = source === 'epub-opf' ? 'epub' : 'xmp'
  for (const tag of [
    'dc:title',
    'dc:creator',
    'dc:publisher',
    'dc:language',
    'dc:identifier',
    'dc:date',
  ]) {
    const values = matchXmlTagValues(xml, tag)
    if (values.length === 1) {
      fields[`${prefix}:${tag}`] = values[0]
    } else if (values.length > 1) {
      fields[`${prefix}:${tag}`] = values
    }
  }
  return fields
}

function matchXmlTagValues(xml: string, tag: string): string[] {
  const pattern = new RegExp(
    `<${escapeRegExp(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`,
    'gi'
  )
  return [...xml.matchAll(pattern)].map((match) => cleanText(match[1])).filter(Boolean)
}

function buildPublisherField(
  rawFields: Record<string, string | string[]>,
  matches: EnrichedMetadataMatch[]
): { accepted?: EnrichedMetadataField; rejected: EnrichedMetadataField[] } {
  const candidates: EnrichedMetadataField[] = [
    ...fieldValues(rawFields['epub:dc:publisher']).map((value) => ({
      value: cleanPublisherText(value),
      source: 'epub-opf' as const,
      confidence: 0.85,
      evidence: ['epub:dc:publisher'],
    })),
    ...fieldValues(rawFields['xmp:dc:publisher']).map((value) => ({
      value: cleanPublisherText(value),
      source: 'pdf-xmp' as const,
      confidence: 0.75,
      evidence: ['xmp:dc:publisher'],
    })),
  ]
  const rejected: EnrichedMetadataField[] = []
  let accepted: EnrichedMetadataField | undefined

  for (const candidate of candidates) {
    const rejectionReasons = rejectPublisherValue(candidate.value)
    if (rejectionReasons.length > 0) {
      rejected.push({ ...candidate, rejectionReasons })
      continue
    }

    const boost = publisherAgreementBoost(candidate.value, matches)
    const boosted = {
      ...candidate,
      value: cleanName(candidate.value),
      confidence: Math.min(1, candidate.confidence + boost),
      evidence:
        boost > 0 ? [...candidate.evidence, 'matches-bundle-publisher'] : candidate.evidence,
    }
    if (!accepted || boosted.confidence > accepted.confidence) {
      accepted = boosted
    }
  }

  return { accepted, rejected }
}

function buildTitleField(
  rawFields: Record<string, string | string[]>
): EnrichedMetadataField | undefined {
  const title =
    fieldValues(rawFields['epub:dc:title'])[0] ?? fieldValues(rawFields['xmp:dc:title'])[0]
  if (!title) {
    return undefined
  }
  return {
    value: title,
    source: rawFields['epub:dc:title'] ? 'epub-opf' : 'pdf-xmp',
    confidence: 0.75,
    evidence: [rawFields['epub:dc:title'] ? 'epub:dc:title' : 'xmp:dc:title'],
  }
}

function publisherAgreementBoost(value: string, matches: EnrichedMetadataMatch[]): number {
  const candidateKey = normalizePublisherFamilyKey(value)
  if (!candidateKey) {
    return 0
  }
  return matches.some(
    (match) => normalizePublisherFamilyKey(inferPublisherFolder(match.bundleTitle)) === candidateKey
  )
    ? 0.1
    : 0
}

function rejectPublisherValue(value: string): string[] {
  const reasons: string[] = []
  const normalized = value.trim()
  const key = normalized.toLowerCase()
  const printable = [...normalized].filter((char) => !isControlCharacter(char)).length

  if (!normalized) {
    reasons.push('empty')
  }
  if (normalized.length > 100) {
    reasons.push('too-long')
  }
  if (printable / Math.max(1, normalized.length) < 0.9) {
    reasons.push('low-printable-ratio')
  }
  if ([...normalized].some((char) => isControlCharacter(char) || char === '\uFFFD')) {
    reasons.push('control-or-replacement-character')
  }
  if (isPathOrUrlLike(normalized) || /\.(?:pdf|epub|cbz)$/i.test(normalized)) {
    reasons.push('path-or-url')
  }
  if (/^[\W\d_]+$/.test(normalized)) {
    reasons.push('mostly-punctuation-or-numeric')
  }
  if (
    /\b(?:untitled|cover|administrator|acrobat|distiller|pdflib|pdffactory|fineprint|canon|creator|producer|team ling)\b/i.test(
      key
    )
  ) {
    reasons.push('known-junk-value')
  }
  if (key === 'publisher') {
    reasons.push('generic-placeholder')
  }
  if (/\bis\b/i.test(normalized)) {
    reasons.push('sentence-fragment')
  }
  if (isLikelyPersonName(normalized)) {
    reasons.push('person-name')
  }

  return reasons
}

function isLikelyPersonName(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean)
  if (words.length !== 2) {
    return false
  }
  if (hasPublisherOrganizationSignal(value)) {
    return false
  }
  if (words.some((word) => word.length <= 1 || !/^[A-Z][a-z]+$/.test(word))) {
    return false
  }
  if ((words[1]?.length ?? 0) >= 9) {
    return false
  }
  return true
}

function hasPublisherOrganizationSignal(value: string): boolean {
  return /\b(?:book|books|comic|comics|company|corp|corporation|digital|edition|editions|entertainment|forge|group|house|image|imprint|inc|incorporated|international|llc|ltd|media|noterie|press|production|productions|publisher|publishers|publishing|studio|studios|works)\b/i.test(
    value
  )
}

function isControlCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code >= 0 && code <= 31) || (code >= 127 && code <= 159)
}

function isPathOrUrlLike(value: string): boolean {
  const lower = value.toLowerCase()
  return (
    lower.startsWith('file:') ||
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    (/^[a-z]$/i.test(value[0] ?? '') && value[1] === ':' && (value[2] === '\\' || value[2] === '/'))
  )
}

function buildEnrichedMetadata(files: EnrichedMetadataFile[]): EnrichedMetadataData {
  const publisherCanonicalValues = buildPublisherCanonicalValues(files)
  const productCandidates = new Map<
    string,
    {
      productTitle: string
      files: Set<string>
      matches: EnrichedMetadataMatch[]
      publishers: EnrichedMetadataField[]
    }
  >()

  for (const file of files) {
    if (!file.publisher || file.matches.length === 0) {
      continue
    }
    for (const match of file.matches) {
      const productKey = normalizeFlatProductKey(match.productTitle)
      const product = productCandidates.get(productKey) ?? {
        productTitle: match.productTitle,
        files: new Set<string>(),
        matches: [],
        publishers: [],
      }
      product.files.add(file.path)
      product.matches.push(match)
      product.publishers.push(canonicalizePublisherField(file.publisher, publisherCanonicalValues))
      productCandidates.set(productKey, product)
    }
  }

  const products: Record<string, EnrichedMetadataProduct> = {}
  for (const [productKey, product] of productCandidates) {
    const publisherSelection = chooseProductPublisher(product.publishers)
    products[productKey] = {
      productKey,
      productTitle: product.productTitle,
      files: [...product.files].sort((left, right) => left.localeCompare(right)),
      matches: product.matches,
      ...(publisherSelection.publisher ? { publisher: publisherSelection.publisher } : {}),
      ...(publisherSelection.conflicts.length > 0
        ? { publisherConflicts: publisherSelection.conflicts }
        : {}),
    }
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    summary: {
      scanned: files.length,
      extracted: files.filter((file) => file.status === 'extracted').length,
      skipped: files.filter((file) => file.status === 'skipped').length,
      errors: files.filter((file) => file.status === 'error').length,
      matchedFiles: files.filter((file) => file.matches.length > 0).length,
      unmatchedFiles: files.filter((file) => file.matches.length === 0).length,
    },
    files,
    products,
  }
}

function buildPublisherCanonicalValues(files: EnrichedMetadataFile[]): Map<string, string> {
  const counts = new Map<string, { value: string; count: number }>()
  for (const file of files) {
    if (!file.publisher) {
      continue
    }
    const key = normalizeComparablePublisher(file.publisher.value)
    const current = counts.get(key) ?? { value: file.publisher.value, count: 0 }
    current.count += 1
    counts.set(key, current)
  }

  const ranked = [...counts.entries()].sort(([, left], [, right]) => right.count - left.count)
  const canonical = new Map<string, string>()
  for (const [key, candidate] of ranked) {
    for (const [canonicalKey, canonicalCandidate] of ranked) {
      if (key === canonicalKey || canonicalCandidate.count < 3) {
        continue
      }
      if (canonicalCandidate.count <= candidate.count) {
        continue
      }
      if (normalizedEditDistance(key, canonicalKey) <= 0.16) {
        canonical.set(key, canonicalCandidate.value)
        break
      }
    }
  }
  return canonical
}

function canonicalizePublisherField(
  field: EnrichedMetadataField,
  canonicalValues: Map<string, string>
): EnrichedMetadataField {
  const canonicalValue = canonicalValues.get(normalizeComparablePublisher(field.value))
  if (
    !canonicalValue ||
    normalizeComparablePublisher(canonicalValue) === normalizeComparablePublisher(field.value)
  ) {
    return field
  }
  return {
    ...field,
    value: canonicalValue,
    confidence: Math.min(1, field.confidence + 0.05),
    evidence: [...field.evidence, 'publisher-spelling-canonicalized'],
  }
}

function chooseProductPublisher(fields: EnrichedMetadataField[]): {
  publisher?: EnrichedMetadataField
  conflicts: EnrichedMetadataField[]
} {
  const byKey = new Map<string, EnrichedMetadataField[]>()
  for (const field of fields) {
    const key = normalizePublisherFamilyKey(field.value)
    byKey.set(key, [...(byKey.get(key) ?? []), field])
  }

  const ranked = [...byKey.values()]
    .map((group) => {
      const best = group.sort((left, right) => right.confidence - left.confidence)[0]
      return {
        ...best,
        confidence: Math.min(1, best.confidence + (group.length > 1 ? 0.1 : 0)),
        evidence: group.length > 1 ? [...best.evidence, 'multiple-files-agree'] : best.evidence,
      }
    })
    .sort((left, right) => right.confidence - left.confidence)

  const publisher = ranked[0]
  if (!publisher) {
    return { conflicts: [] }
  }
  const publisherKey = normalizePublisherFamilyKey(publisher.value)
  return {
    publisher,
    conflicts: ranked.filter(
      (field) =>
        field.confidence >= PUBLISHER_CONFLICT_THRESHOLD &&
        normalizePublisherFamilyKey(field.value) !== publisherKey
    ),
  }
}

function normalizeComparablePublisher(value: string): string {
  return normalizeFlatPublisherKey(value)
}

function normalizedEditDistance(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length)
  if (maxLength === 0) {
    return 0
  }
  return editDistance(left, right) / maxLength
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  const current = Array.from({ length: right.length + 1 }, () => 0)

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost
      )
    }
    for (const [index, value] of current.entries()) {
      previous[index] = value
    }
  }

  return previous[right.length]
}

async function readZipEntryText(zipPath: string, entryName: string): Promise<string | undefined> {
  const buffer = await readZipEntry(zipPath, entryName)
  return buffer?.toString('utf8')
}

async function readZipEntry(zipPath: string, entryName: string): Promise<Buffer | undefined> {
  return await new Promise<Buffer | undefined>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error ?? new Error(`Unable to open zip: ${zipPath}`))
        return
      }

      function close(): void {
        zipfile.close()
      }

      zipfile.on('error', (zipError) => {
        close()
        reject(zipError)
      })
      zipfile.on('end', () => {
        close()
        // eslint-disable-next-line unicorn/no-useless-undefined
        resolve(undefined)
      })
      zipfile.on('entry', (entry) => {
        if (entry.fileName.toLowerCase() !== entryName.toLowerCase()) {
          zipfile.readEntry()
          return
        }

        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            close()
            reject(streamError ?? new Error(`Unable to read zip entry: ${entryName}`))
            return
          }

          const chunks: Buffer[] = []
          stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          stream.on('error', (readError) => {
            close()
            reject(readError)
          })
          stream.on('end', () => {
            close()
            resolve(Buffer.concat(chunks))
          })
        })
      })

      zipfile.readEntry()
    })
  })
}

function fieldValues(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((item) => cleanText(item))
    .filter(Boolean)
}

function cleanText(value: string): string {
  return value
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&#39;', "'")
    .replaceAll(/&#x([\da-f]+);/gi, (_, codePoint: string) =>
      decodeNumericEntity(Number.parseInt(codePoint, 16))
    )
    .replaceAll(/&#(\d+);/g, (_, codePoint: string) =>
      decodeNumericEntity(Number.parseInt(codePoint, 10))
    )
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function cleanPublisherText(value: string): string {
  const cleaned = value
    .replaceAll(/[&+/]+/g, ' ')
    .replaceAll(
      /\b(Books?|Comics?|Group|Inc|LLC|Ltd|Media|Press|Publishers?|Publishing)(?=[A-Z])/g,
      '$1 '
    )
    .replace(/^\s*published\s+by\s+/i, '')
    .replace(/^\s*(?:united\s+states|u\.?s\.?a?|usa|canada|uk|united\s+kingdom)\s+by\s+/i, '')
    .replace(/\s*[,-]?\s+(?:a\s+division|an\s+imprint|division|imprint)\s+of\b.+$/i, '')
    .replace(/^a\s+(.+?)\s+book$/i, '$1')
    .replaceAll(/\s+/g, ' ')
    .trim()
  return titleCaseAllCapsPublisher(cleaned)
}

function titleCaseAllCapsPublisher(value: string): string {
  if (!/[A-Z]/.test(value) || /[a-z]/.test(value)) {
    return value
  }
  return value
    .toLowerCase()
    .replaceAll(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .replaceAll(/\b(?:And|Of|The|By)\b/g, (word) => word.toLowerCase())
}

function decodeNumericEntity(codePoint: number): string {
  try {
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : ''
  } catch {
    return ''
  }
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
