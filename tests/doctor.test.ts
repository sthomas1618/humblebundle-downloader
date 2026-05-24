import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ApiClient } from '../src/api/client'
import { resolveConfig } from '../src/config'
import { runDoctor } from '../src/doctor/doctor'

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-doctor-'))
  try {
    return await callback(temporaryDirectory)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function createLibraryPage(...keys: string[]): string {
  return `<script id="user-home-json-data" type="application/json">${JSON.stringify({
    gamekeys: keys,
  })}</script>`
}

describe('runDoctor', () => {
  it('checks local config, cache, legacy caches, and failure reports', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const booksPath = path.join(temporaryDirectory, 'Books')
      const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
      const failureReportPath = path.join(temporaryDirectory, '.hbd', 'download-failures.json')
      await mkdir(comicsPath, { recursive: true })
      await mkdir(booksPath, { recursive: true })
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(
        cachePath,
        JSON.stringify({
          'order-1:story.cbz': { urlLastModified: 'today' },
          'order-1:bad.cbz': 1,
          transforms: {
            pdf: {
              cbz: {
                version: 1,
                entries: {
                  'comic.pdf': {
                    pdfMtimeMs: 1,
                    pdfSize: 2,
                    cbzPath: 'comic.cbz',
                    lastGeneratedMs: 3,
                  },
                },
              },
            },
          },
        })
      )
      await writeFile(path.join(comicsPath, '.cache.json'), '{}')
      await writeFile(
        failureReportPath,
        JSON.stringify({
          failed: 1,
          failures: [{ label: 'bad.cbz' }],
        })
      )

      const report = await runDoctor({
        config: resolveConfig({
          defaultLibrary: 'comics',
          cachePath,
          failureReportPath,
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

      expect(report.cache).toMatchObject({
        cacheExists: true,
        cacheEntries: 2,
        transformEntries: 1,
        transformArchiveConflicts: 0,
        invalidTransformEntries: [],
        invalidEntries: ['order-1:bad.cbz'],
        legacyCachePaths: [path.join(comicsPath, '.cache.json')],
        failureReportExists: true,
        failureCount: 1,
      })
      expect(report.checks.some((check) => check.message.includes('Invalid cache entry'))).toBe(
        true
      )
      expect(report.checks.some((check) => check.message.includes('Legacy per-library'))).toBe(true)
    })
  })

  it('deep-validates cache entries against Humble metadata and local files', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const booksPath = path.join(temporaryDirectory, 'Books')
      const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
      const failureReportPath = path.join(temporaryDirectory, '.hbd', 'download-failures.json')
      await mkdir(booksPath, { recursive: true })
      await mkdir(path.join(comicsPath, 'Bundle', 'Local'), { recursive: true })
      await mkdir(path.join(comicsPath, 'Bundle', 'Novel'), { recursive: true })
      await mkdir(path.join(comicsPath, 'Bundle', 'Small'), { recursive: true })
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(path.join(comicsPath, 'Bundle', 'Local', 'local.cbz'), 'local')
      await writeFile(path.join(comicsPath, 'Bundle', 'Novel', 'novel.epub'), 'epub')
      await writeFile(path.join(comicsPath, 'Bundle', 'Small', 'small.cbz'), 'tiny')
      await writeFile(
        cachePath,
        JSON.stringify({
          'order-1:missing.cbz': { urlLastModified: 'today' },
          'order-1:old.cbz': { urlLastModified: 'yesterday' },
        })
      )

      const client: ApiClient = {
        session: {},
        fetchJson: async () => {
          throw new Error('Unexpected fetchJson call')
        },
        fetchText: async () => {
          throw new Error('Unexpected fetchText call')
        },
        getLibraryPage: async () => createLibraryPage('order-1'),
        getOrderDetails: async () => ({
          product: { human_name: 'Bundle' },
          subproducts: [
            {
              human_name: 'Missing',
              downloads: [
                {
                  platform: 'ebook',
                  download_struct: [{ url: { web: 'https://example.com/missing.cbz' } }],
                },
              ],
            },
            {
              human_name: 'Local',
              downloads: [
                {
                  platform: 'ebook',
                  download_struct: [{ url: { web: 'https://example.com/local.cbz' } }],
                },
              ],
            },
            {
              human_name: 'Novel',
              downloads: [
                {
                  platform: 'ebook',
                  download_struct: [{ url: { web: 'https://example.com/novel.epub' } }],
                },
              ],
            },
            {
              human_name: 'Small',
              downloads: [
                {
                  platform: 'ebook',
                  download_struct: [
                    {
                      url: { web: 'https://example.com/small.cbz' },
                      file_size: 99,
                    },
                  ],
                },
              ],
            },
            {
              human_name: 'New',
              downloads: [
                {
                  platform: 'ebook',
                  download_struct: [{ url: { web: 'https://example.com/new.cbz' } }],
                },
              ],
            },
          ],
        }),
        getTroveProducts: async () => [],
        signTroveDownload: async () => ({}),
      }

      const report = await runDoctor({
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
        client,
        deep: true,
      })

      expect(report.deepCache).toMatchObject({
        selectedCandidates: 5,
        cachedButMissing: [{ cacheKey: 'order-1:missing.cbz' }],
        localButUncached: [
          { cacheKey: 'order-1:local.cbz' },
          { cacheKey: 'order-1:novel.epub' },
          { cacheKey: 'order-1:small.cbz' },
        ],
        wrongLibrary: [{ cacheKey: 'order-1:novel.epub' }],
        sizeMismatches: [{ cacheKey: 'order-1:small.cbz', actualSize: 4, expectedSize: 99 }],
        notDownloadedYet: [{ cacheKey: 'order-1:new.cbz' }],
        orphanCacheEntries: [{ cacheKey: 'order-1:old.cbz' }],
      })
      expect(
        await readFile(path.join(temporaryDirectory, '.hbd', 'doctor-report.json'), 'utf8')
      ).toContain('cachedButMissing')
    })
  })

  it('reports route-order-resolved decisions during deep validation', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const mangaPath = path.join(temporaryDirectory, 'Manga')
      const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
      await mkdir(booksPath, { recursive: true })
      await mkdir(mangaPath, { recursive: true })
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(cachePath, '{}')

      const client: ApiClient = {
        session: {},
        fetchJson: async () => {
          throw new Error('Unexpected fetchJson call')
        },
        fetchText: async () => {
          throw new Error('Unexpected fetchText call')
        },
        getLibraryPage: async () => createLibraryPage('order-1'),
        getOrderDetails: async () => ({
          product: { human_name: 'Mega Bundle' },
          subproducts: [
            {
              human_name: 'Book Manga Guide',
              downloads: [
                {
                  platform: 'ebook',
                  download_struct: [{ url: { web: 'https://example.com/book-manga.pdf' } }],
                },
              ],
            },
          ],
        }),
        getTroveProducts: async () => [],
        signTroveDownload: async () => ({}),
      }

      const report = await runDoctor({
        config: resolveConfig({
          defaultLibrary: 'books',
          cachePath,
          purchaseKeys: ['order-1'],
          routes: [
            {
              id: 'books',
              library: 'books',
              productTitlePatterns: [String.raw`\bbook\b`],
            },
            {
              id: 'manga',
              library: 'manga',
              productTitlePatterns: [String.raw`\bmanga\b`],
            },
          ],
          libraries: {
            books: {
              path: booksPath,
              formatPriority: ['pdf'],
              extInclude: ['pdf'],
            },
            manga: {
              path: mangaPath,
              formatPriority: ['pdf'],
              extInclude: ['pdf'],
            },
          },
        }),
        client,
        deep: true,
      })

      expect(report.deepCache?.routing.ambiguous).toEqual([])
      expect(report.deepCache?.routing.libraryCounts).toEqual({ books: 1 })
      expect(report.deepCache?.routing.routeCounts).toEqual({ books: 1 })
      expect(
        report.checks.some((check) => check.message.includes('Ambiguous routing decisions: 1'))
      ).toBe(false)
    })
  })

  it('treats expected archive alternates as in-place during deep validation', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const mediaRoot = path.join(temporaryDirectory, 'Media')
      const comicsPath = path.join(mediaRoot, 'Comics')
      const archiveRoot = path.join(temporaryDirectory, 'Archive')
      const archiveFolder = path.join(
        archiveRoot,
        'Comics',
        'Humble Comics Bundle - Example',
        'Issue 1'
      )
      const cachePath = path.join(mediaRoot, '.hbd', 'cache.json')
      await mkdir(archiveFolder, { recursive: true })
      await writeFile(path.join(archiveFolder, 'issue.pdf'), 'pdf')
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(
        cachePath,
        `${JSON.stringify({
          'archive:order-1:issue.pdf': { urlLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT' },
        })}\n`
      )

      const client: ApiClient = {
        session: {},
        fetchJson: async () => {
          throw new Error('Unexpected fetchJson call')
        },
        fetchText: async () => {
          throw new Error('Unexpected fetchText call')
        },
        getLibraryPage: async () => createLibraryPage('order-1'),
        getOrderDetails: async () => ({
          product: { human_name: 'Humble Comics Bundle: Example' },
          subproducts: [
            {
              human_name: 'Issue 1',
              downloads: [
                {
                  platform: 'ebook',
                  download_struct: [
                    { url: { web: 'https://example.com/issue.cbz' } },
                    { url: { web: 'https://example.com/issue.pdf' } },
                  ],
                },
              ],
            },
          ],
        }),
        getTroveProducts: async () => [],
        signTroveDownload: async () => ({}),
      }

      const report = await runDoctor({
        config: resolveConfig({
          mediaRoot,
          archiveRoot,
          defaultLibrary: 'comics',
          cachePath,
          purchaseKeys: ['order-1'],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz'],
              archiveFormats: ['pdf'],
              extInclude: ['cbz', 'pdf'],
            },
          },
        }),
        client,
        deep: true,
      })

      expect(report.deepCache?.wrongLibrary).toEqual([])
      expect(report.deepCache?.cachedButMissing).toEqual([])
      expect(report.deepCache?.localButUncached).toEqual([])
      expect(report.deepCache?.orphanCacheEntries).toEqual([])
    })
  })

  it('treats generated CBZ transforms as satisfying source PDF candidates', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const cachePath = path.join(temporaryDirectory, '.hbd', 'cache.json')
      const cbzPath = path.join(comicsPath, 'Bundle', 'Issue', 'issue.cbz')
      await mkdir(path.dirname(cbzPath), { recursive: true })
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(cbzPath, 'generated cbz')
      await writeFile(
        cachePath,
        JSON.stringify({
          transforms: {
            pdf: {
              cbz: {
                version: 1,
                entries: {
                  [path.join('Bundle', 'Issue', 'issue.pdf')]: {
                    version: 1,
                    libraryName: 'comics',
                    libraryPath: comicsPath,
                    pdfKey: path.join('Bundle', 'Issue', 'issue.pdf'),
                    pdfOriginalPath: path.join(comicsPath, 'Bundle', 'Issue', 'issue.pdf'),
                    pdfMtimeMs: 1,
                    pdfSize: 100,
                    cbzPath,
                    cbzMtimeMs: 2,
                    cbzSize: 13,
                    archiveStatus: 'moved',
                    archivePdfPath: path.join(
                      temporaryDirectory,
                      'Archive',
                      'Comics',
                      'Bundle',
                      'Issue',
                      'issue.pdf'
                    ),
                    lastGeneratedMs: 3,
                  },
                },
              },
            },
          },
        })
      )

      const client: ApiClient = {
        session: {},
        fetchJson: async () => {
          throw new Error('Unexpected fetchJson call')
        },
        fetchText: async () => {
          throw new Error('Unexpected fetchText call')
        },
        getLibraryPage: async () => createLibraryPage('order-1'),
        getOrderDetails: async () => ({
          product: { human_name: 'Bundle' },
          subproducts: [
            {
              human_name: 'Issue',
              downloads: [
                {
                  platform: 'ebook',
                  download_struct: [
                    {
                      url: { web: 'https://example.com/issue.pdf' },
                      file_size: 100,
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

      const report = await runDoctor({
        config: resolveConfig({
          defaultLibrary: 'comics',
          cachePath,
          purchaseKeys: ['order-1'],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf'],
              extInclude: ['cbz', 'pdf'],
            },
          },
        }),
        client,
        deep: true,
      })

      expect(report.deepCache?.localButUncached).toEqual([])
      expect(report.deepCache?.sizeMismatches).toEqual([])
      expect(report.deepCache?.notDownloadedYet).toEqual([])
    })
  })
})
