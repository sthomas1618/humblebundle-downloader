import { createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

import type { ApiClient } from '../api/client'
import type { AppConfig, ScanLibraryConfig } from '../config'
import { buildFilenameAliases } from '../utils/filename'
import {
  buildLibraryProductFolder,
  buildProductFolder,
  buildTroveFolder,
  cleanName,
  findExistingPublisherFolders,
  inferPublisherFocusedFolder,
  inferPublisherFolder,
  inferSeriesFolder,
  normalizeFlatProductKey,
  normalizePublisherFamilyKey,
  resolvePublisherFolder,
  hasSimilarTitle,
} from '../utils/fs'
import {
  loadCache,
  saveCache,
  upsertFlatIndexEntry,
  type CacheData,
  type CacheEntry,
  type FlatIndexEntry,
} from './cache'
import {
  loadMetadata,
  resolveMetadataPath,
  saveMetadata,
  upsertOrderMetadata,
  type MetadataData,
  type MetadataOrder,
} from './metadata'

/**
 * Inputs required to orchestrate downloads for the Humble Bundle library.
 */
export type DownloadContext = {
  client: ApiClient
  config: AppConfig
  onProgress?: (message: string, options?: { newline?: boolean }) => void
}

export type DownloadItem = {
  url: string
  destination: string
  label?: string
  orderId?: string
  bundleTitle?: string
  productTitle?: string
  expectedSize?: number
  expectedMd5?: string
  cacheKey?: string
  additionalCacheKeys?: string[]
  flatIndexEntries?: Array<
    Omit<FlatIndexEntry, 'bundleLocations'> & {
      bundleLocation: FlatIndexEntry['bundleLocations'][number]
    }
  >
  cacheEntry?: CacheEntry
  cacheUpdate?: CacheEntry
}

export type DownloadResult = {
  item: DownloadItem
  bytesWritten: number
  attempts: number
  skipped?: boolean
  lastModified?: string
  error?: string
}

export type DownloadSummary = {
  purchaseKeys: number
  queued: number
  downloaded: number
  skipped: number
  locallySatisfied: number
  failed: number
  cacheEntries: number
  failureReportPath?: string
  metadataOrders: number
  metadataPath?: string
}

export type AuditSummary = {
  purchaseKeys: number
  ordersProcessed: number
  productsProcessed: number
  candidatesConsidered: number
  cacheEntries: number
  selectedCandidates: number
  matchedFiles: number
  metadataOrders: number
  metadataPath?: string
}

export type DownloadInspectionItem = {
  cacheKey: string
  flatCacheKey?: string
  filename: string
  platform: string
  url: string
  orderId: string
  bundleTitle: string
  productTitle: string
  expectedLibraryName?: string
  expectedLibraryPath: string
  expectedDestination: string
  expectedSize?: number
  expectedMd5?: string
  localPath?: string
  cacheEntry?: CacheEntry
  routing: CandidateRoutingDecision
}

export type DownloadInspection = {
  purchaseKeys: number
  ordersProcessed: number
  productsProcessed: number
  candidates: DownloadInspectionItem[]
}

export type RouteSignal = 'extension' | 'platform' | 'bundleTitle' | 'productTitle' | 'filename'

export type MediaKind = 'books' | 'comics' | 'manga'

export type MediaScore = Record<MediaKind, number>

export type MediaClassification = {
  selected?: MediaKind
  scores: MediaScore
  signals: string[]
  publisher?: {
    folder: string
    scores: MediaScore
  }
}

export type CandidateRouteMatch = {
  routeId: string
  library: string
  tier: number
  specificity: number
  signals: RouteSignal[]
}

export type CandidateRoutingDecision = {
  libraryName?: string
  libraryPath: string
  tier: number
  specificity: number
  firstRouteIndex: number
  fallback: boolean
  ambiguous: boolean
  matchedRoutes: CandidateRouteMatch[]
  mediaClassification?: MediaClassification
}

export type WebDownloadCandidate = {
  filename: string
  platform: string
  url: string
  fileSize?: number
  md5?: string
}

export type RoutedDownloadCandidate = {
  candidate: WebDownloadCandidate
  library: ScanLibraryConfig
  routing: CandidateRoutingDecision
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function reportProgress(label: string, transferred: number, total?: number): void {
  if (typeof total === 'number' && total > 0) {
    const barWidth = 50
    const done = Math.min(barWidth, Math.floor((transferred / total) * barWidth))
    const percent = Math.min(100, Math.round((done / barWidth) * 100))
    const filler = '='.repeat(Math.max(0, done))
    const space = ' '.repeat(Math.max(0, barWidth - done))
    process.stdout.write(`\r${label} ${percent}% [${filler}${space}]`)
  } else {
    process.stdout.write(`\r${label} ${transferred}`)
  }
}

async function downloadToFile(
  item: DownloadItem,
  showProgress: boolean
): Promise<{ bytesWritten: number; skipped?: boolean; lastModified?: string }> {
  const response = await fetch(item.url)
  if (!response.ok) {
    throw new Error(`Failed to download ${item.url}: ${response.status}`)
  }

  const total = response.headers.get('content-length')
  const totalBytes = total ? Number.parseInt(total, 10) : undefined
  const lastModified = response.headers.get('last-modified') ?? undefined
  if (lastModified && item.cacheEntry?.urlLastModified === lastModified) {
    return { bytesWritten: 0, skipped: true, lastModified }
  }

  const expectedBytes = item.expectedSize ?? totalBytes
  const label = item.label ?? item.destination
  const hash = item.expectedMd5 ? createHash('md5') : undefined
  const temporaryDestination = `${item.destination}.part`

  let written = 0
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error(`No response body for ${item.url}`)
  }

  let completed = false
  try {
    await mkdir(path.dirname(item.destination), { recursive: true })
    const output = createWriteStream(temporaryDestination)

    let isReading = true
    while (isReading) {
      const { done, value } = await reader.read()
      if (done) {
        isReading = false
        continue
      }

      if (value) {
        written += value.length
        if (hash) {
          hash.update(value)
        }
        output.write(Buffer.from(value))
        if (showProgress) {
          reportProgress(label, written, totalBytes)
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      output.end(() => resolve())
      output.on('error', reject)
    })

    if (showProgress) {
      process.stdout.write('\n')
    }

    if (typeof expectedBytes === 'number' && written < expectedBytes) {
      throw new Error(`Incomplete download for ${item.url}: ${written}/${expectedBytes} bytes`)
    }

    if (hash) {
      const digest = hash.digest('hex')
      if (digest !== item.expectedMd5) {
        throw new Error(`MD5 mismatch for ${item.url}: expected ${item.expectedMd5}, got ${digest}`)
      }
    }

    await rename(temporaryDestination, item.destination)
    completed = true

    return { bytesWritten: written, lastModified }
  } finally {
    if (!completed) {
      await rm(temporaryDestination, { force: true })
    }
  }
}

async function downloadWithRetry(
  item: DownloadItem,
  showProgress: boolean,
  maxAttempts = 3,
  baseDelayMs = 1000
): Promise<DownloadResult> {
  let attempt = 0

  while (attempt < maxAttempts) {
    attempt += 1
    try {
      const outcome = await downloadToFile(item, showProgress)
      return {
        item,
        bytesWritten: outcome.bytesWritten,
        attempts: attempt,
        skipped: outcome.skipped,
        lastModified: outcome.lastModified,
      }
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error
      }
      const delay = baseDelayMs * attempt
      await sleep(delay)
    }
  }

  return { item, bytesWritten: 0, attempts: attempt }
}

export function shouldDownloadPlatform(
  platform: string,
  config: Pick<AppConfig | ScanLibraryConfig, 'platformInclude'>
): boolean {
  if (!config.platformInclude || config.platformInclude.length === 0) {
    return true
  }
  const normalized = new Set(config.platformInclude.map((value) => value.toLowerCase()))
  if (normalized.has('all')) {
    return true
  }
  return normalized.has(platform.toLowerCase())
}

export function shouldDownloadExtension(
  filename: string,
  config: Pick<AppConfig | ScanLibraryConfig, 'extInclude' | 'extExclude'>
): boolean {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  if (config.extInclude && config.extInclude.length > 0) {
    const normalizedInclude = new Set(config.extInclude.map((value) => value.toLowerCase()))
    return normalizedInclude.has(extension)
  }
  if (config.extExclude && config.extExclude.length > 0) {
    const normalizedExclude = new Set(config.extExclude.map((value) => value.toLowerCase()))
    return !normalizedExclude.has(extension)
  }
  return true
}

function getExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? ''
}

function flatCacheLibraryKey(library: ScanLibraryConfig): string {
  return encodeURIComponent(library.name ?? library.path)
}

export function buildFlatCacheKey(
  library: ScanLibraryConfig,
  productTitle: string,
  filename: string
): string | undefined {
  if (library.layout !== 'flat') {
    return undefined
  }
  const productKey = normalizeFlatProductKey(productTitle).replaceAll(' ', '_')
  if (!productKey) {
    return undefined
  }
  return `flat:${flatCacheLibraryKey(library)}:${productKey}:${filename.toLowerCase()}`
}

function cacheDataEntryCount(cache: CacheData): number {
  return Object.keys(cache).filter((key) => key !== 'transforms' && key !== 'flatIndex').length
}

function getOrderIdFromCacheKey(cacheKey: string): string | undefined {
  const separatorIndex = cacheKey.indexOf(':')
  return separatorIndex === -1 ? undefined : cacheKey.slice(0, separatorIndex)
}

function getFlatPathParts(
  libraryPath: string,
  canonicalPath: string
): { publisher?: string; series?: string } {
  const relativePath = path.relative(libraryPath, canonicalPath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return {}
  }
  const [publisher, series] = relativePath.split(path.sep)
  return { publisher, series }
}

function buildFlatIndexUpdate({
  flatCacheKey,
  library,
  bundleTitle,
  productTitle,
  filename,
  cacheKey,
  canonicalPath,
}: {
  flatCacheKey: string
  library: ScanLibraryConfig
  bundleTitle: string
  productTitle: string
  filename: string
  cacheKey: string
  canonicalPath: string
}): Omit<FlatIndexEntry, 'bundleLocations'> & {
  bundleLocation: FlatIndexEntry['bundleLocations'][number]
} {
  const flatPathParts = getFlatPathParts(library.path, canonicalPath)
  return {
    flatCacheKey,
    canonicalPath,
    libraryName: library.name,
    libraryPath: library.path,
    publisher: flatPathParts.publisher ?? inferPublisherFolder(bundleTitle),
    series: flatPathParts.series ?? inferSeriesFolder(productTitle),
    productKey: normalizeFlatProductKey(productTitle),
    productTitle,
    filename,
    bundleLocation: {
      cacheKey,
      orderId: getOrderIdFromCacheKey(cacheKey),
      bundleTitle,
      productTitle,
      bundlePath: path.join(buildProductFolder(library.path, bundleTitle, productTitle), filename),
    },
  }
}

export function selectPreferredDownloadCandidates<T extends { filename: string }>(
  candidates: T[],
  config: Pick<AppConfig | ScanLibraryConfig, 'formatPriority'>
): T[] {
  const priority = config.formatPriority ?? []
  if (priority.length === 0 || candidates.length === 0) {
    return candidates
  }

  const available = new Map<string, T[]>()
  for (const candidate of candidates) {
    const extension = getExtension(candidate.filename)
    const bucket = available.get(extension)
    if (bucket) {
      bucket.push(candidate)
    } else {
      available.set(extension, [candidate])
    }
  }

  for (const preferred of priority) {
    const bucket = available.get(preferred)
    if (bucket && bucket.length > 0) {
      return bucket
    }
  }

  return candidates
}

function getActiveDestinationLibrary(config: AppConfig): ScanLibraryConfig {
  const configuredLibrary = config.libraryName
    ? config.scanLibraries.find((library) => library.name === config.libraryName)
    : undefined

  return (
    configuredLibrary ?? {
      name: config.libraryName,
      path: config.libraryPath,
      platformInclude: config.platformInclude,
      extInclude: config.extInclude,
      extExclude: config.extExclude,
      formatPriority: config.formatPriority,
      troveOnly: config.troveOnly,
      showProgress: config.showProgress,
    }
  )
}

function getConfiguredLibrary(config: AppConfig, name: string): ScanLibraryConfig | undefined {
  return config.scanLibraries.find((library) => library.name === name)
}

type CandidateRouteContext = {
  bundleTitle: string
  productTitle: string
  publisherMediaScores?: Map<string, MediaScore>
}

const mediaKinds: MediaKind[] = ['books', 'comics', 'manga']

function emptyMediaScore(): MediaScore {
  return {
    books: 0,
    comics: 0,
    manga: 0,
  }
}

function addMediaScore(
  scores: MediaScore,
  signals: string[],
  media: MediaKind,
  value: number,
  signal: string
): void {
  scores[media] += value
  signals.push(`${media}:${signal}:${value}`)
}

function textMatches(value: string, pattern: RegExp): boolean {
  return pattern.test(value)
}

function normalizedRouteText(value: string): string {
  return value.replaceAll(/[._-]+/g, ' ').toLowerCase()
}

function isInstructionalArtText(value: string): boolean {
  return textMatches(
    value,
    /\b(?:drawing|how to draw|art of drawing|art class|cartooning|animation|characters?|guide|workshop|lab)\b/i
  )
}

export function publisherMediaScoreKey(bundleTitle: string): string {
  return normalizePublisherFamilyKey(
    inferPublisherFocusedFolder(bundleTitle) ?? inferPublisherFolder(bundleTitle)
  )
}

function classifyMedia(
  candidate: WebDownloadCandidate,
  context: CandidateRouteContext
): MediaClassification {
  const scores = emptyMediaScore()
  const signals: string[] = []
  const bundleTitle = normalizedRouteText(context.bundleTitle)
  const productTitle = normalizedRouteText(context.productTitle)
  const filename = normalizedRouteText(candidate.filename)
  const combinedProductText = `${productTitle} ${filename}`
  const extension = getExtension(candidate.filename)
  const publisherFolder = inferPublisherFolder(context.bundleTitle)
  const publisherScoreKey = publisherMediaScoreKey(context.bundleTitle)

  if (/\bmanga\s+bundle\b/i.test(bundleTitle)) {
    addMediaScore(scores, signals, 'manga', 16, 'manga-bundle')
  }
  if (/\bcomics?\s+bundle\b/i.test(bundleTitle)) {
    addMediaScore(scores, signals, 'comics', 12, 'comic-bundle')
  }
  if (/\bgames?\s+(?:&|and)\s+comics?\s+crossover\s+collection\b/i.test(bundleTitle)) {
    addMediaScore(scores, signals, 'comics', 12, 'games-comics-crossover')
  }
  if (/\b(?:book bundle|ebooks?|e-books?|novels?|writing bundle|nanowrimo)\b/i.test(bundleTitle)) {
    addMediaScore(scores, signals, 'books', 12, 'book-bundle')
  }

  const instructionalArt = isInstructionalArtText(combinedProductText)
  if (instructionalArt) {
    addMediaScore(scores, signals, 'books', 8, 'instructional-art')
  }

  if (extension === 'cbz') {
    addMediaScore(scores, signals, 'comics', 10, 'cbz-format')
  } else if (extension === 'epub' || extension === 'mobi') {
    addMediaScore(scores, signals, 'books', 1, `${extension}-format`)
  }

  if (/\b(?:issues?|vol(?:ume)?|chapters?|omnibus|collection)\b/i.test(combinedProductText)) {
    addMediaScore(scores, signals, 'comics', 5, 'serialized-comic-work')
  }
  if (/\bone[\s-]?shot\b/i.test(combinedProductText)) {
    addMediaScore(scores, signals, 'comics', 8, 'one-shot')
  }
  if (/\bgraphic novel (?:adaptation|adaption)\b/i.test(combinedProductText)) {
    addMediaScore(scores, signals, 'comics', 16, 'graphic-novel-adaptation')
  } else if (/\bgraphic novel\b/i.test(combinedProductText)) {
    addMediaScore(scores, signals, 'comics', 14, 'graphic-novel')
  }
  if (/\bcomic book\b/i.test(combinedProductText)) {
    addMediaScore(
      scores,
      signals,
      instructionalArt ? 'books' : 'comics',
      instructionalArt ? 4 : 5,
      instructionalArt ? 'instructional-comic-book' : 'comic-book'
    )
  } else if (/\bcomics?\b/i.test(combinedProductText)) {
    addMediaScore(
      scores,
      signals,
      instructionalArt ? 'books' : 'comics',
      instructionalArt ? 3 : 4,
      instructionalArt ? 'instructional-comics' : 'comic-product'
    )
  }
  if (/\bmanga\b/i.test(combinedProductText)) {
    addMediaScore(
      scores,
      signals,
      instructionalArt ? 'books' : 'manga',
      instructionalArt ? 3 : 16,
      instructionalArt ? 'instructional-manga' : 'manga-product'
    )
  }
  if (/\b(?:cookbook|guide|reference|manual|handbook)\b/i.test(combinedProductText)) {
    addMediaScore(scores, signals, 'books', 16, 'reference-book-product')
  }
  if (/\b(?:book|guide|author|reference)\b/i.test(combinedProductText)) {
    addMediaScore(scores, signals, 'books', 2, 'bookish-product')
  } else if (
    /\bnovel\b/i.test(combinedProductText) &&
    !/\bgraphic novel\b/i.test(combinedProductText)
  ) {
    addMediaScore(scores, signals, 'books', 2, 'bookish-product')
  }
  if (/\bebook\b/i.test(filename)) {
    addMediaScore(scores, signals, 'books', 1, 'ebook-filename-format')
  }

  const publisherScores = context.publisherMediaScores?.get(publisherScoreKey)
  if (publisherScores) {
    const rankedPublisherScores = mediaKinds
      .map((media) => ({ media, score: publisherScores[media] }))
      .sort((left, right) => right.score - left.score)
    const dominantPublisherMedia =
      rankedPublisherScores[0] &&
      rankedPublisherScores[0].score > 0 &&
      rankedPublisherScores[0].score > (rankedPublisherScores[1]?.score ?? 0)
        ? rankedPublisherScores[0].media
        : undefined
    if (dominantPublisherMedia) {
      const publisherFocused = inferPublisherFocusedFolder(context.bundleTitle) !== undefined
      addMediaScore(
        scores,
        signals,
        dominantPublisherMedia,
        publisherFocused ? 8 : 2,
        publisherFocused ? 'publisher-focused-tendency' : 'publisher-tendency'
      )
    }
  }

  const ranked = mediaKinds
    .map((media) => ({ media, score: scores[media] }))
    .sort((left, right) => right.score - left.score)
  const selected =
    ranked[0] && ranked[0].score > 0 && ranked[0].score > (ranked[1]?.score ?? 0)
      ? ranked[0].media
      : undefined

  return {
    selected,
    scores,
    signals,
    publisher: publisherScores
      ? {
          folder: publisherFolder,
          scores: publisherScores,
        }
      : undefined,
  }
}

function scoreMetadataDownloadMedia(
  order: Pick<MetadataOrder, 'bundleTitle' | 'products'>
): MediaScore {
  const scores = emptyMediaScore()
  for (const product of order.products) {
    for (const download of product.downloads) {
      const classification = classifyMedia(
        {
          filename: download.filename,
          platform: download.platform,
          url: '',
        },
        {
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
        }
      )
      for (const media of mediaKinds) {
        scores[media] += classification.scores[media]
      }
    }
  }
  return scores
}

export function buildPublisherMediaScores(
  orders: Array<Pick<MetadataOrder, 'bundleTitle' | 'products'>>
): Map<string, MediaScore> {
  const scoresByPublisher = new Map<string, MediaScore>()
  for (const order of orders) {
    const publisherKey = publisherMediaScoreKey(order.bundleTitle)
    const scores = scoresByPublisher.get(publisherKey) ?? emptyMediaScore()
    const orderScores = scoreMetadataDownloadMedia(order)
    for (const media of mediaKinds) {
      scores[media] += orderScores[media]
    }
    scoresByPublisher.set(publisherKey, scores)
  }
  return scoresByPublisher
}

function getLibraryMedia(library: ScanLibraryConfig): MediaKind | undefined {
  const value = `${library.name ?? ''} ${library.path}`.toLowerCase()
  if (/\bmanga\b/.test(value) || /(?:^|[/\\])manga(?:[/\\]|$)/.test(value)) {
    return 'manga'
  }
  if (/\bcomics?\b/.test(value) || /(?:^|[/\\])comics?(?:[/\\]|$)/.test(value)) {
    return 'comics'
  }
  if (/\bbooks?\b/.test(value) || /(?:^|[/\\])books?(?:[/\\]|$)/.test(value)) {
    return 'books'
  }
  return undefined
}

const routeSignalTiers: Record<RouteSignal, number> = {
  extension: 1,
  platform: 1,
  bundleTitle: 1,
  productTitle: 2,
  filename: 2,
}

const routeSignalSpecificity: Record<RouteSignal, number> = {
  extension: 1,
  platform: 0,
  bundleTitle: 2,
  productTitle: 4,
  filename: 3,
}

function getRouteId(index: number, library: string): string {
  return `route-${index + 1}-${library}`
}

function routeTextVariants(value: string): string[] {
  return [value, value.replaceAll(/[._-]+/g, ' ')]
}

function routePatternsMatch(value: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) {
    return false
  }

  const variants = routeTextVariants(value)
  return patterns.some((pattern) => {
    const regex = new RegExp(pattern, 'i')
    return variants.some((variant) => regex.test(variant))
  })
}

function getMatchedRouteSignals(
  candidate: WebDownloadCandidate,
  context: CandidateRouteContext,
  route: AppConfig['routes'][number]
): RouteSignal[] {
  const signals: RouteSignal[] = []
  const extension = getExtension(candidate.filename)
  const platforms = new Set(route.platforms ?? [])

  if (route.extensions?.includes(extension)) {
    signals.push('extension')
  }
  if (platforms.has(candidate.platform.toLowerCase()) || platforms.has('all')) {
    signals.push('platform')
  }
  if (routePatternsMatch(context.bundleTitle, route.bundleTitlePatterns)) {
    signals.push('bundleTitle')
  }
  if (routePatternsMatch(context.productTitle, route.productTitlePatterns)) {
    signals.push('productTitle')
  }
  if (routePatternsMatch(candidate.filename, route.filenamePatterns)) {
    signals.push('filename')
  }

  return signals
}

function getRouteMatchTier(signals: RouteSignal[]): number {
  return Math.max(...signals.map((signal) => routeSignalTiers[signal]))
}

function getRouteMatchSpecificity(signals: RouteSignal[]): number {
  return Math.max(...signals.map((signal) => routeSignalSpecificity[signal]))
}

function mediaScoreFromSignal(signal: string, media: MediaKind): number {
  const prefix = `${media}:`
  if (!signal.startsWith(prefix)) {
    return 0
  }
  const score = Number(signal.slice(prefix.length).split(':').at(-1))
  return Number.isFinite(score) ? score : 0
}

function hasStrongClassifierRoutingSignal(classification: MediaClassification): boolean {
  const selected = classification.selected
  if (!selected) {
    return false
  }
  return classification.signals.some((signal) => {
    if (
      signal.includes(':publisher-tendency:') ||
      signal.includes('-bundle:') ||
      signal.includes(':games-comics-crossover:') ||
      signal.includes('-format:') ||
      signal.includes(':ebook-filename-format:')
    ) {
      return false
    }
    return mediaScoreFromSignal(signal, selected) >= 8
  })
}

function routeDownloadCandidate(
  candidate: WebDownloadCandidate,
  context: CandidateRouteContext,
  config: AppConfig
): { library: ScanLibraryConfig; routing: CandidateRoutingDecision } | undefined {
  const activeLibrary = getActiveDestinationLibrary(config)
  const mediaClassification = classifyMedia(candidate, context)
  const libraryMatches = new Map<
    string,
    {
      library: ScanLibraryConfig
      tier: number
      specificity: number
      firstRouteIndex: number
      matches: CandidateRouteMatch[]
    }
  >()

  for (const [index, route] of config.routes.entries()) {
    const library = getConfiguredLibrary(config, route.library)
    if (
      !library ||
      !shouldDownloadPlatform(candidate.platform, library) ||
      !shouldDownloadExtension(candidate.filename, library)
    ) {
      continue
    }

    const signals = getMatchedRouteSignals(candidate, context, route)
    if (signals.length === 0) {
      continue
    }

    const tier = getRouteMatchTier(signals)
    const specificity = getRouteMatchSpecificity(signals)
    const routeMatch: CandidateRouteMatch = {
      routeId: route.id ?? getRouteId(index, route.library),
      library: route.library,
      tier,
      specificity,
      signals,
    }
    const current = libraryMatches.get(route.library)
    if (!current) {
      libraryMatches.set(route.library, {
        library,
        tier,
        specificity,
        firstRouteIndex: index,
        matches: [routeMatch],
      })
      continue
    }

    current.matches.push(routeMatch)
    if (tier > current.tier) {
      current.tier = tier
      current.specificity = specificity
      current.firstRouteIndex = index
      continue
    }
    if (tier === current.tier) {
      if (specificity > current.specificity) {
        current.specificity = specificity
      }
      if (index < current.firstRouteIndex) {
        current.firstRouteIndex = index
      }
    }
  }

  if (
    mediaClassification.selected &&
    hasStrongClassifierRoutingSignal(mediaClassification) &&
    ![...libraryMatches.values()].some(
      (match) => getLibraryMedia(match.library) === mediaClassification.selected
    )
  ) {
    const classifiedLibrary = config.scanLibraries.find(
      (library) =>
        getLibraryMedia(library) === mediaClassification.selected &&
        shouldDownloadPlatform(candidate.platform, library) &&
        shouldDownloadExtension(candidate.filename, library)
    )
    if (classifiedLibrary) {
      libraryMatches.set(classifiedLibrary.name ?? classifiedLibrary.path, {
        library: classifiedLibrary,
        tier: 2,
        specificity: 5,
        firstRouteIndex: -1,
        matches: [
          {
            routeId: 'media-classification',
            library: classifiedLibrary.name ?? classifiedLibrary.path,
            tier: 2,
            specificity: 5,
            signals: [],
          },
        ],
      })
    }
  }

  if (libraryMatches.size === 0) {
    if (
      !shouldDownloadPlatform(candidate.platform, config) ||
      !shouldDownloadExtension(candidate.filename, config)
    ) {
      return undefined
    }
    return {
      library: activeLibrary,
      routing: {
        libraryName: activeLibrary.name,
        libraryPath: activeLibrary.path,
        tier: 0,
        specificity: -1,
        firstRouteIndex: Number.MAX_SAFE_INTEGER,
        fallback: true,
        ambiguous: false,
        matchedRoutes: [],
        mediaClassification,
      },
    }
  }

  const rankableMatches =
    mediaClassification.selected === undefined
      ? [...libraryMatches.values()]
      : [...libraryMatches.values()].filter(
          (match) => getLibraryMedia(match.library) === mediaClassification.selected
        )
  const rankedSource = rankableMatches.length > 0 ? rankableMatches : [...libraryMatches.values()]
  const ranked = rankedSource.sort((left, right) => {
    if (right.tier !== left.tier) {
      return right.tier - left.tier
    }
    if (left.firstRouteIndex !== right.firstRouteIndex) {
      return left.firstRouteIndex - right.firstRouteIndex
    }
    if (right.specificity !== left.specificity) {
      return right.specificity - left.specificity
    }
    return 0
  })
  const winner = ranked[0]
  if (!winner) {
    return undefined
  }
  const ambiguous = ranked.some(
    (candidateLibrary) =>
      candidateLibrary !== winner &&
      candidateLibrary.tier === winner.tier &&
      candidateLibrary.firstRouteIndex === winner.firstRouteIndex &&
      candidateLibrary.specificity === winner.specificity
  )

  return {
    library: winner.library,
    routing: {
      libraryName: winner.library.name,
      libraryPath: winner.library.path,
      tier: winner.tier,
      specificity: winner.specificity,
      firstRouteIndex: winner.firstRouteIndex,
      fallback: false,
      ambiguous,
      matchedRoutes: winner.matches,
      mediaClassification,
    },
  }
}

export function selectRoutedDownloadCandidates(
  candidates: WebDownloadCandidate[],
  config: AppConfig,
  context: CandidateRouteContext
): RoutedDownloadCandidate[] {
  const routedCandidates = candidates
    .map((candidate) => {
      const decision = routeDownloadCandidate(candidate, context, config)
      return decision ? { candidate, ...decision } : undefined
    })
    .filter((candidate): candidate is RoutedDownloadCandidate => candidate !== undefined)

  if (routedCandidates.length === 0) {
    return []
  }

  const bestTier = Math.max(...routedCandidates.map((candidate) => candidate.routing.tier))
  const bestCandidates = routedCandidates.filter((candidate) => candidate.routing.tier === bestTier)
  const selectedByLibrary = new Map<string, RoutedDownloadCandidate[]>()
  for (const routedCandidate of bestCandidates) {
    const key = routedCandidate.library.name ?? routedCandidate.library.path
    const matches = selectedByLibrary.get(key) ?? []
    matches.push(routedCandidate)
    selectedByLibrary.set(key, matches)
  }

  let selected: RoutedDownloadCandidate[] = []
  for (const matches of selectedByLibrary.values()) {
    const library = matches[0]?.library
    if (!library) {
      continue
    }
    const selectedCandidates = selectPreferredDownloadCandidates(
      matches.map((match) => match.candidate),
      library
    )
    selected.push(...matches.filter((match) => selectedCandidates.includes(match.candidate)))
  }

  const bestRouteIndex = Math.min(...selected.map((candidate) => candidate.routing.firstRouteIndex))
  selected = selected.filter((candidate) => candidate.routing.firstRouteIndex === bestRouteIndex)
  const firstSelected = selected[0]
  if (!firstSelected) {
    return []
  }

  const winnerKey = firstSelected.library.name ?? firstSelected.library.path
  return selected.filter(
    (candidate) => (candidate.library.name ?? candidate.library.path) === winnerKey
  )
}

function getFilenameFromUrl(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url
  const parts = withoutQuery.split('/')
  return parts.at(-1) ?? cleanName(url)
}

type AsmManifest = Record<string, string>

type DownloadFailureReport = {
  runStartedAt: string
  updatedAt: string
  libraryPath: string
  queued: number
  processed: number
  failed: number
  failures: Array<{
    label: string
    destination: string
    orderId?: string
    bundleTitle?: string
    productTitle?: string
    cacheKey?: string
    expectedSize?: number
    expectedMd5?: string
    attempts: number
    error: string
  }>
}

const DOWNLOAD_FAILURES_FILE = '.download-failures.json'
const METADATA_SAVE_INTERVAL = 25

function parseAsmPlayerData(html: string): AsmManifest | undefined {
  const match = html.match(/id=["']webpack-asm-player-data["'][^>]*>([^<]+)<\/[^>]+>/i)

  if (!match) {
    return undefined
  }

  try {
    const parsed = JSON.parse(match[1]) as {
      asmOptions?: { manifest?: Record<string, string> }
    }
    return parsed.asmOptions?.manifest
  } catch {
    return undefined
  }
}

async function writeLocalAsmHtml(
  localPath: string,
  html: string,
  manifest: AsmManifest
): Promise<void> {
  let output = html
  for (const [localFilename, remoteFile] of Object.entries(manifest)) {
    output = output.replaceAll(
      `"${localFilename}": "${remoteFile}"`,
      `"${localFilename}": "${localFilename}"`
    )
  }

  await writeFile(localPath, output)
}

export function formatExternalLinkMessage(
  bundleTitle: string,
  productTitle: string,
  url: string
): string {
  return `External link found: ${bundleTitle}/${productTitle} : ${url}`
}

export async function buildTroveDownloadItems(
  products: Awaited<ReturnType<ApiClient['getTroveProducts']>>,
  config: AppConfig,
  cache: Record<string, CacheEntry>,
  signDownload: ApiClient['signTroveDownload']
): Promise<DownloadItem[]> {
  const items: DownloadItem[] = []

  for (const product of products) {
    const title = cleanName(product['human-name'])
    const productFolder = buildTroveFolder(config.libraryPath, title)

    for (const [platform, download] of Object.entries(product.downloads)) {
      if (!shouldDownloadPlatform(platform, config)) {
        continue
      }

      const filename = getFilenameFromUrl(download.url.web)
      if (!shouldDownloadExtension(filename, config)) {
        continue
      }

      const cacheKey = `trove:${filename}`
      const cacheEntry = cache[cacheKey]
      const uploadedAt = download.uploaded_at ?? download.timestamp ?? product.date_added ?? '0'
      const md5 = download.md5 ?? 'UNKNOWN_MD5'
      if (cacheEntry && !config.updateOnly) {
        continue
      }
      if (
        cacheEntry &&
        config.updateOnly &&
        (cacheEntry.uploadedAt === uploadedAt || cacheEntry.md5 === md5)
      ) {
        continue
      }

      const sign = await signDownload(download.machine_name, filename)
      if (sign._errors === 'Unauthorized') {
        throw new Error('Your account does not have access to the Trove.')
      }
      if (!sign.signed_url) {
        continue
      }

      items.push({
        url: sign.signed_url,
        destination: path.join(productFolder, filename),
        label: filename,
        expectedMd5: md5,
        cacheKey,
        cacheEntry,
        cacheUpdate: {
          uploadedAt,
          md5,
        },
      })
    }
  }

  return items
}

export async function downloadQueue(
  items: DownloadItem[],
  showProgress: boolean,
  onResult?: (result: DownloadResult, index: number, total: number) => Promise<void> | void
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = []

  for (const item of items) {
    let result: DownloadResult
    try {
      result = await downloadWithRetry(item, showProgress)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result = {
        item,
        bytesWritten: 0,
        attempts: 3,
        error: message,
      }
    }
    results.push(result)
    await onResult?.(result, results.length, items.length)
  }

  return results
}

function emitProgress(onProgress: DownloadContext['onProgress'], message: string): void {
  onProgress?.(message, { newline: true })
}

function emitProgressChunk(onProgress: DownloadContext['onProgress'], message: string): void {
  onProgress?.(message, { newline: false })
}

async function writeJsonWithFallback(filePath: string, data: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp`
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(temporaryPath, JSON.stringify(data, undefined, 2))
  try {
    await rename(temporaryPath, filePath)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      await copyFile(temporaryPath, filePath)
      await rm(temporaryPath, { force: true })
      return
    }
    throw error
  }
}

function createFailureReport(libraryPath: string, queued: number): DownloadFailureReport {
  const now = new Date().toISOString()
  return {
    runStartedAt: now,
    updatedAt: now,
    libraryPath,
    queued,
    processed: 0,
    failed: 0,
    failures: [],
  }
}

async function saveFailureReport(reportPath: string, report: DownloadFailureReport): Promise<void> {
  report.updatedAt = new Date().toISOString()
  report.failed = report.failures.length
  await writeJsonWithFallback(reportPath, report)
}

function recordDownloadFailure(report: DownloadFailureReport, result: DownloadResult): void {
  report.failures.push({
    label: result.item.label ?? path.basename(result.item.destination),
    destination: result.item.destination,
    orderId: result.item.orderId,
    bundleTitle: result.item.bundleTitle,
    productTitle: result.item.productTitle,
    cacheKey: result.item.cacheKey,
    expectedSize: result.item.expectedSize,
    expectedMd5: result.item.expectedMd5,
    attempts: result.attempts,
    error: sanitizeDownloadError(result.error ?? 'unknown error'),
  })
}

function sanitizeDownloadError(error: string): string {
  return error.replaceAll(/https?:\/\/\S+/g, '[download URL]')
}

/**
 * Coordinate the download flow.
 *
 * This currently exercises the download queue and integrity checks while the
 * purchase/product orchestration is still being ported.
 */
export function parsePurchaseKeysFromLibraryPage(html: string): string[] {
  const match = html.match(/id=["']user-home-json-data["'][^>]*>([^<]+)<\/[^>]+>/i)

  if (!match) {
    return []
  }

  const jsonText = match[1]?.trim()
  if (!jsonText) {
    return []
  }

  try {
    const parsed = JSON.parse(jsonText) as { gamekeys?: string[] }
    return Array.isArray(parsed.gamekeys) ? parsed.gamekeys : []
  } catch {
    return []
  }
}

export async function downloadLibrary({
  client,
  config,
  onProgress,
}: DownloadContext): Promise<DownloadSummary> {
  const cache = await loadCache(config.libraryPath, config.cachePath)
  const metadata: MetadataData | undefined = config.troveOnly
    ? undefined
    : await loadMetadata(config.libraryPath, config.metadataPath)
  const metadataPath = metadata
    ? resolveMetadataPath(config.libraryPath, config.metadataPath)
    : undefined
  const publisherMediaScores = metadata
    ? buildPublisherMediaScores(Object.values(metadata.orders))
    : undefined
  const scanPaths = getScanPaths(config)
  emitProgress(onProgress, 'Indexing local files...')
  const localDirectoryIndex = await buildLocalDirectoryIndex(scanPaths)
  emitProgress(onProgress, 'Loading Humble library metadata...')
  const purchaseKeys =
    config.purchaseKeys && config.purchaseKeys.length > 0
      ? config.purchaseKeys
      : parsePurchaseKeysFromLibraryPage(await client.getLibraryPage())

  if (purchaseKeys.length === 0 && !config.troveOnly) {
    throw new Error('Unable to determine purchase keys from the library page.')
  }

  const items: DownloadItem[] = []
  const plannedFlatDownloadItems = new Map<string, DownloadItem>()
  let locallySatisfied = 0
  let metadataUpdatesSinceSave = 0

  if (config.troveOnly) {
    emitProgress(onProgress, 'Loading Trove catalog...')
    const troveProducts = await client.getTroveProducts()
    items.push(
      ...(await buildTroveDownloadItems(troveProducts, config, cache, client.signTroveDownload))
    )
  } else {
    let orderIndex = 0
    for (const orderId of purchaseKeys) {
      orderIndex += 1
      emitProgress(onProgress, `Scanning order ${orderIndex}/${purchaseKeys.length}...`)
      const order = await client.getOrderDetails(orderId)
      if (metadata) {
        upsertOrderMetadata(metadata, orderId, order)
        metadataUpdatesSinceSave += 1
        if (metadataUpdatesSinceSave >= METADATA_SAVE_INTERVAL) {
          await saveMetadata(config.libraryPath, metadata, config.metadataPath)
          metadataUpdatesSinceSave = 0
        }
      }
      const bundleTitle = order.product.human_name
      const inferredBundleFolder = inferBundleFolder(
        localDirectoryIndex,
        getAuditWebDownloadFilenames(order, config)
      )

      for (const product of order.subproducts) {
        const productFolder = buildProductFolder(
          config.libraryPath,
          bundleTitle,
          product.human_name
        )
        const webCandidates: WebDownloadCandidate[] = []

        for (const downloadType of product.downloads) {
          const activePlatformAccepted = shouldDownloadPlatform(downloadType.platform, config)

          for (const fileType of downloadType.download_struct) {
            if (fileType.url?.web) {
              const filename = getFilenameFromUrl(fileType.url.web)
              webCandidates.push({
                filename,
                platform: downloadType.platform,
                url: fileType.url.web,
                fileSize: fileType.file_size,
                md5: fileType.md5,
              })
              continue
            }

            if (!activePlatformAccepted) {
              continue
            }

            if (fileType.external_link) {
              console.info(
                formatExternalLinkMessage(bundleTitle, product.human_name, fileType.external_link)
              )
              continue
            }

            if (fileType.asm_config) {
              const gameName = fileType.asm_config.display_item
              const asmFile = fileType.asm_manifest?.asmFile
              if (!gameName || !asmFile) {
                console.info(
                  `ASM.js content missing metadata: ${bundleTitle}/${product.human_name}`
                )
                continue
              }

              const localFolder = path.join(productFolder, gameName)
              await mkdir(localFolder, { recursive: true })

              const asmFilename = `${gameName}.html`
              const asmLocalFilename = `${gameName}.local.html`
              const asmCacheKey = `${orderId}:${asmFilename}`
              const asmCacheEntry = cache[asmCacheKey]

              let html = ''
              let lastModified: string | undefined
              if (asmCacheEntry && !config.updateOnly) {
                try {
                  html = await readFile(path.join(localFolder, asmFilename), 'utf8')
                } catch {
                  html = ''
                }
              }

              if (!html) {
                const gameAsmName = asmFile.split('/')[2] ?? asmFile
                const asmUrl = `https://www.humblebundle.com/play/asmjs/${gameAsmName}/${orderId}`
                const response = await fetch(asmUrl)
                if (!response.ok) {
                  console.info(
                    `Failed to download ASM.js HTML: ${bundleTitle}/${product.human_name}`
                  )
                  continue
                }
                lastModified = response.headers.get('last-modified') ?? undefined
                html = await response.text()
                await writeFile(path.join(localFolder, asmFilename), html)
                cache[asmCacheKey] = {
                  urlLastModified: lastModified ?? new Date().toUTCString(),
                }
              }

              const manifest = parseAsmPlayerData(html)
              if (!manifest) {
                console.info(`ASM.js manifest missing: ${bundleTitle}/${product.human_name}`)
                continue
              }

              await writeLocalAsmHtml(path.join(localFolder, asmLocalFilename), html, manifest)

              for (const [localFilename, remoteFile] of Object.entries(manifest)) {
                const cacheKey = `${orderId}:${gameName}:${localFilename}`
                const cacheEntry = cache[cacheKey]
                if (cacheEntry && !config.updateOnly) {
                  continue
                }

                items.push({
                  url: remoteFile,
                  destination: path.join(localFolder, localFilename),
                  label: localFilename,
                  orderId,
                  bundleTitle,
                  productTitle: product.human_name,
                  cacheKey,
                  cacheEntry,
                })
              }
            }
          }
        }

        const selectedCandidates = selectRoutedDownloadCandidates(webCandidates, config, {
          bundleTitle,
          productTitle: product.human_name,
          publisherMediaScores,
        })
        for (const { candidate, library, routing } of selectedCandidates) {
          const cacheKey = `${orderId}:${candidate.filename}`
          const flatCacheKey = buildFlatCacheKey(library, product.human_name, candidate.filename)
          const cacheEntry = cache[cacheKey] ?? (flatCacheKey ? cache[flatCacheKey] : undefined)
          const publisherFolder =
            library.layout === 'flat'
              ? await resolvePublisherFolder(library.path, inferPublisherFolder(bundleTitle))
              : undefined
          const expectedDestination = path.join(
            buildLibraryProductFolder(library, bundleTitle, product.human_name, publisherFolder),
            candidate.filename
          )
          const plannedFlatDownloadItem = flatCacheKey
            ? plannedFlatDownloadItems.get(flatCacheKey)
            : undefined
          if (flatCacheKey && plannedFlatDownloadItem && !config.updateOnly) {
            plannedFlatDownloadItem.additionalCacheKeys = [
              ...(plannedFlatDownloadItem.additionalCacheKeys ?? []),
              cacheKey,
            ]
            plannedFlatDownloadItem.flatIndexEntries = [
              ...(plannedFlatDownloadItem.flatIndexEntries ?? []),
              buildFlatIndexUpdate({
                flatCacheKey,
                library,
                bundleTitle,
                productTitle: product.human_name,
                filename: candidate.filename,
                cacheKey,
                canonicalPath: plannedFlatDownloadItem.destination,
              }),
            ]
            continue
          }
          if (cacheEntry && !config.updateOnly) {
            if (!cache[cacheKey]) {
              cache[cacheKey] = cacheEntry
            }
            if (flatCacheKey) {
              if (!cache[flatCacheKey]) {
                cache[flatCacheKey] = cacheEntry
              }
              upsertFlatIndexEntry(
                cache,
                buildFlatIndexUpdate({
                  flatCacheKey,
                  library,
                  bundleTitle,
                  productTitle: product.human_name,
                  filename: candidate.filename,
                  cacheKey,
                  canonicalPath:
                    cache.flatIndex?.entries[flatCacheKey]?.canonicalPath ?? expectedDestination,
                })
              )
            }
            continue
          }
          const localPath = await findAuditFile(
            await buildAuditCandidatePaths(
              scanPaths,
              bundleTitle,
              product.human_name,
              inferredBundleFolder?.path,
              candidate.filename
            ),
            candidate.filename,
            config,
            localDirectoryIndex,
            inferredBundleFolder,
            routing.fallback ? undefined : library
          )
          if (localPath) {
            locallySatisfied += 1
            cache[cacheKey] = {
              urlLastModified: new Date().toUTCString(),
            }
            if (flatCacheKey) {
              cache[flatCacheKey] = cache[cacheKey]
              upsertFlatIndexEntry(
                cache,
                buildFlatIndexUpdate({
                  flatCacheKey,
                  library,
                  bundleTitle,
                  productTitle: product.human_name,
                  filename: candidate.filename,
                  cacheKey,
                  canonicalPath: localPath,
                })
              )
            }
            continue
          }
          const item: DownloadItem = {
            url: candidate.url,
            destination: expectedDestination,
            label: candidate.filename,
            orderId,
            bundleTitle,
            productTitle: product.human_name,
            expectedSize: candidate.fileSize,
            expectedMd5: candidate.md5,
            cacheKey,
            additionalCacheKeys: flatCacheKey ? [flatCacheKey] : undefined,
            flatIndexEntries: flatCacheKey
              ? [
                  buildFlatIndexUpdate({
                    flatCacheKey,
                    library,
                    bundleTitle,
                    productTitle: product.human_name,
                    filename: candidate.filename,
                    cacheKey,
                    canonicalPath: expectedDestination,
                  }),
                ]
              : undefined,
            cacheEntry,
          }
          items.push(item)
          if (flatCacheKey) {
            plannedFlatDownloadItems.set(flatCacheKey, item)
          }
        }
      }
    }
  }

  emitProgress(onProgress, `Queued ${items.length} download item(s).`)
  const failureReportPath =
    config.failureReportPath ?? path.join(config.libraryPath, DOWNLOAD_FAILURES_FILE)
  const failureReport = createFailureReport(config.libraryPath, items.length)
  await saveFailureReport(failureReportPath, failureReport)
  let cacheUpdatesSinceSave = 0
  let failedDownloads = 0
  let successfulDownloads = 0
  let failureUpdatesSinceSave = 0
  const results = await downloadQueue(items, config.showProgress, async (result, index, total) => {
    failureReport.processed = index
    if (result.error) {
      failedDownloads += 1
      recordDownloadFailure(failureReport, result)
      failureUpdatesSinceSave += 1
      emitProgressChunk(onProgress, '!')
    }

    const cacheKey = result.item.cacheKey
    if (cacheKey && !result.skipped && !result.error) {
      successfulDownloads += 1
      emitProgressChunk(onProgress, '.')
      const cacheUpdate = result.item.cacheUpdate ?? {}
      const lastModified = result.lastModified ?? new Date().toUTCString()
      cache[cacheKey] = {
        ...cacheUpdate,
        urlLastModified: cacheUpdate.urlLastModified ?? lastModified,
      }
      for (const additionalCacheKey of result.item.additionalCacheKeys ?? []) {
        cache[additionalCacheKey] = cache[cacheKey]
      }
      for (const flatIndexEntry of result.item.flatIndexEntries ?? []) {
        upsertFlatIndexEntry(cache, flatIndexEntry)
      }
      cacheUpdatesSinceSave += 1
    }

    if (index === total || index % 50 === 0) {
      emitProgress(
        onProgress,
        ` ${index}/${total}; downloaded ${successfulDownloads}; failed ${failedDownloads}.`
      )
    }

    if (cacheUpdatesSinceSave >= 25 || index === total) {
      await saveCache(config.libraryPath, cache, config.cachePath)
      cacheUpdatesSinceSave = 0
    }

    if (failureUpdatesSinceSave >= 10 || index === total) {
      await saveFailureReport(failureReportPath, failureReport)
      failureUpdatesSinceSave = 0
    }
  })
  emitProgress(onProgress, `Processed ${results.length} download item(s).`)
  const failedResults = results.filter((result) => result.error)
  for (const result of failedResults) {
    emitProgress(
      onProgress,
      `Failed: ${result.item.label ?? result.item.destination}: ${sanitizeDownloadError(result.error ?? 'unknown error')}`
    )
  }

  await saveCache(config.libraryPath, cache, config.cachePath)
  await saveFailureReport(failureReportPath, failureReport)
  if (metadata) {
    await saveMetadata(config.libraryPath, metadata, config.metadataPath)
    emitProgress(onProgress, `Wrote metadata for ${Object.keys(metadata.orders).length} order(s).`)
  }

  return {
    purchaseKeys: purchaseKeys.length,
    queued: items.length,
    downloaded: results.filter((result) => !result.skipped && !result.error).length,
    skipped: results.filter((result) => result.skipped).length,
    locallySatisfied,
    failed: results.filter((result) => result.error).length,
    cacheEntries: cacheDataEntryCount(cache),
    failureReportPath,
    metadataOrders: metadata ? Object.keys(metadata.orders).length : 0,
    metadataPath,
  }
}

export async function inspectDownloadState({
  client,
  config,
  cache,
  onProgress,
}: DownloadContext & {
  cache: CacheData
}): Promise<DownloadInspection> {
  const scanPaths = getScanPaths(config)
  emitProgress(onProgress, 'Indexing local files...')
  const localDirectoryIndex = await buildLocalDirectoryIndex(scanPaths)
  const metadata: MetadataData | undefined = config.troveOnly
    ? undefined
    : await loadMetadata(config.libraryPath, config.metadataPath)
  const publisherMediaScores = metadata
    ? buildPublisherMediaScores(Object.values(metadata.orders))
    : undefined
  emitProgress(onProgress, 'Loading Humble library metadata...')
  const purchaseKeys =
    config.purchaseKeys && config.purchaseKeys.length > 0
      ? config.purchaseKeys
      : parsePurchaseKeysFromLibraryPage(await client.getLibraryPage())

  if (purchaseKeys.length === 0 && !config.troveOnly) {
    throw new Error('Unable to determine purchase keys from the library page.')
  }

  const inspection: DownloadInspection = {
    purchaseKeys: purchaseKeys.length,
    ordersProcessed: 0,
    productsProcessed: 0,
    candidates: [],
  }

  if (config.troveOnly) {
    return inspection
  }

  let orderIndex = 0
  for (const orderId of purchaseKeys) {
    orderIndex += 1
    emitProgress(onProgress, `Inspecting order ${orderIndex}/${purchaseKeys.length}...`)
    const order = await client.getOrderDetails(orderId)
    inspection.ordersProcessed += 1
    const bundleTitle = order.product.human_name
    const inferredBundleFolder = inferBundleFolder(
      localDirectoryIndex,
      getAuditWebDownloadFilenames(order, config)
    )

    for (const product of order.subproducts) {
      inspection.productsProcessed += 1
      const webCandidates: WebDownloadCandidate[] = []

      for (const downloadType of product.downloads) {
        for (const fileType of downloadType.download_struct) {
          if (!fileType.url?.web) {
            continue
          }
          webCandidates.push({
            filename: getFilenameFromUrl(fileType.url.web),
            platform: downloadType.platform,
            url: fileType.url.web,
            fileSize: fileType.file_size,
            md5: fileType.md5,
          })
        }
      }

      const selectedCandidates = selectRoutedDownloadCandidates(webCandidates, config, {
        bundleTitle,
        productTitle: product.human_name,
        publisherMediaScores,
      })
      for (const { candidate, library, routing } of selectedCandidates) {
        const cacheKey = `${orderId}:${candidate.filename}`
        const flatCacheKey = buildFlatCacheKey(library, product.human_name, candidate.filename)
        const publisherFolder =
          library.layout === 'flat'
            ? await resolvePublisherFolder(library.path, inferPublisherFolder(bundleTitle))
            : undefined
        const expectedDestination = path.join(
          buildLibraryProductFolder(library, bundleTitle, product.human_name, publisherFolder),
          candidate.filename
        )
        const localPath = await findAuditFile(
          await buildAuditCandidatePaths(
            scanPaths,
            bundleTitle,
            product.human_name,
            inferredBundleFolder?.path,
            candidate.filename
          ),
          candidate.filename,
          config,
          localDirectoryIndex,
          inferredBundleFolder,
          routing.fallback ? undefined : library
        )

        inspection.candidates.push({
          cacheKey,
          flatCacheKey,
          filename: candidate.filename,
          platform: candidate.platform,
          url: candidate.url,
          orderId,
          bundleTitle,
          productTitle: product.human_name,
          expectedLibraryName: library.name,
          expectedLibraryPath: library.path,
          expectedDestination,
          expectedSize: candidate.fileSize,
          expectedMd5: candidate.md5,
          localPath,
          cacheEntry: cache[cacheKey] ?? (flatCacheKey ? cache[flatCacheKey] : undefined),
          routing,
        })
      }
    }
  }

  return inspection
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function fetchLastModified(client: ApiClient, url: string): Promise<string | undefined> {
  const headers = new Headers()
  headers.set('User-Agent', 'humblebundle-downloader-ts')
  if (client.session.cookieHeader) {
    headers.set('cookie', client.session.cookieHeader)
  }

  const response = await fetch(url, { method: 'HEAD', headers })
  if (!response.ok) {
    return undefined
  }
  return response.headers.get('last-modified') ?? undefined
}

async function auditCacheEntry(
  cache: CacheData,
  cacheKey: string,
  localPath: string,
  metadata: CacheEntry
): Promise<void> {
  if (!(await fileExists(localPath))) {
    return
  }
  cache[cacheKey] = metadata
}

async function findExistingDirectory(
  parent: string,
  directoryName: string
): Promise<string | undefined> {
  const cleanedName = cleanName(directoryName)
  try {
    const expected = cleanedName.toLowerCase()
    const entries = await readdir(parent, { withFileTypes: true })
    const match = entries.find(
      (entry) => entry.isDirectory() && cleanName(entry.name).toLowerCase() === expected
    )
    if (match) {
      return path.join(parent, match.name)
    }
    const similarMatches = entries.filter(
      (entry) => entry.isDirectory() && hasSimilarTitle(entry.name, directoryName)
    )
    return similarMatches.length === 1 ? path.join(parent, similarMatches[0]!.name) : undefined
  } catch {
    const directCandidates = [path.join(parent, cleanedName), path.join(parent, directoryName)]
    for (const candidate of directCandidates) {
      if (await fileExists(candidate)) {
        return candidate
      }
    }
    return undefined
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)]
}

export function getScanPaths(config: AppConfig): string[] {
  return uniquePaths(config.scanPaths.length > 0 ? config.scanPaths : [config.libraryPath])
}

function getAuditSelectionConfigs(config: AppConfig): Array<AppConfig | ScanLibraryConfig> {
  return config.hasConfiguredLibraries ? config.scanLibraries : [config]
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = path.relative(parent, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function getLocalScanLibrary(localPath: string, config: AppConfig): ScanLibraryConfig | undefined {
  return config.scanLibraries
    .filter((library) => isPathInside(path.resolve(library.path), path.resolve(localPath)))
    .sort((left, right) => right.path.length - left.path.length)[0]
}

export type LocalDirectoryIndex = {
  rootPaths: string[]
  rootFiles: Map<string, string>
  rootAliases: Map<string, string[]>
  topLevelDirectories: Array<{
    path: string
    files: Map<string, string[]>
    aliases: Map<string, string[]>
  }>
}

function addAlias(aliases: Map<string, string[]>, alias: string, filePath: string): void {
  const matches = aliases.get(alias) ?? []
  matches.push(filePath)
  aliases.set(alias, matches)
}

export async function buildAuditCandidatePaths(
  libraryPaths: string[],
  bundleTitle: string,
  productTitle: string,
  inferredBundleFolder: string | undefined,
  ...segments: string[]
): Promise<string[]> {
  const paths: string[] = []

  for (const libraryPath of libraryPaths) {
    const defaultBundleFolder = path.join(libraryPath, cleanName(bundleTitle))
    const bundleFolder =
      inferredBundleFolder ??
      (await findExistingDirectory(libraryPath, bundleTitle)) ??
      defaultBundleFolder
    const defaultProductFolder = path.join(bundleFolder, cleanName(productTitle))
    const productFolder =
      (await findExistingDirectory(bundleFolder, productTitle)) ??
      buildProductFolder(libraryPath, bundleTitle, productTitle)
    const inferredPublisherFolder = inferPublisherFolder(bundleTitle)
    const flatProductFolders = [
      ...(await findExistingPublisherFolders(libraryPath, inferredPublisherFolder)),
      inferredPublisherFolder,
    ]
      .filter((folder, index, folders) => folders.indexOf(folder) === index)
      .map((folder) => path.join(libraryPath, folder, inferSeriesFolder(productTitle)))

    paths.push(
      ...flatProductFolders.map((flatProductFolder) => path.join(flatProductFolder, ...segments)),
      path.join(productFolder, ...segments),
      path.join(defaultProductFolder, ...segments),
      path.join(bundleFolder, ...segments),
      path.join(defaultBundleFolder, ...segments),
      path.join(libraryPath, ...segments)
    )
  }

  return uniquePaths(paths)
}

async function findExistingPath(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await fileExists(candidate)) {
      return candidate
    }
  }
  return undefined
}

async function collectFiles(directory: string): Promise<{
  files: Map<string, string[]>
  aliases: Map<string, string[]>
}> {
  const files = new Map<string, string[]>()
  const aliases = new Map<string, string[]>()

  async function visit(currentDirectory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }

      if (!entry.isFile()) {
        continue
      }

      const filename = entry.name.toLowerCase()
      const matches = files.get(filename) ?? []
      matches.push(entryPath)
      files.set(filename, matches)
      for (const alias of buildFilenameAliases(entry.name)) {
        addAlias(aliases, alias, entryPath)
      }
    }
  }

  await visit(directory)
  return { files, aliases }
}

export async function buildLocalDirectoryIndex(
  scanRoots: string | string[]
): Promise<LocalDirectoryIndex> {
  const rootPaths = uniquePaths(Array.isArray(scanRoots) ? scanRoots : [scanRoots])
  const index: LocalDirectoryIndex = {
    rootPaths,
    rootFiles: new Map(),
    rootAliases: new Map(),
    topLevelDirectories: [],
  }

  for (const root of rootPaths) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = path.join(root, entry.name)
      if (entry.isFile()) {
        index.rootFiles.set(entry.name.toLowerCase(), entryPath)
        for (const alias of buildFilenameAliases(entry.name)) {
          addAlias(index.rootAliases, alias, entryPath)
        }
        continue
      }

      if (entry.isDirectory()) {
        const directoryFiles = await collectFiles(entryPath)
        index.topLevelDirectories.push({
          path: entryPath,
          files: directoryFiles.files,
          aliases: directoryFiles.aliases,
        })
      }
    }
  }

  return index
}

export async function findAuditFile(
  paths: string[],
  filename: string,
  config: AppConfig,
  localDirectoryIndex: LocalDirectoryIndex,
  inferredBundleFolder?: LocalDirectoryIndex['topLevelDirectories'][number],
  formatConfig?: Pick<AppConfig | ScanLibraryConfig, 'formatPriority'>,
  options: { allowEquivalentFormats?: boolean; allowGlobalAliasMatches?: boolean } = {}
): Promise<string | undefined> {
  const normalizedFilename = filename.toLowerCase()
  const allowEquivalentFormats = options.allowEquivalentFormats ?? true
  const aliasMatches = buildFilenameAliases(filename)
    .flatMap((alias) => [
      ...(inferredBundleFolder?.aliases.get(alias) ?? []),
      ...(options.allowGlobalAliasMatches
        ? localDirectoryIndex.topLevelDirectories.flatMap(
            (directory) => directory.aliases.get(alias) ?? []
          )
        : []),
      ...(localDirectoryIndex.rootAliases.get(alias) ?? []),
    ])
    .filter((match, index, matches) => matches.indexOf(match) === index)
    .filter((match) =>
      canLocalFormatSatisfyRemote(filename, match, config, formatConfig, allowEquivalentFormats)
    )
  const candidateDirectoryMatches: string[] = []

  for (const candidate of paths) {
    const directory = path.dirname(candidate)
    if (localDirectoryIndex.rootPaths.includes(directory) || !(await fileExists(directory))) {
      continue
    }
    const directoryFiles = await collectFiles(directory)
    for (const alias of buildFilenameAliases(filename)) {
      candidateDirectoryMatches.push(...(directoryFiles.aliases.get(alias) ?? []))
    }
  }

  const uniqueCandidateDirectoryMatches = candidateDirectoryMatches
    .filter((match, index, matches) => matches.indexOf(match) === index)
    .filter((match) =>
      canLocalFormatSatisfyRemote(filename, match, config, formatConfig, allowEquivalentFormats)
    )

  return (
    (await findExistingPath(paths)) ??
    (uniqueCandidateDirectoryMatches.length === 1
      ? uniqueCandidateDirectoryMatches[0]
      : undefined) ??
    (aliasMatches.length === 1 ? aliasMatches[0] : undefined) ??
    inferredBundleFolder?.files.get(normalizedFilename)?.[0] ??
    localDirectoryIndex.rootFiles.get(normalizedFilename)
  )
}

function getFormatPreferenceRank(
  filename: string,
  config: Pick<AppConfig | ScanLibraryConfig, 'formatPriority'>
): number {
  const priority = config.formatPriority ?? []
  const extension = getExtension(filename)
  const index = priority.indexOf(extension)
  return index === -1 ? priority.length : index
}

function canLocalFormatSatisfyRemote(
  remoteFilename: string,
  localPath: string,
  config: AppConfig,
  formatConfig?: Pick<AppConfig | ScanLibraryConfig, 'formatPriority'>,
  allowEquivalentFormats = true
): boolean {
  const remoteExtension = getExtension(remoteFilename)
  const localExtension = getExtension(path.basename(localPath))
  if (localExtension === remoteExtension) {
    return true
  }
  if (!allowEquivalentFormats) {
    return false
  }
  const localConfig = getLocalScanLibrary(localPath, config) ?? config

  if (
    !config.hasConfiguredLibraries &&
    remoteExtension === 'pdf' &&
    (localExtension === 'epub' || localExtension === 'mobi')
  ) {
    return true
  }

  const prioritySource = formatConfig ?? localConfig
  const priority = prioritySource.formatPriority ?? []
  if (!priority.includes(localExtension) || !priority.includes(remoteExtension)) {
    return false
  }

  return (
    getFormatPreferenceRank(path.basename(localPath), prioritySource) <=
    getFormatPreferenceRank(remoteFilename, prioritySource)
  )
}

export function inferBundleFolder(
  localDirectoryIndex: LocalDirectoryIndex,
  expectedFilenames: Set<string>
): LocalDirectoryIndex['topLevelDirectories'][number] | undefined {
  if (expectedFilenames.size < 2) {
    return undefined
  }

  const minimumMatches = Math.max(2, Math.ceil(expectedFilenames.size * 0.2))
  const candidates = localDirectoryIndex.topLevelDirectories
    .map((directory) => {
      let matches = 0
      for (const filename of expectedFilenames) {
        if (directory.files.has(filename)) {
          matches += 1
          continue
        }

        if (buildFilenameAliases(filename).some((alias) => directory.aliases.has(alias))) {
          matches += 1
        }
      }
      return { directory, matches }
    })
    .filter((candidate) => candidate.matches >= minimumMatches)
    .sort((left, right) => right.matches - left.matches)

  const best = candidates[0]
  if (!best) {
    return undefined
  }

  const secondBest = candidates[1]
  if (secondBest && secondBest.matches === best.matches) {
    return undefined
  }

  return best.directory
}

function getWebDownloadFilenames(
  order: Awaited<ReturnType<ApiClient['getOrderDetails']>>,
  config: Pick<AppConfig | ScanLibraryConfig, 'platformInclude' | 'extInclude' | 'extExclude'>
): Set<string> {
  const filenames = new Set<string>()

  for (const product of order.subproducts) {
    for (const downloadType of product.downloads) {
      if (!shouldDownloadPlatform(downloadType.platform, config)) {
        continue
      }

      for (const fileType of downloadType.download_struct) {
        if (!fileType.url?.web) {
          continue
        }

        const filename = getFilenameFromUrl(fileType.url.web)
        if (shouldDownloadExtension(filename, config)) {
          filenames.add(filename.toLowerCase())
        }
      }
    }
  }

  return filenames
}

function getAuditWebDownloadFilenames(
  order: Awaited<ReturnType<ApiClient['getOrderDetails']>>,
  config: AppConfig
): Set<string> {
  const filenames = new Set<string>()
  for (const selectionConfig of getAuditSelectionConfigs(config)) {
    for (const filename of getWebDownloadFilenames(order, selectionConfig)) {
      filenames.add(filename)
    }
  }
  return filenames
}

export async function auditLibrary({
  client,
  config,
  onProgress,
}: DownloadContext): Promise<AuditSummary> {
  emitProgress(onProgress, 'Loading existing cache...')
  const existingCache = await loadCache(config.libraryPath, config.cachePath)
  const cache: CacheData = {}
  if (existingCache.transforms) {
    Object.assign(cache, { transforms: existingCache.transforms })
  }
  const metadata: MetadataData | undefined = config.troveOnly
    ? undefined
    : await loadMetadata(config.libraryPath, config.metadataPath)
  const publisherMediaScores = metadata
    ? buildPublisherMediaScores(Object.values(metadata.orders))
    : undefined
  emitProgress(onProgress, 'Indexing local files...')
  const scanPaths = getScanPaths(config)
  const localDirectoryIndex = await buildLocalDirectoryIndex(scanPaths)
  emitProgress(onProgress, 'Loading Humble library metadata...')
  const purchaseKeys =
    config.purchaseKeys && config.purchaseKeys.length > 0
      ? config.purchaseKeys
      : parsePurchaseKeysFromLibraryPage(await client.getLibraryPage())

  if (purchaseKeys.length === 0 && !config.troveOnly) {
    throw new Error('Unable to determine purchase keys from the library page.')
  }

  const now = new Date().toUTCString()
  const summary: AuditSummary = {
    purchaseKeys: purchaseKeys.length,
    ordersProcessed: 0,
    productsProcessed: 0,
    candidatesConsidered: 0,
    cacheEntries: 0,
    selectedCandidates: 0,
    matchedFiles: 0,
    metadataOrders: metadata ? Object.keys(metadata.orders).length : 0,
    metadataPath: metadata
      ? resolveMetadataPath(config.libraryPath, config.metadataPath)
      : undefined,
  }
  let metadataUpdatesSinceSave = 0

  if (config.troveOnly) {
    emitProgress(onProgress, 'Loading Trove catalog...')
    const troveProducts = await client.getTroveProducts()
    emitProgress(onProgress, `Auditing ${troveProducts.length} Trove product(s)...`)
    for (const product of troveProducts) {
      const title = cleanName(product['human-name'])
      const productFolder = buildTroveFolder(config.libraryPath, title)
      summary.productsProcessed += 1

      for (const [platform, download] of Object.entries(product.downloads)) {
        if (!shouldDownloadPlatform(platform, config)) {
          continue
        }

        const filename = getFilenameFromUrl(download.url.web)
        if (!shouldDownloadExtension(filename, config)) {
          continue
        }

        const cacheKey = `trove:${filename}`
        summary.candidatesConsidered += 1
        summary.selectedCandidates += 1
        const uploadedAt = download.uploaded_at ?? download.timestamp ?? product.date_added ?? '0'
        const md5 = download.md5 ?? 'UNKNOWN_MD5'
        const localPath = await findAuditFile(
          [path.join(productFolder, filename)],
          filename,
          config,
          localDirectoryIndex
        )

        if (localPath) {
          summary.matchedFiles += 1
          await auditCacheEntry(cache, cacheKey, localPath, {
            uploadedAt,
            md5,
          })
        }
      }
    }
  } else {
    let orderIndex = 0
    for (const orderId of purchaseKeys) {
      orderIndex += 1
      emitProgress(onProgress, `Auditing order ${orderIndex}/${purchaseKeys.length}...`)
      const order = await client.getOrderDetails(orderId)
      summary.ordersProcessed += 1
      if (metadata) {
        upsertOrderMetadata(metadata, orderId, order)
        metadataUpdatesSinceSave += 1
        if (metadataUpdatesSinceSave >= METADATA_SAVE_INTERVAL) {
          await saveMetadata(config.libraryPath, metadata, config.metadataPath)
          metadataUpdatesSinceSave = 0
        }
      }
      const bundleTitle = order.product.human_name
      const inferredBundleFolder = inferBundleFolder(
        localDirectoryIndex,
        getAuditWebDownloadFilenames(order, config)
      )

      for (const product of order.subproducts) {
        summary.productsProcessed += 1
        const webCandidates: Array<{
          filename: string
          platform: string
          url: string
        }> = []

        for (const downloadType of product.downloads) {
          const platformAcceptedForAudit = getAuditSelectionConfigs(config).some(
            (selectionConfig) => shouldDownloadPlatform(downloadType.platform, selectionConfig)
          )

          for (const fileType of downloadType.download_struct) {
            if (fileType.url?.web) {
              const filename = getFilenameFromUrl(fileType.url.web)

              webCandidates.push({
                filename,
                platform: downloadType.platform,
                url: fileType.url.web,
              })
              if (
                getAuditSelectionConfigs(config).some(
                  (selectionConfig) =>
                    shouldDownloadPlatform(downloadType.platform, selectionConfig) &&
                    shouldDownloadExtension(filename, selectionConfig)
                )
              ) {
                summary.candidatesConsidered += 1
              }
              continue
            }

            if (!platformAcceptedForAudit) {
              continue
            }

            if (fileType.asm_config) {
              const gameName = fileType.asm_config.display_item
              const asmFile = fileType.asm_manifest?.asmFile
              if (!gameName || !asmFile) {
                continue
              }

              const localFolder = await findExistingPath(
                await buildAuditCandidatePaths(
                  scanPaths,
                  bundleTitle,
                  product.human_name,
                  inferredBundleFolder?.path,
                  gameName
                )
              )
              if (!localFolder) {
                continue
              }

              const asmFilename = `${gameName}.html`
              const asmLocalFilename = `${gameName}.local.html`
              const asmCacheKey = `${orderId}:${asmFilename}`
              const asmPath = path.join(localFolder, asmFilename)
              if (await fileExists(asmPath)) {
                const lastModified = config.offlineAudit
                  ? undefined
                  : await fetchLastModified(
                      client,
                      `https://www.humblebundle.com/play/asmjs/${asmFile.split('/')[2] ?? asmFile}/${orderId}`
                    )
                cache[asmCacheKey] = {
                  urlLastModified: lastModified ?? now,
                }
              }

              let html = ''
              if (await fileExists(asmPath)) {
                html = await readFile(asmPath, 'utf8')
              } else {
                const localHtmlPath = path.join(localFolder, asmLocalFilename)
                if (await fileExists(localHtmlPath)) {
                  html = await readFile(localHtmlPath, 'utf8')
                }
              }

              const manifest = html ? parseAsmPlayerData(html) : undefined
              if (!manifest) {
                continue
              }

              for (const [localFilename, remoteFile] of Object.entries(manifest)) {
                const cacheKey = `${orderId}:${gameName}:${localFilename}`
                const localPath = await findAuditFile(
                  [path.join(localFolder, localFilename)],
                  localFilename,
                  config,
                  localDirectoryIndex,
                  inferredBundleFolder
                )
                if (!localPath) {
                  continue
                }
                const fileLastModified = config.offlineAudit
                  ? undefined
                  : await fetchLastModified(client, remoteFile)
                cache[cacheKey] = {
                  urlLastModified: fileLastModified ?? now,
                }
              }
            }
          }
        }

        const selectedCandidates = selectRoutedDownloadCandidates(webCandidates, config, {
          bundleTitle,
          productTitle: product.human_name,
          publisherMediaScores,
        })
        summary.selectedCandidates += selectedCandidates.length
        for (const { candidate, library, routing } of selectedCandidates) {
          const cacheKey = `${orderId}:${candidate.filename}`
          const flatCacheKey = buildFlatCacheKey(library, product.human_name, candidate.filename)
          const localPath = await findAuditFile(
            await buildAuditCandidatePaths(
              scanPaths,
              bundleTitle,
              product.human_name,
              inferredBundleFolder?.path,
              candidate.filename
            ),
            candidate.filename,
            config,
            localDirectoryIndex,
            inferredBundleFolder,
            routing.fallback ? undefined : library
          )
          if (!localPath) {
            continue
          }
          summary.matchedFiles += 1
          const lastModified = config.offlineAudit
            ? undefined
            : await fetchLastModified(client, candidate.url)

          cache[cacheKey] = {
            urlLastModified: lastModified ?? now,
          }
          if (flatCacheKey) {
            cache[flatCacheKey] = cache[cacheKey]
            upsertFlatIndexEntry(
              cache,
              buildFlatIndexUpdate({
                flatCacheKey,
                library,
                bundleTitle,
                productTitle: product.human_name,
                filename: candidate.filename,
                cacheKey,
                canonicalPath: localPath,
              })
            )
          }
        }
      }
    }
  }

  await saveCache(config.libraryPath, cache, config.cachePath)
  summary.cacheEntries = cacheDataEntryCount(cache)
  emitProgress(onProgress, `Wrote ${summary.cacheEntries} cache entries.`)
  if (metadata) {
    await saveMetadata(config.libraryPath, metadata, config.metadataPath)
    summary.metadataOrders = Object.keys(metadata.orders).length
    emitProgress(onProgress, `Wrote metadata for ${summary.metadataOrders} order(s).`)
  }
  return summary
}
