import { afterEach, describe, expect, it } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ApiClient } from '../src/api/client'
import { resolveConfig } from '../src/config'
import { downloadLibrary, downloadQueue } from '../src/download/downloader'
import { buildProductFolder } from '../src/utils/fs'

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
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          libraryPath: temporaryDirectory,
          metadataPath,
          purchaseKeys: ['order-1'],
          extInclude: ['cbz'],
          formatPriority: ['cbz'],
        }),
      })

      expect(summary.failed).toBe(1)
      expect(summary.failureReportPath).toBe(
        path.join(temporaryDirectory, '.download-failures.json')
      )
      expect(summary.metadataOrders).toBe(1)
      expect(summary.metadataPath).toBe(metadataPath)

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

      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
        orders: Record<
          string,
          {
            products: Array<{
              downloads: Array<{
                cacheKey: string
                filename: string
                extension: string
                md5?: string
                url?: string
              }>
            }>
          }
        >
      }
      expect(metadata.orders['order-1']?.products[0]?.downloads[0]).toEqual({
        cacheKey: 'order-1:bad.cbz',
        filename: 'bad.cbz',
        extension: 'cbz',
        platform: 'ebook',
        md5: 'not-the-real-md5',
      })
      expect(JSON.stringify(metadata)).not.toContain('https://')
      expect(metadata.orders['order-1']?.products[0]?.downloads[0]?.url).toBeUndefined()
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

  it('uses configured library roots and writes the configured failure report path', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const comicsPath = path.join(temporaryDirectory, 'Comics')
    const booksPath = path.join(temporaryDirectory, 'Books')
    const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
    const failureReportPath = path.join(temporaryDirectory, '.hbd', 'download-failures.json')
    const existingBundle = path.join(comicsPath, 'Cross Folder Bundle')
    await mkdir(existingBundle, { recursive: true })
    await writeFile(path.join(existingBundle, 'story.cbz'), 'existing cbz')
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
          human_name: 'Cross Folder Bundle',
        },
        subproducts: [
          {
            human_name: 'Story',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [
                  {
                    url: {
                      web: 'https://example.com/story.pdf',
                    },
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

    globalThis.fetch = async () => {
      throw new Error('Download should have been skipped')
    }

    try {
      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          defaultLibrary: 'books',
          cachePath,
          failureReportPath,
          purchaseKeys: ['order-1'],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf'],
              extInclude: ['cbz', 'pdf'],
            },
            books: {
              path: booksPath,
              formatPriority: ['epub', 'pdf', 'mobi'],
              extInclude: ['epub', 'pdf', 'mobi'],
            },
          },
        }),
      })

      expect(summary.queued).toBe(0)
      expect(summary.locallySatisfied).toBe(1)
      expect(summary.failureReportPath).toBe(failureReportPath)
      await access(failureReportPath)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('routes configured extensions to their preferred library', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const comicsPath = path.join(temporaryDirectory, 'Comics')
    const booksPath = path.join(temporaryDirectory, 'Books')
    const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
    const failureReportPath = path.join(temporaryDirectory, '.hbd', 'download-failures.json')
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
          human_name: 'Book Bundle',
        },
        subproducts: [
          {
            human_name: 'Story',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [
                  {
                    url: {
                      web: 'https://example.com/story.pdf',
                    },
                  },
                  {
                    url: {
                      web: 'https://example.com/story.epub',
                    },
                  },
                  {
                    url: {
                      web: 'https://example.com/story.mobi',
                    },
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

    const downloadedUrls: string[] = []
    globalThis.fetch = async (input) => {
      downloadedUrls.push(String(input))
      return new Response('epub content')
    }

    try {
      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          defaultLibrary: 'comics',
          cachePath,
          failureReportPath,
          purchaseKeys: ['order-1'],
          routes: [{ extensions: ['epub', 'mobi'], library: 'books' }],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf'],
              extInclude: ['cbz', 'pdf'],
            },
            books: {
              path: booksPath,
              formatPriority: ['epub', 'pdf', 'mobi'],
              extInclude: ['epub', 'pdf', 'mobi'],
            },
          },
        }),
      })

      expect(summary.queued).toBe(1)
      expect(summary.downloaded).toBe(1)
      expect(downloadedUrls).toEqual(['https://example.com/story.epub'])
      expect(
        await readFile(path.join(booksPath, 'Book Bundle', 'Story', 'story.epub'), 'utf8')
      ).toBe('epub content')
      await expect(
        readFile(path.join(comicsPath, 'Book Bundle', 'Story', 'story.pdf'), 'utf8')
      ).rejects.toThrow()
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('lets bundle title routes outrank generic extension routes', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const comicsPath = path.join(temporaryDirectory, 'Comics')
    const booksPath = path.join(temporaryDirectory, 'Books')
    const mangaPath = path.join(temporaryDirectory, 'Manga')
    const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
    const failureReportPath = path.join(temporaryDirectory, '.hbd', 'download-failures.json')
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
          human_name: 'Humble Manga Bundle - Fantasy by Kodansha Comics',
        },
        subproducts: [
          {
            human_name: 'Flying Witch Vol. 1',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [
                  { url: { web: 'https://example.com/flyingwitch_vol1.epub' } },
                  { url: { web: 'https://example.com/flyingwitch_vol1.pdf' } },
                ],
              },
            ],
          },
        ],
      }),
      getTroveProducts: async () => [],
      signTroveDownload: async () => ({}),
    }

    const downloadedUrls: string[] = []
    globalThis.fetch = async (input) => {
      downloadedUrls.push(String(input))
      return new Response(String(input))
    }

    try {
      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          defaultLibrary: 'comics',
          cachePath,
          failureReportPath,
          purchaseKeys: ['order-1'],
          routes: [
            {
              id: 'manga-bundles',
              library: 'manga',
              bundleTitlePatterns: [String.raw`\bmanga\b`],
            },
            {
              id: 'ebook-formats',
              library: 'books',
              extensions: ['epub', 'mobi'],
            },
          ],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf'],
              extInclude: ['cbz', 'pdf'],
            },
            books: {
              path: booksPath,
              formatPriority: ['epub', 'pdf', 'mobi'],
              extInclude: ['epub', 'pdf', 'mobi'],
            },
            manga: {
              path: mangaPath,
              formatPriority: ['cbz', 'pdf'],
              extInclude: ['cbz', 'pdf'],
            },
          },
        }),
      })

      expect(summary.queued).toBe(1)
      expect(summary.downloaded).toBe(1)
      expect(downloadedUrls).toEqual(['https://example.com/flyingwitch_vol1.pdf'])
      await access(
        path.join(
          mangaPath,
          'Humble Manga Bundle - Fantasy by Kodansha Comics',
          'Flying Witch Vol. 1',
          'flyingwitch_vol1.pdf'
        )
      )
      await expect(
        access(
          path.join(
            booksPath,
            'Humble Manga Bundle - Fantasy by Kodansha Comics',
            'Flying Witch Vol. 1',
            'flyingwitch_vol1.epub'
          )
        )
      ).rejects.toThrow()
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('routes EPUB-only comic bundle products to comics as a fallback format', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const comicsPath = path.join(temporaryDirectory, 'Comics')
    const booksPath = path.join(temporaryDirectory, 'Books')
    const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
    const failureReportPath = path.join(temporaryDirectory, '.hbd', 'download-failures.json')
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
          human_name: "Humble Comics Bundle: Mike Mignola's B.P.R.D. by Dark Horse ENCORE",
        },
        subproducts: [
          {
            human_name: 'Hellboy: Odd Jobs',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [{ url: { web: 'https://example.com/hellboy_oddjobs.epub' } }],
              },
            ],
          },
        ],
      }),
      getTroveProducts: async () => [],
      signTroveDownload: async () => ({}),
    }

    globalThis.fetch = async () => new Response('epub content')

    try {
      const bundleTitle = "Humble Comics Bundle: Mike Mignola's B.P.R.D. by Dark Horse ENCORE"
      const productTitle = 'Hellboy: Odd Jobs'
      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          defaultLibrary: 'books',
          cachePath,
          failureReportPath,
          purchaseKeys: ['order-1'],
          routes: [
            {
              id: 'comic-bundles',
              library: 'comics',
              bundleTitlePatterns: [String.raw`\bcomics?\s+bundle\b`],
            },
            {
              id: 'ebook-formats',
              library: 'books',
              extensions: ['epub', 'mobi'],
            },
          ],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf', 'epub', 'mobi'],
              extInclude: ['cbz', 'pdf', 'epub', 'mobi'],
            },
            books: {
              path: booksPath,
              formatPriority: ['epub', 'pdf', 'mobi'],
              extInclude: ['epub', 'pdf', 'mobi'],
            },
          },
        }),
      })

      expect(summary.queued).toBe(1)
      expect(summary.downloaded).toBe(1)
      expect(
        await readFile(
          path.join(
            buildProductFolder(comicsPath, bundleTitle, productTitle),
            'hellboy_oddjobs.epub'
          ),
          'utf8'
        )
      ).toBe('epub content')
      await expect(
        access(
          path.join(
            buildProductFolder(booksPath, bundleTitle, productTitle),
            'hellboy_oddjobs.epub'
          )
        )
      ).rejects.toThrow()
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('routes CBZ files in book bundles to comics even when books is the default library', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const comicsPath = path.join(temporaryDirectory, 'Comics')
    const booksPath = path.join(temporaryDirectory, 'Books')
    const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
    const failureReportPath = path.join(temporaryDirectory, '.hbd', 'download-failures.json')
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
          human_name: 'Humble Book Bundle: Geek Gals',
        },
        subproducts: [
          {
            human_name: 'Paper Girls Vol. 1',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [{ url: { web: 'https://example.com/papergirls_vol1.cbz' } }],
              },
            ],
          },
        ],
      }),
      getTroveProducts: async () => [],
      signTroveDownload: async () => ({}),
    }

    globalThis.fetch = async () => new Response('cbz content')

    try {
      const bundleTitle = 'Humble Book Bundle: Geek Gals'
      const productTitle = 'Paper Girls Vol. 1'
      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          defaultLibrary: 'books',
          cachePath,
          failureReportPath,
          purchaseKeys: ['order-1'],
          routes: [
            {
              id: 'comic-formats',
              library: 'comics',
              extensions: ['cbz'],
            },
            {
              id: 'book-bundles',
              library: 'books',
              bundleTitlePatterns: [String.raw`\b(?:book bundle|ebooks?|e-books?|novels?)\b`],
            },
          ],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf', 'epub', 'mobi'],
              extInclude: ['cbz', 'pdf', 'epub', 'mobi'],
            },
            books: {
              path: booksPath,
              formatPriority: ['epub', 'pdf', 'mobi'],
              extInclude: ['epub', 'pdf', 'mobi'],
            },
          },
        }),
      })

      expect(summary.queued).toBe(1)
      expect(summary.downloaded).toBe(1)
      expect(
        await readFile(
          path.join(
            buildProductFolder(comicsPath, bundleTitle, productTitle),
            'papergirls_vol1.cbz'
          ),
          'utf8'
        )
      ).toBe('cbz content')
      await expect(
        access(
          path.join(buildProductFolder(booksPath, bundleTitle, productTitle), 'papergirls_vol1.cbz')
        )
      ).rejects.toThrow()
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('lets earlier bundle routes win over later product hints', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const comicsPath = path.join(temporaryDirectory, 'Comics')
    const booksPath = path.join(temporaryDirectory, 'Books')
    const mangaPath = path.join(temporaryDirectory, 'Manga')
    const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
    const failureReportPath = path.join(temporaryDirectory, '.hbd', 'download-failures.json')
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
          human_name: 'Humble Manga Bundle - Mixed Stories',
        },
        subproducts: [
          {
            human_name: 'Space Novel',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [
                  { url: { web: 'https://example.com/space-novel.pdf' } },
                  { url: { web: 'https://example.com/space-novel.epub' } },
                ],
              },
            ],
          },
          {
            human_name: 'Robot Manga Vol 1',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [
                  { url: { web: 'https://example.com/robot-manga-vol1.pdf' } },
                  { url: { web: 'https://example.com/robot-manga-vol1.cbz' } },
                ],
              },
            ],
          },
          {
            human_name: 'Cookbook Guide',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [{ url: { web: 'https://example.com/cookbook.pdf' } }],
              },
            ],
          },
        ],
      }),
      getTroveProducts: async () => [],
      signTroveDownload: async () => ({}),
    }

    const downloadedUrls: string[] = []
    globalThis.fetch = async (input) => {
      downloadedUrls.push(String(input))
      return new Response(String(input))
    }

    try {
      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          defaultLibrary: 'comics',
          cachePath,
          failureReportPath,
          purchaseKeys: ['order-1'],
          routes: [
            {
              id: 'manga-products',
              library: 'manga',
              productTitlePatterns: [String.raw`\bmanga\b`],
              filenamePatterns: [String.raw`\bmanga\b`],
            },
            {
              id: 'manga-bundles',
              library: 'manga',
              bundleTitlePatterns: [String.raw`\bmanga\b`],
            },
            {
              id: 'book-products',
              library: 'books',
              productTitlePatterns: [String.raw`\b(?:novel|guide|book)\b`],
              filenamePatterns: [String.raw`\b(?:novel|guide|book)\b`],
            },
            {
              id: 'ebook-formats',
              library: 'books',
              extensions: ['epub', 'mobi'],
            },
          ],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf'],
              extInclude: ['cbz', 'pdf'],
            },
            books: {
              path: booksPath,
              formatPriority: ['epub', 'pdf', 'mobi'],
              extInclude: ['epub', 'pdf', 'mobi'],
            },
            manga: {
              path: mangaPath,
              formatPriority: ['cbz', 'pdf'],
              extInclude: ['cbz', 'pdf'],
            },
          },
        }),
      })

      expect(summary.queued).toBe(3)
      expect(summary.downloaded).toBe(3)
      expect(downloadedUrls).toEqual([
        'https://example.com/space-novel.pdf',
        'https://example.com/robot-manga-vol1.cbz',
        'https://example.com/cookbook.pdf',
      ])
      await access(
        path.join(
          mangaPath,
          'Humble Manga Bundle - Mixed Stories',
          'Robot Manga Vol 1',
          'robot-manga-vol1.cbz'
        )
      )
      await access(
        path.join(
          mangaPath,
          'Humble Manga Bundle - Mixed Stories',
          'Space Novel',
          'space-novel.pdf'
        )
      )
      await access(
        path.join(
          mangaPath,
          'Humble Manga Bundle - Mixed Stories',
          'Cookbook Guide',
          'cookbook.pdf'
        )
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('uses additional scan paths and a shared cache to avoid cross-folder downloads', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const libraryPath = path.join(temporaryDirectory, 'Comics')
    const scanPath = path.join(temporaryDirectory, 'Manga')
    const cachePath = path.join(temporaryDirectory, '.hbd-cache.json')
    const existingBundle = path.join(scanPath, 'Cross Folder Bundle')
    await mkdir(existingBundle, { recursive: true })
    await writeFile(path.join(existingBundle, 'story.cbz'), 'existing cbz')
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
          human_name: 'Cross Folder Bundle',
        },
        subproducts: [
          {
            human_name: 'Story',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [
                  {
                    url: {
                      web: 'https://example.com/story.pdf',
                    },
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

    globalThis.fetch = async () => {
      throw new Error('Download should have been skipped')
    }

    try {
      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          libraryPath,
          scanPaths: [scanPath],
          cachePath,
          purchaseKeys: ['order-1'],
          extInclude: ['cbz', 'pdf'],
          formatPriority: ['cbz', 'pdf'],
        }),
      })

      expect(summary.queued).toBe(0)
      expect(summary.downloaded).toBe(0)
      expect(summary.locallySatisfied).toBe(1)

      const cache = JSON.parse(await readFile(cachePath, 'utf8')) as
        | Record<string, unknown>
        | undefined
      expect(cache?.['order-1:story.pdf']).toEqual({
        urlLastModified: expect.any(String),
      })
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('downloads flat libraries into publisher series folders and dedupes repeated products', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const comicsPath = path.join(temporaryDirectory, 'Comics')
    const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
    const failureReportPath = path.join(temporaryDirectory, '.hbd', 'download-failures.json')
    const client: ApiClient = {
      session: {},
      fetchJson: async () => {
        throw new Error('Unexpected fetchJson call')
      },
      fetchText: async () => {
        throw new Error('Unexpected fetchText call')
      },
      getLibraryPage: async () => '',
      getOrderDetails: async (orderId) => ({
        product: {
          human_name:
            orderId === 'order-1'
              ? 'Humble Comics Bundle: Saga by Image Comics'
              : 'Humble Conquer COVID-19 Bundle',
        },
        subproducts: [
          {
            human_name: 'Saga Vol. 1',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [
                  {
                    url: {
                      web: 'https://example.com/files/saga_vol1.cbz',
                    },
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
    let fetchCount = 0
    globalThis.fetch = async () => {
      fetchCount += 1
      return new Response('cbz content')
    }

    try {
      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          defaultLibrary: 'comics',
          cachePath,
          failureReportPath,
          purchaseKeys: ['order-1', 'order-2'],
          libraries: {
            comics: {
              path: comicsPath,
              layout: 'flat',
              extInclude: ['cbz'],
              formatPriority: ['cbz'],
            },
          },
        }),
      })

      expect(summary.queued).toBe(1)
      expect(summary.downloaded).toBe(1)
      expect(fetchCount).toBe(1)
      expect(
        await readFile(path.join(comicsPath, 'Image Comics', 'Saga', 'saga_vol1.cbz'), 'utf8')
      ).toBe('cbz content')
      const cache = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>
      expect(cache['order-1:saga_vol1.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache['order-2:saga_vol1.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache['flat:comics:saga_vol_1:saga_vol1.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache.flatIndex).toMatchObject({
        version: 1,
        entries: {
          'flat:comics:saga_vol_1:saga_vol1.cbz': {
            canonicalPath: path.join(comicsPath, 'Image Comics', 'Saga', 'saga_vol1.cbz'),
            publisher: 'Image Comics',
            series: 'Saga',
            productTitle: 'Saga Vol. 1',
            filename: 'saga_vol1.cbz',
            bundleLocations: [
              {
                cacheKey: 'order-1:saga_vol1.cbz',
                bundlePath: path.join(
                  comicsPath,
                  'Humble Comics Bundle - Saga by Image Comics',
                  'Saga Vol. 1',
                  'saga_vol1.cbz'
                ),
              },
              {
                cacheKey: 'order-2:saga_vol1.cbz',
                bundlePath: path.join(
                  comicsPath,
                  'Humble Conquer COVID-19 Bundle',
                  'Saga Vol. 1',
                  'saga_vol1.cbz'
                ),
              },
            ],
          },
        },
      })
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('reuses existing publisher family folders for flat downloads', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const comicsPath = path.join(temporaryDirectory, 'Comics')
    const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
    const failureReportPath = path.join(temporaryDirectory, '.hbd', 'download-failures.json')
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
          human_name: 'Humble Comics Bundle: Star Trek 2019 by IDW Publishing',
        },
        subproducts: [
          {
            human_name: 'Star Trek Vol. 1',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [
                  {
                    url: {
                      web: 'https://example.com/files/startrek_vol1.cbz',
                    },
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
    globalThis.fetch = async () => new Response('cbz content')

    try {
      await mkdir(path.join(comicsPath, 'IDW'), { recursive: true })

      await downloadLibrary({
        client,
        config: resolveConfig({
          defaultLibrary: 'comics',
          cachePath,
          failureReportPath,
          purchaseKeys: ['order-1'],
          libraries: {
            comics: {
              path: comicsPath,
              layout: 'flat',
              extInclude: ['cbz'],
              formatPriority: ['cbz'],
            },
          },
        }),
      })

      expect(
        await readFile(path.join(comicsPath, 'IDW', 'Star Trek', 'startrek_vol1.cbz'), 'utf8')
      ).toBe('cbz content')
      await expect(
        access(path.join(comicsPath, 'IDW Publishing', 'Star Trek', 'startrek_vol1.cbz'))
      ).rejects.toThrow()
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('backfills flat cache keys when an order-specific cache hit satisfies flat duplicates', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const comicsPath = path.join(temporaryDirectory, 'Comics')
    const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
    const failureReportPath = path.join(temporaryDirectory, '.hbd', 'download-failures.json')
    const client: ApiClient = {
      session: {},
      fetchJson: async () => {
        throw new Error('Unexpected fetchJson call')
      },
      fetchText: async () => {
        throw new Error('Unexpected fetchText call')
      },
      getLibraryPage: async () => '',
      getOrderDetails: async (orderId) => ({
        product: {
          human_name:
            orderId === 'order-1'
              ? 'Humble Comics Bundle: Saga by Image Comics'
              : 'Humble Conquer COVID-19 Bundle',
        },
        subproducts: [
          {
            human_name: 'Saga Vol. 1',
            downloads: [
              {
                platform: 'ebook',
                download_struct: [
                  {
                    url: {
                      web: 'https://example.com/files/saga_vol1.cbz',
                    },
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
    let fetchCount = 0
    globalThis.fetch = async () => {
      fetchCount += 1
      return new Response('cbz content')
    }

    try {
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(
        cachePath,
        `${JSON.stringify({
          'order-1:saga_vol1.cbz': { urlLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
        })}\n`
      )

      const summary = await downloadLibrary({
        client,
        config: resolveConfig({
          defaultLibrary: 'comics',
          cachePath,
          failureReportPath,
          purchaseKeys: ['order-1', 'order-2'],
          libraries: {
            comics: {
              path: comicsPath,
              layout: 'flat',
              extInclude: ['cbz'],
              formatPriority: ['cbz'],
            },
          },
        }),
      })

      expect(summary.queued).toBe(0)
      expect(summary.downloaded).toBe(0)
      expect(fetchCount).toBe(0)
      const cache = JSON.parse(await readFile(cachePath, 'utf8')) as Record<string, unknown>
      expect(cache['order-2:saga_vol1.cbz']).toEqual({
        urlLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      })
      expect(cache['flat:comics:saga_vol_1:saga_vol1.cbz']).toEqual({
        urlLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
      })
      expect(cache.flatIndex).toMatchObject({
        entries: {
          'flat:comics:saga_vol_1:saga_vol1.cbz': {
            canonicalPath: path.join(comicsPath, 'Image Comics', 'Saga', 'saga_vol1.cbz'),
            bundleLocations: [
              {
                cacheKey: 'order-1:saga_vol1.cbz',
              },
              {
                cacheKey: 'order-2:saga_vol1.cbz',
              },
            ],
          },
        },
      })
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
