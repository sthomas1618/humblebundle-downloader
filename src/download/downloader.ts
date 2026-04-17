import { createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

import type { ApiClient } from '../api/client'
import type { AppConfig } from '../config'
import { buildProductFolder, buildTroveFolder, cleanName } from '../utils/fs'
import { loadCache, saveCache, type CacheEntry } from './cache'

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
  failed: number
  cacheEntries: number
  failureReportPath?: string
}

export type AuditSummary = {
  purchaseKeys: number
  ordersProcessed: number
  productsProcessed: number
  candidatesConsidered: number
  cacheEntries: number
  selectedCandidates: number
  matchedFiles: number
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

export function shouldDownloadPlatform(platform: string, config: AppConfig): boolean {
  if (!config.platformInclude || config.platformInclude.length === 0) {
    return true
  }
  const normalized = new Set(config.platformInclude.map((value) => value.toLowerCase()))
  if (normalized.has('all')) {
    return true
  }
  return normalized.has(platform.toLowerCase())
}

export function shouldDownloadExtension(filename: string, config: AppConfig): boolean {
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

export function selectPreferredDownloadCandidates<T extends { filename: string }>(
  candidates: T[],
  config: AppConfig
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
  const cache = await loadCache(config.libraryPath)
  emitProgress(onProgress, 'Loading Humble library metadata...')
  const purchaseKeys =
    config.purchaseKeys && config.purchaseKeys.length > 0
      ? config.purchaseKeys
      : parsePurchaseKeysFromLibraryPage(await client.getLibraryPage())

  if (purchaseKeys.length === 0 && !config.troveOnly) {
    throw new Error('Unable to determine purchase keys from the library page.')
  }

  const items: DownloadItem[] = []

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
      const bundleTitle = order.product.human_name

      for (const product of order.subproducts) {
        const productFolder = buildProductFolder(
          config.libraryPath,
          bundleTitle,
          product.human_name
        )
        const webCandidates: Array<{
          filename: string
          url: string
          fileSize?: number
          md5?: string
        }> = []

        for (const downloadType of product.downloads) {
          if (!shouldDownloadPlatform(downloadType.platform, config)) {
            continue
          }

          for (const fileType of downloadType.download_struct) {
            if (fileType.url?.web) {
              const filename = getFilenameFromUrl(fileType.url.web)
              if (!shouldDownloadExtension(filename, config)) {
                continue
              }
              webCandidates.push({
                filename,
                url: fileType.url.web,
                fileSize: fileType.file_size,
                md5: fileType.md5,
              })
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

        const selectedCandidates = selectPreferredDownloadCandidates(webCandidates, config)
        for (const candidate of selectedCandidates) {
          const cacheKey = `${orderId}:${candidate.filename}`
          const cacheEntry = cache[cacheKey]
          if (cacheEntry && !config.updateOnly) {
            continue
          }

          items.push({
            url: candidate.url,
            destination: path.join(productFolder, candidate.filename),
            label: candidate.filename,
            orderId,
            bundleTitle,
            productTitle: product.human_name,
            expectedSize: candidate.fileSize,
            expectedMd5: candidate.md5,
            cacheKey,
            cacheEntry,
          })
        }
      }
    }
  }

  emitProgress(onProgress, `Queued ${items.length} download item(s).`)
  const failureReportPath = path.join(config.libraryPath, DOWNLOAD_FAILURES_FILE)
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
      cacheUpdatesSinceSave += 1
    }

    if (index === total || index % 50 === 0) {
      emitProgress(
        onProgress,
        ` ${index}/${total}; downloaded ${successfulDownloads}; failed ${failedDownloads}.`
      )
    }

    if (cacheUpdatesSinceSave >= 25 || index === total) {
      await saveCache(config.libraryPath, cache)
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

  await saveCache(config.libraryPath, cache)
  await saveFailureReport(failureReportPath, failureReport)

  return {
    purchaseKeys: purchaseKeys.length,
    queued: items.length,
    downloaded: results.filter((result) => !result.skipped && !result.error).length,
    skipped: results.filter((result) => result.skipped).length,
    failed: results.filter((result) => result.error).length,
    cacheEntries: Object.keys(cache).filter((key) => key !== 'transforms').length,
    failureReportPath,
  }
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
  cache: Record<string, CacheEntry>,
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
  const directCandidates = [path.join(parent, cleanedName), path.join(parent, directoryName)]

  for (const candidate of directCandidates) {
    if (await fileExists(candidate)) {
      return candidate
    }
  }

  try {
    const expected = cleanedName.toLowerCase()
    const entries = await readdir(parent, { withFileTypes: true })
    const match = entries.find(
      (entry) => entry.isDirectory() && cleanName(entry.name).toLowerCase() === expected
    )
    return match ? path.join(parent, match.name) : undefined
  } catch {
    return undefined
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)]
}

type LocalDirectoryIndex = {
  rootPath: string
  rootFiles: Map<string, string>
  rootAliases: Map<string, string[]>
  topLevelDirectories: Array<{
    path: string
    files: Map<string, string[]>
    aliases: Map<string, string[]>
  }>
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

function normalizeFilenameStem(filename: string): string {
  return stripExtension(filename)
    .toLowerCase()
    .replace(/_\d{8,13}$/, '')
    .replace(/_ebook$/, '')
    .replaceAll(/[^\da-z]+/g, '')
}

function getVolumePrefix(stem: string): string | undefined {
  return stem.match(/^(.*?vol(?:ume)?0*\d+)/)?.[1]
}

function getBookVolumeAlias(stem: string): string | undefined {
  const bookNumbers: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  }
  const match = stem.match(/^(.*)book(one|two|three|four|five|six|seven|eight|nine|ten)$/)
  if (!match) {
    return undefined
  }
  return `${match[1]}vol${bookNumbers[match[2]]}`
}

function buildFilenameAliases(filename: string): string[] {
  const stem = normalizeFilenameStem(filename)
  const aliases = new Set<string>([filename.toLowerCase(), stem])
  const volumePrefix = getVolumePrefix(stem)
  const bookVolumeAlias = getBookVolumeAlias(stem)

  if (volumePrefix && volumePrefix.length >= 8) {
    aliases.add(`prefix:${volumePrefix}`)
  }
  if (bookVolumeAlias && bookVolumeAlias.length >= 8) {
    aliases.add(bookVolumeAlias)
    aliases.add(`prefix:${bookVolumeAlias}`)
  }

  return [...aliases]
}

function addAlias(aliases: Map<string, string[]>, alias: string, filePath: string): void {
  const matches = aliases.get(alias) ?? []
  matches.push(filePath)
  aliases.set(alias, matches)
}

async function buildAuditCandidatePaths(
  libraryPath: string,
  bundleTitle: string,
  productTitle: string,
  inferredBundleFolder: string | undefined,
  ...segments: string[]
): Promise<string[]> {
  const defaultBundleFolder = path.join(libraryPath, cleanName(bundleTitle))
  const bundleFolder =
    inferredBundleFolder ??
    (await findExistingDirectory(libraryPath, bundleTitle)) ??
    defaultBundleFolder
  const defaultProductFolder = path.join(bundleFolder, cleanName(productTitle))
  const productFolder =
    (await findExistingDirectory(bundleFolder, productTitle)) ??
    buildProductFolder(libraryPath, bundleTitle, productTitle)

  return uniquePaths([
    path.join(productFolder, ...segments),
    path.join(defaultProductFolder, ...segments),
    path.join(bundleFolder, ...segments),
    path.join(defaultBundleFolder, ...segments),
    path.join(libraryPath, ...segments),
  ])
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

async function buildLocalDirectoryIndex(root: string): Promise<LocalDirectoryIndex> {
  const index: LocalDirectoryIndex = {
    rootPath: root,
    rootFiles: new Map(),
    rootAliases: new Map(),
    topLevelDirectories: [],
  }

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return index
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

  return index
}

async function findAuditFile(
  paths: string[],
  filename: string,
  config: AppConfig,
  localDirectoryIndex: LocalDirectoryIndex,
  inferredBundleFolder?: LocalDirectoryIndex['topLevelDirectories'][number]
): Promise<string | undefined> {
  const normalizedFilename = filename.toLowerCase()
  const aliasMatches = buildFilenameAliases(filename)
    .flatMap((alias) => [
      ...(inferredBundleFolder?.aliases.get(alias) ?? []),
      ...(localDirectoryIndex.rootAliases.get(alias) ?? []),
    ])
    .filter((match, index, matches) => matches.indexOf(match) === index)
    .filter((match) => canLocalFormatSatisfyRemote(filename, match, config))
  const candidateDirectoryMatches: string[] = []

  for (const candidate of paths) {
    const directory = path.dirname(candidate)
    if (directory === localDirectoryIndex.rootPath || !(await fileExists(directory))) {
      continue
    }
    const directoryFiles = await collectFiles(directory)
    for (const alias of buildFilenameAliases(filename)) {
      candidateDirectoryMatches.push(...(directoryFiles.aliases.get(alias) ?? []))
    }
  }

  const uniqueCandidateDirectoryMatches = candidateDirectoryMatches
    .filter((match, index, matches) => matches.indexOf(match) === index)
    .filter((match) => canLocalFormatSatisfyRemote(filename, match, config))

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

function getFormatPreferenceRank(filename: string, config: AppConfig): number {
  const priority = config.formatPriority ?? []
  const extension = getExtension(filename)
  const index = priority.indexOf(extension)
  return index === -1 ? priority.length : index
}

function canLocalFormatSatisfyRemote(
  remoteFilename: string,
  localPath: string,
  config: AppConfig
): boolean {
  const remoteExtension = getExtension(remoteFilename)
  const localExtension = getExtension(path.basename(localPath))
  if (localExtension === remoteExtension) {
    return true
  }
  if (remoteExtension === 'pdf' && (localExtension === 'epub' || localExtension === 'mobi')) {
    return true
  }

  const priority = config.formatPriority ?? []
  if (!priority.includes(localExtension) || !priority.includes(remoteExtension)) {
    return false
  }

  return (
    getFormatPreferenceRank(path.basename(localPath), config) <=
    getFormatPreferenceRank(remoteFilename, config)
  )
}

function inferBundleFolder(
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
  config: AppConfig
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

export async function auditLibrary({
  client,
  config,
  onProgress,
}: DownloadContext): Promise<AuditSummary> {
  emitProgress(onProgress, 'Loading existing cache...')
  const existingCache = await loadCache(config.libraryPath)
  const cache: Record<string, CacheEntry> = {}
  if (existingCache.transforms) {
    Object.assign(cache, { transforms: existingCache.transforms })
  }
  emitProgress(onProgress, 'Indexing local files...')
  const localDirectoryIndex = await buildLocalDirectoryIndex(config.libraryPath)
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
  }

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
      const bundleTitle = order.product.human_name
      const inferredBundleFolder = inferBundleFolder(
        localDirectoryIndex,
        getWebDownloadFilenames(order, config)
      )

      for (const product of order.subproducts) {
        summary.productsProcessed += 1
        const webCandidates: Array<{
          filename: string
          url: string
        }> = []

        for (const downloadType of product.downloads) {
          if (!shouldDownloadPlatform(downloadType.platform, config)) {
            continue
          }

          for (const fileType of downloadType.download_struct) {
            if (fileType.url?.web) {
              const filename = getFilenameFromUrl(fileType.url.web)
              if (!shouldDownloadExtension(filename, config)) {
                continue
              }

              webCandidates.push({
                filename,
                url: fileType.url.web,
              })
              summary.candidatesConsidered += 1
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
                  config.libraryPath,
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

        const selectedCandidates = selectPreferredDownloadCandidates(webCandidates, config)
        summary.selectedCandidates += selectedCandidates.length
        for (const candidate of selectedCandidates) {
          const cacheKey = `${orderId}:${candidate.filename}`
          const localPath = await findAuditFile(
            await buildAuditCandidatePaths(
              config.libraryPath,
              bundleTitle,
              product.human_name,
              inferredBundleFolder?.path,
              candidate.filename
            ),
            candidate.filename,
            config,
            localDirectoryIndex,
            inferredBundleFolder
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
        }
      }
    }
  }

  await saveCache(config.libraryPath, cache)
  summary.cacheEntries = Object.keys(cache).filter((key) => key !== 'transforms').length
  emitProgress(onProgress, `Wrote ${summary.cacheEntries} cache entries.`)
  return summary
}
