import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { OrderResponse } from '../api/client'

export type MetadataDownload = {
  cacheKey: string
  filename: string
  extension: string
  platform: string
  fileSize?: number
  md5?: string
}

export type MetadataProduct = {
  productTitle: string
  downloads: MetadataDownload[]
}

export type MetadataOrder = {
  orderId: string
  bundleTitle: string
  products: MetadataProduct[]
  updatedAt: string
}

export type MetadataData = {
  version: 1
  updatedAt: string
  orders: Record<string, MetadataOrder>
}

const METADATA_FILE = '.metadata.json'

function emptyMetadata(): MetadataData {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    orders: {},
  }
}

function getFilenameFromUrl(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url
  const parts = withoutQuery.split('/')
  return parts.at(-1) ?? url
}

function getExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? ''
}

function normalizeMetadata(data: unknown): MetadataData {
  if (!data || typeof data !== 'object') {
    return emptyMetadata()
  }
  const metadata = data as Partial<MetadataData>
  if (metadata.version !== 1 || !metadata.orders || typeof metadata.orders !== 'object') {
    return emptyMetadata()
  }
  return {
    version: 1,
    updatedAt:
      typeof metadata.updatedAt === 'string' ? metadata.updatedAt : new Date().toISOString(),
    orders: metadata.orders as Record<string, MetadataOrder>,
  }
}

export function resolveMetadataPath(libraryPath: string, metadataPath?: string): string {
  return metadataPath ? path.resolve(metadataPath) : path.join(libraryPath, METADATA_FILE)
}

export async function loadMetadata(
  libraryPath: string,
  metadataPath?: string
): Promise<MetadataData> {
  try {
    const data = await readFile(resolveMetadataPath(libraryPath, metadataPath), 'utf8')
    return normalizeMetadata(JSON.parse(data))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return emptyMetadata()
    }
    return emptyMetadata()
  }
}

export async function saveMetadata(
  libraryPath: string,
  metadata: MetadataData,
  metadataPathOverride?: string
): Promise<void> {
  metadata.updatedAt = new Date().toISOString()
  const metadataPath = resolveMetadataPath(libraryPath, metadataPathOverride)
  const temporaryPath = `${metadataPath}.tmp`
  await mkdir(path.dirname(metadataPath), { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(metadata, undefined, 2)}\n`)
  try {
    await rename(temporaryPath, metadataPath)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      await copyFile(temporaryPath, metadataPath)
      await rm(temporaryPath, { force: true })
      return
    }
    throw error
  }
}

export function upsertOrderMetadata(
  metadata: MetadataData,
  orderId: string,
  order: OrderResponse
): void {
  const updatedAt = new Date().toISOString()
  metadata.updatedAt = updatedAt
  metadata.orders[orderId] = {
    orderId,
    bundleTitle: order.product.human_name,
    updatedAt,
    products: order.subproducts.map((product) => ({
      productTitle: product.human_name,
      downloads: product.downloads.flatMap((downloadType) =>
        downloadType.download_struct.flatMap((fileType) => {
          const url = fileType.url?.web
          if (!url) {
            return []
          }
          const filename = getFilenameFromUrl(url)
          return [
            {
              cacheKey: `${orderId}:${filename}`,
              filename,
              extension: getExtension(filename),
              platform: downloadType.platform,
              fileSize: fileType.file_size,
              md5: fileType.md5,
            },
          ]
        })
      ),
    })),
  }
}
