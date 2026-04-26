import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type CacheEntry = {
  urlLastModified?: string
  uploadedAt?: string
  md5?: string
}

export type PdfCbzCacheEntry = {
  pdfMtimeMs: number
  pdfSize: number
  cbzPath: string
  lastGeneratedMs: number
  comicInfoPreserved?: boolean
}

export type PdfFileStats = {
  mtimeMs: number
  size: number
}

export type PdfCbzCache = {
  version: number
  entries: Record<string, PdfCbzCacheEntry>
}

export type CacheTransforms = {
  pdf?: {
    cbz?: PdfCbzCache
  }
}

export type FlatBundleLocation = {
  cacheKey: string
  orderId?: string
  bundleTitle: string
  productTitle: string
  bundlePath: string
}

export type FlatIndexEntry = {
  flatCacheKey: string
  canonicalPath: string
  libraryName?: string
  libraryPath: string
  publisher: string
  series: string
  productKey: string
  productTitle: string
  filename: string
  bundleLocations: FlatBundleLocation[]
}

export type FlatIndex = {
  version: 1
  entries: Record<string, FlatIndexEntry>
}

export type CacheData = Record<string, CacheEntry> & {
  transforms?: CacheTransforms
  flatIndex?: FlatIndex
}

const CACHE_FILE = '.cache.json'

export function resolveCachePath(libraryPath: string, cachePath?: string): string {
  return cachePath ? path.resolve(cachePath) : path.join(libraryPath, CACHE_FILE)
}

function defaultPdfCbzCache(): PdfCbzCache {
  return {
    version: 1,
    entries: {},
  }
}

function mergePdfCbzCaches(target: PdfCbzCache, source?: PdfCbzCache): PdfCbzCache {
  if (!source) {
    return target
  }
  return {
    version: target.version ?? source.version,
    entries: {
      ...source.entries,
      ...target.entries,
    },
  }
}

function normalizeCache(data: unknown): CacheData {
  if (!data || typeof data !== 'object') {
    return {}
  }
  const cache = data as CacheData
  if (cache.flatIndex?.version !== 1 || !cache.flatIndex.entries) {
    delete cache.flatIndex
  }
  const transforms = cache.transforms
  const existing = transforms?.pdf?.cbz
  if (existing) {
    const pdfTransforms = transforms?.pdf
    const updatedPdf = pdfTransforms
      ? { ...pdfTransforms, cbz: mergePdfCbzCaches(existing) }
      : { cbz: mergePdfCbzCaches(existing) }
    cache.transforms = transforms ? { ...transforms, pdf: updatedPdf } : { pdf: updatedPdf }
  }
  return cache
}

function ensureFlatIndex(cache: CacheData): FlatIndex {
  if (!cache.flatIndex) {
    cache.flatIndex = {
      version: 1,
      entries: {},
    }
  }
  return cache.flatIndex
}

export function upsertFlatIndexEntry(
  cache: CacheData,
  entry: Omit<FlatIndexEntry, 'bundleLocations'> & { bundleLocation: FlatBundleLocation }
): void {
  const flatIndex = ensureFlatIndex(cache)
  const existing = flatIndex.entries[entry.flatCacheKey]
  const bundleLocations = existing?.bundleLocations ?? []
  const existingLocationIndex = bundleLocations.findIndex(
    (location) => location.cacheKey === entry.bundleLocation.cacheKey
  )
  if (existingLocationIndex === -1) {
    bundleLocations.push(entry.bundleLocation)
  } else {
    bundleLocations[existingLocationIndex] = entry.bundleLocation
  }

  flatIndex.entries[entry.flatCacheKey] = {
    flatCacheKey: entry.flatCacheKey,
    canonicalPath: entry.canonicalPath,
    libraryName: entry.libraryName,
    libraryPath: entry.libraryPath,
    publisher: entry.publisher,
    series: entry.series,
    productKey: entry.productKey,
    productTitle: entry.productTitle,
    filename: entry.filename,
    bundleLocations,
  }
}

export function getPdfCbzEntry(cache: CacheData, pdfKey: string): PdfCbzCacheEntry | undefined {
  return cache.transforms?.pdf?.cbz?.entries[pdfKey]
}

export function setPdfCbzEntry(cache: CacheData, pdfKey: string, entry: PdfCbzCacheEntry): void {
  if (!cache.transforms) {
    cache.transforms = {}
  }
  if (!cache.transforms.pdf) {
    cache.transforms.pdf = {}
  }
  if (!cache.transforms.pdf.cbz) {
    cache.transforms.pdf.cbz = defaultPdfCbzCache()
  }
  cache.transforms.pdf.cbz.entries[pdfKey] = entry
}

export function shouldRegeneratePdfCbz(
  entry: PdfCbzCacheEntry | undefined,
  stats: PdfFileStats,
  force: boolean
): boolean {
  if (force || !entry) {
    return true
  }
  return entry.pdfMtimeMs !== stats.mtimeMs || entry.pdfSize !== stats.size
}

export async function loadCache(libraryPath: string, cachePath?: string): Promise<CacheData> {
  try {
    const data = await readFile(resolveCachePath(libraryPath, cachePath), 'utf8')
    return normalizeCache(JSON.parse(data))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    return {}
  }
}

export async function saveCache(
  libraryPath: string,
  cache: CacheData,
  cachePathOverride?: string
): Promise<void> {
  const payload = JSON.stringify(cache, undefined, 2)
  const cachePath = resolveCachePath(libraryPath, cachePathOverride)
  const temporaryPath = `${cachePath}.tmp`
  await mkdir(path.dirname(cachePath), { recursive: true })
  await writeFile(temporaryPath, payload)
  try {
    await rename(temporaryPath, cachePath)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      await copyFile(temporaryPath, cachePath)
      await rm(temporaryPath, { force: true })
      return
    }
    throw error
  }
}
