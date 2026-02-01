import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
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
}

export type DownloadItem = {
  url: string
  destination: string
  label?: string
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

  await mkdir(path.dirname(item.destination), { recursive: true })
  const output = createWriteStream(item.destination)

  const expectedBytes = item.expectedSize ?? totalBytes
  const label = item.label ?? item.destination
  const hash = item.expectedMd5 ? createHash('md5') : undefined

  let written = 0
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error(`No response body for ${item.url}`)
  }

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

  return { bytesWritten: written, lastModified }
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
  showProgress: boolean
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = []

  for (const item of items) {
    const result = await downloadWithRetry(item, showProgress)
    results.push(result)
  }

  return results
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

export async function downloadLibrary({ client, config }: DownloadContext) {
  const cache = await loadCache(config.libraryPath)
  const purchaseKeys =
    config.purchaseKeys && config.purchaseKeys.length > 0
      ? config.purchaseKeys
      : parsePurchaseKeysFromLibraryPage(await client.getLibraryPage())

  if (purchaseKeys.length === 0 && !config.troveOnly) {
    throw new Error('Unable to determine purchase keys from the library page.')
  }

  const items: DownloadItem[] = []

  if (config.troveOnly) {
    const troveProducts = await client.getTroveProducts()
    items.push(
      ...(await buildTroveDownloadItems(troveProducts, config, cache, client.signTroveDownload))
    )
  } else {
    for (const orderId of purchaseKeys) {
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
            expectedSize: candidate.fileSize,
            expectedMd5: candidate.md5,
            cacheKey,
            cacheEntry,
          })
        }
      }
    }
  }

  const results = await downloadQueue(items, config.showProgress)

  for (const result of results) {
    const cacheKey = result.item.cacheKey
    if (!cacheKey || result.skipped) {
      continue
    }

    const cacheUpdate = result.item.cacheUpdate ?? {}
    const lastModified = result.lastModified ?? new Date().toUTCString()

    cache[cacheKey] = {
      ...cacheUpdate,
      urlLastModified: cacheUpdate.urlLastModified ?? lastModified,
    }
  }

  await saveCache(config.libraryPath, cache)

  return {
    processed: results.length,
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

export async function auditLibrary({ client, config }: DownloadContext) {
  const cache = await loadCache(config.libraryPath)
  const purchaseKeys =
    config.purchaseKeys && config.purchaseKeys.length > 0
      ? config.purchaseKeys
      : parsePurchaseKeysFromLibraryPage(await client.getLibraryPage())

  if (purchaseKeys.length === 0 && !config.troveOnly) {
    throw new Error('Unable to determine purchase keys from the library page.')
  }

  const now = new Date().toUTCString()

  if (config.troveOnly) {
    const troveProducts = await client.getTroveProducts()
    for (const product of troveProducts) {
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
        const uploadedAt = download.uploaded_at ?? download.timestamp ?? product.date_added ?? '0'
        const md5 = download.md5 ?? 'UNKNOWN_MD5'
        const localPath = path.join(productFolder, filename)

        await auditCacheEntry(cache, cacheKey, localPath, {
          uploadedAt,
          md5,
        })
      }
    }
  } else {
    for (const orderId of purchaseKeys) {
      const order = await client.getOrderDetails(orderId)
      const bundleTitle = order.product.human_name

      for (const product of order.subproducts) {
        const productFolder = buildProductFolder(
          config.libraryPath,
          bundleTitle,
          product.human_name
        )

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

              const cacheKey = `${orderId}:${filename}`
              const localPath = path.join(productFolder, filename)
              if (!(await fileExists(localPath))) {
                continue
              }
              const lastModified = config.offlineAudit
                ? undefined
                : await fetchLastModified(client, fileType.url.web)

              cache[cacheKey] = {
                urlLastModified: lastModified ?? now,
              }
              continue
            }

            if (fileType.asm_config) {
              const gameName = fileType.asm_config.display_item
              const asmFile = fileType.asm_manifest?.asmFile
              if (!gameName || !asmFile) {
                continue
              }

              const localFolder = path.join(productFolder, gameName)
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
                const localPath = path.join(localFolder, localFilename)
                if (!(await fileExists(localPath))) {
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
      }
    }
  }

  await saveCache(config.libraryPath, cache)
}
