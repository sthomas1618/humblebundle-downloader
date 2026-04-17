import { afterEach, describe, expect, it } from 'bun:test'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ApiClient } from '../src/api/client'
import { resolveConfig } from '../src/config'
import { downloadLibrary, downloadQueue } from '../src/download/downloader'

describe('downloadQueue', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('retries failed downloads and writes the file', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const destination = path.join(temporaryDirectory, 'file.txt')
    let callCount = 0

    globalThis.fetch = async () => {
      callCount += 1
      if (callCount === 1) {
        return new Response('nope', { status: 500 })
      }
      return new Response('hello')
    }

    try {
      const results = await downloadQueue(
        [
          {
            url: 'https://example.com/file.txt',
            destination,
            label: 'file.txt',
          },
        ],
        false
      )

      expect(results).toHaveLength(1)
      expect(results[0]?.attempts).toBe(2)
      expect(results[0]?.bytesWritten).toBe(5)

      const contents = await readFile(destination, 'utf8')
      expect(contents).toBe('hello')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('continues after an item fails and leaves the final file untouched', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const badDestination = path.join(temporaryDirectory, 'bad.txt')
    const goodDestination = path.join(temporaryDirectory, 'good.txt')

    globalThis.fetch = async (input) => {
      if (String(input).includes('bad')) {
        return new Response('bad-content')
      }
      return new Response('good')
    }

    try {
      const results = await downloadQueue(
        [
          {
            url: 'https://example.com/bad.txt',
            destination: badDestination,
            label: 'bad.txt',
            expectedMd5: 'not-the-real-md5',
          },
          {
            url: 'https://example.com/good.txt',
            destination: goodDestination,
            label: 'good.txt',
          },
        ],
        false
      )

      expect(results).toHaveLength(2)
      expect(results[0]?.error).toContain('MD5 mismatch')
      expect(results[1]?.bytesWritten).toBe(4)

      const contents = await readFile(goodDestination, 'utf8')
      expect(contents).toBe('good')
      await expect(readFile(badDestination, 'utf8')).rejects.toThrow()
      await expect(readFile(`${badDestination}.part`, 'utf8')).rejects.toThrow()
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('reports each item result as it completes', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const destination = path.join(temporaryDirectory, 'file.txt')
    const seen: Array<{ index: number; total: number; bytesWritten: number }> = []

    globalThis.fetch = async () => new Response('hello')

    try {
      await downloadQueue(
        [
          {
            url: 'https://example.com/file.txt',
            destination,
            label: 'file.txt',
          },
        ],
        false,
        (result, index, total) => {
          seen.push({ index, total, bytesWritten: result.bytesWritten })
        }
      )

      expect(seen).toEqual([{ index: 1, total: 1, bytesWritten: 5 }])
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('writes a failure report without signed URLs', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const client: ApiClient = {
      session: {},
      fetchJson: async () => {
        throw new Error('Unexpected fetchJson call')
      },
      fetchText: async () => {
        throw new Error('Unexpected fetchText call')
      },
      getLibraryPage: async () => '',
      getOrderDetails: async () => ({
        product: {
          human_name: 'Bundle',
        },
        subproducts: [
          {
            human_name: 'Book',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [
                  {
                    url: {
                      web: 'https://example.com/signed/bad.cbz?token=secret',
                    },
                    md5: 'not-the-real-md5',
                  },
                ],
              },
            ],
          },
        ],
      }),
      getTroveProducts: async () => [],
      signTroveDownload: async () => ({}),
    }

    globalThis.fetch = async () => new Response('bad-content')

    try {
      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          libraryPath: temporaryDirectory,
          purchaseKeys: ['order-1'],
          extInclude: ['cbz'],
          formatPriority: ['cbz'],
        }),
      })

      expect(summary.failed).toBe(1)
      expect(summary.failureReportPath).toBe(
        path.join(temporaryDirectory, '.download-failures.json')
      )

      const report = JSON.parse(await readFile(summary.failureReportPath, 'utf8')) as {
        failed: number
        processed: number
        failures: Array<{
          label: string
          orderId?: string
          bundleTitle?: string
          productTitle?: string
          error: string
          url?: string
        }>
      }

      expect(report.failed).toBe(1)
      expect(report.processed).toBe(1)
      expect(report.failures[0]?.label).toBe('bad.cbz')
      expect(report.failures[0]?.orderId).toBe('order-1')
      expect(report.failures[0]?.bundleTitle).toBe('Bundle')
      expect(report.failures[0]?.productTitle).toBe('Book')
      expect(report.failures[0]?.error).toContain('MD5 mismatch')
      expect(report.failures[0]?.error).not.toContain('https://example.com')
      expect(report.failures[0]?.url).toBeUndefined()
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('creates the library path before writing the initial failure report', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const libraryPath = path.join(temporaryDirectory, 'new-library')
    const client: ApiClient = {
      session: {},
      fetchJson: async () => {
        throw new Error('Unexpected fetchJson call')
      },
      fetchText: async () => {
        throw new Error('Unexpected fetchText call')
      },
      getLibraryPage: async () => '',
      getOrderDetails: async () => ({
        product: {
          human_name: 'Bundle',
        },
        subproducts: [
          {
            human_name: 'Book',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [
                  {
                    url: {
                      web: 'https://example.com/book.cbz',
                    },
                    md5: 'not-the-real-md5',
                  },
                ],
              },
            ],
          },
        ],
      }),
      getTroveProducts: async () => [],
      signTroveDownload: async () => ({}),
    }

    globalThis.fetch = async () => new Response('bad-content')

    try {
      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          libraryPath,
          purchaseKeys: ['order-1'],
          extInclude: ['cbz'],
          formatPriority: ['cbz'],
        }),
      })

      expect(summary.failed).toBe(1)
      await access(path.join(libraryPath, '.download-failures.json'))
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
