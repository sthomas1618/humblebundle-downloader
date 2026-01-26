import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

export type CacheData = Record<string, CacheEntry> & {
  transforms?: CacheTransforms
}

const CACHE_FILE = '.cache.json'

const defaultPdfCbzCache = (): PdfCbzCache => ({
  version: 1,
  entries: {},
})

const mergePdfCbzCaches = (target: PdfCbzCache, source?: PdfCbzCache): PdfCbzCache => {
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

const normalizeCache = (data: unknown): CacheData => {
  if (!data || typeof data !== 'object') {
    return {}
  }
  const cache = data as CacheData
  const transforms = cache.transforms ?? {}
  const existing = transforms.pdf?.cbz
  if (existing) {
    cache.transforms = {
      ...transforms,
      pdf: {
        ...(transforms.pdf ?? {}),
        cbz: mergePdfCbzCaches(existing, undefined),
      },
    }
  }
  return cache
}

export const getPdfCbzEntry = (
  cache: CacheData,
  pdfKey: string
): PdfCbzCacheEntry | undefined => {
  return cache.transforms?.pdf?.cbz?.entries[pdfKey]
}

export const setPdfCbzEntry = (
  cache: CacheData,
  pdfKey: string,
  entry: PdfCbzCacheEntry
): void => {
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

export const shouldRegeneratePdfCbz = (
  entry: PdfCbzCacheEntry | undefined,
  stats: PdfFileStats,
  force: boolean
): boolean => {
  if (force || !entry) {
    return true
  }
  return entry.pdfMtimeMs !== stats.mtimeMs || entry.pdfSize !== stats.size
}

export const loadCache = async (libraryPath: string): Promise<CacheData> => {
  try {
    const data = await readFile(join(libraryPath, CACHE_FILE), 'utf-8')
    return normalizeCache(JSON.parse(data))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    return {}
  }
}

export const saveCache = async (libraryPath: string, cache: CacheData): Promise<void> => {
  const payload = JSON.stringify(cache, null, 2)
  const cachePath = join(libraryPath, CACHE_FILE)
  const tempPath = join(libraryPath, `${CACHE_FILE}.tmp`)
  await writeFile(tempPath, payload)
  await rename(tempPath, cachePath)
}
