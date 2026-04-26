import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import type { ApiClient } from '../src/api/client'
import { resolveConfig } from '../src/config'
import { auditLibrary } from '../src/download/downloader'
import { buildProductFolder } from '../src/utils/fs'

function createClient(
  bundleTitle = 'Bundle:Name',
  filenames = ['bundle-level.cbz', 'root-level.cbz']
): ApiClient {
  return {
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
        human_name: bundleTitle,
      },
      subproducts: filenames.map((filename, index) => ({
        human_name: `Product ${index + 1}`,
        downloads: [
          {
            platform: 'ebook',
            download_struct: [
              {
                url: {
                  web: `https://example.com/files/${filename}`,
                },
              },
            ],
          },
        ],
      })),
    }),
    getTroveProducts: async () => [],
    signTroveDownload: async () => ({}),
  }
}

function createSingleProductClient(bundleTitle: string, filenames: string[]): ApiClient {
  return {
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
        human_name: bundleTitle,
      },
      subproducts: [
        {
          human_name: 'Product',
          downloads: [
            {
              platform: 'ebook',
              download_struct: filenames.map((filename) => ({
                url: {
                  web: `https://example.com/files/${filename}`,
                },
              })),
            },
          ],
        },
      ],
    }),
    getTroveProducts: async () => [],
    signTroveDownload: async () => ({}),
  }
}

describe('auditLibrary layout detection', () => {
  it('seeds cache from bundle-level and root-level files when product folders are absent', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const bundleFolder = path.join(temporaryRoot, 'Bundle -Name')
      await mkdir(bundleFolder)
      await writeFile(path.join(bundleFolder, 'bundle-level.cbz'), 'bundle file')
      await writeFile(path.join(temporaryRoot, 'root-level.cbz'), 'root file')

      await auditLibrary({
        client: createClient(),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:bundle-level.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache?.['order-1:root-level.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('matches existing bundle folders by normalized name', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const bundleFolder = path.join(temporaryRoot, "BACK TO THE '80S BY IDW")
      await mkdir(bundleFolder)
      await writeFile(path.join(bundleFolder, 'apostrophe-folder.cbz'), 'bundle file')

      await auditLibrary({
        client: createClient("Back to the '80s by IDW", ['apostrophe-folder.cbz']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:apostrophe-folder.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('matches existing bundle folders by similar legacy title', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const bundleFolder = path.join(temporaryRoot, 'MICROIDS GAMES & COMICS CROSSOVER COLLECTION')
      await mkdir(bundleFolder)
      await writeFile(path.join(bundleFolder, 'spellbound1.epub'), 'bundle file')

      await auditLibrary({
        client: createClient('Microids: Games & Comics Crossover Collection', ['spellbound1.epub']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:spellbound1.epub']).toEqual({
        urlLastModified: expect.any(String),
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('does not use similar bundle title matching when multiple folders match', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const firstFolder = path.join(temporaryRoot, 'MICROIDS')
      const secondFolder = path.join(temporaryRoot, 'MICROIDS GAMES & COMICS CROSSOVER COLLECTION')
      await mkdir(firstFolder)
      await mkdir(secondFolder)
      await writeFile(path.join(firstFolder, 'spellbound1.epub'), 'bundle file')
      await writeFile(path.join(secondFolder, 'spellbound1.epub'), 'bundle file')

      await auditLibrary({
        client: createClient('Microids: Games & Comics Crossover Collection', ['spellbound1.epub']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:spellbound1.epub']).toBeUndefined()
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('infers a bundle folder from multiple matching filenames', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const legacyFolder = path.join(temporaryRoot, 'legacy', 'custom-layout')
      await mkdir(legacyFolder, { recursive: true })
      await writeFile(path.join(legacyFolder, 'first.cbz'), 'legacy file')
      await writeFile(path.join(legacyFolder, 'second.cbz'), 'legacy file')

      await auditLibrary({
        client: createClient('Unmatched Bundle Name', ['first.cbz', 'second.cbz']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:first.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache?.['order-1:second.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('matches existing flat library files and writes synthetic flat cache entries', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const flatFile = path.join(temporaryRoot, 'Image Comics', 'Saga', 'saga_vol1.cbz')
      await mkdir(path.dirname(flatFile), { recursive: true })
      await writeFile(flatFile, 'flat file')

      await auditLibrary({
        client: {
          ...createSingleProductClient('Humble Comics Bundle: Saga by Image Comics', [
            'saga_vol1.cbz',
          ]),
          getOrderDetails: async () => ({
            product: {
              human_name: 'Humble Comics Bundle: Saga by Image Comics',
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
        },
        config: resolveConfig({
          defaultLibrary: 'comics',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
          libraries: {
            comics: {
              path: temporaryRoot,
              layout: 'flat',
              extInclude: ['cbz'],
              formatPriority: ['cbz'],
            },
          },
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:saga_vol1.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache?.['flat:comics:saga_vol_1:saga_vol1.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache?.flatIndex?.entries['flat:comics:saga_vol_1:saga_vol1.cbz']).toMatchObject({
        canonicalPath: flatFile,
        publisher: 'Image Comics',
        series: 'Saga',
        productTitle: 'Saga Vol. 1',
        filename: 'saga_vol1.cbz',
        bundleLocations: [
          {
            cacheKey: 'order-1:saga_vol1.cbz',
            orderId: 'order-1',
            bundleTitle: 'Humble Comics Bundle: Saga by Image Comics',
            productTitle: 'Saga Vol. 1',
            bundlePath: path.join(
              temporaryRoot,
              'Humble Comics Bundle - Saga by Image Comics',
              'Saga Vol. 1',
              'saga_vol1.cbz'
            ),
          },
        ],
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('does not infer a non-Humble folder from a single filename match', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const nonHumbleFolder = path.join(temporaryRoot, 'other-source')
      await mkdir(nonHumbleFolder)
      await writeFile(path.join(nonHumbleFolder, 'coincidence.cbz'), 'unrelated file')

      await auditLibrary({
        client: createClient('Unmatched Bundle Name', ['coincidence.cbz']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:coincidence.cbz']).toBeUndefined()
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('still matches files stored directly in the library root', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      await writeFile(path.join(temporaryRoot, 'root-only.cbz'), 'root file')

      await auditLibrary({
        client: createClient('Unmatched Bundle Name', ['root-only.cbz']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:root-only.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('seeds cache from files in additional scan roots', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const libraryPath = path.join(temporaryRoot, 'Comics')
      const scanPath = path.join(temporaryRoot, 'Books')
      const bundleFolder = path.join(scanPath, 'Cross Folder Bundle')
      await mkdir(bundleFolder, { recursive: true })
      await writeFile(path.join(bundleFolder, 'story.cbz'), 'scan file')

      const summary = await auditLibrary({
        client: createSingleProductClient('Cross Folder Bundle', ['story.cbz']),
        config: resolveConfig({
          libraryPath,
          scanPaths: [scanPath],
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(libraryPath, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:story.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(summary.matchedFiles).toBe(1)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('audits routed configured libraries with their own preferred formats', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const comicsPath = path.join(temporaryRoot, 'Comics')
      const booksPath = path.join(temporaryRoot, 'Books')
      const bundleFolder = path.join(booksPath, 'Book Bundle')
      const cachePath = path.join(temporaryRoot, '.hbd', 'cache.json')
      await mkdir(bundleFolder, { recursive: true })
      await writeFile(path.join(bundleFolder, 'novel.epub'), 'epub file')

      await auditLibrary({
        client: createSingleProductClient('Book Bundle', ['novel.epub', 'novel.pdf']),
        config: resolveConfig({
          defaultLibrary: 'comics',
          cachePath,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
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

      const cache = JSON.parse(await readFile(cachePath, 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:novel.epub']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache?.['order-1:novel.pdf']).toBeUndefined()
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('uses the routed library format priority when matching cross-library files', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const comicsPath = path.join(temporaryRoot, 'Comics')
      const booksPath = path.join(temporaryRoot, 'Books')
      const cachePath = path.join(temporaryRoot, '.hbd', 'cache.json')
      const bundleTitle = 'Humble Comics Bundle: Art Books'
      const productTitle = 'Product'
      const misplacedFolder = buildProductFolder(booksPath, bundleTitle, productTitle)
      await mkdir(misplacedFolder, { recursive: true })
      await writeFile(path.join(misplacedFolder, 'artofgoosebumps.epub'), 'epub file')

      const summary = await auditLibrary({
        client: createSingleProductClient(bundleTitle, [
          'artofgoosebumps.pdf',
          'artofgoosebumps.epub',
        ]),
        config: resolveConfig({
          defaultLibrary: 'books',
          cachePath,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
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

      const cache = JSON.parse(await readFile(cachePath, 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:artofgoosebumps.pdf']).toBeUndefined()
      expect(cache?.['order-1:artofgoosebumps.epub']).toBeUndefined()
      expect(summary).toMatchObject({
        selectedCandidates: 1,
        matchedFiles: 0,
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('does not let a lower-priority configured book format satisfy a preferred remote format', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const booksPath = path.join(temporaryRoot, 'Books')
      const bundleFolder = path.join(booksPath, 'Book Bundle')
      const cachePath = path.join(temporaryRoot, '.hbd', 'cache.json')
      await mkdir(bundleFolder, { recursive: true })
      await writeFile(path.join(bundleFolder, 'novel.mobi'), 'mobi file')

      await auditLibrary({
        client: createSingleProductClient('Book Bundle', ['novel.epub']),
        config: resolveConfig({
          defaultLibrary: 'books',
          cachePath,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
          libraries: {
            books: {
              path: booksPath,
              formatPriority: ['epub', 'pdf', 'mobi'],
              extInclude: ['epub', 'pdf', 'mobi'],
            },
          },
        }),
      })

      const cache = JSON.parse(await readFile(cachePath, 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:novel.epub']).toBeUndefined()
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('matches old timestamped Humble filenames to current metadata names', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const bundleFolder = path.join(temporaryRoot, 'Image Bundle')
      await mkdir(bundleFolder)
      await writeFile(path.join(bundleFolder, 'deadlyclass_vol4_1557360768.cbz'), 'old file')

      await auditLibrary({
        client: createClient('Image Bundle', ['deadlyclass_vol4.cbz']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:deadlyclass_vol4.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('matches strong volume-prefix aliases across extensions inside a Humble bundle', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const bundleFolder = path.join(temporaryRoot, 'IDW Bundle')
      await mkdir(bundleFolder)
      await writeFile(path.join(bundleFolder, 'lockeandkey_vol1.cbz'), 'old file')

      await auditLibrary({
        client: createClient('IDW Bundle', ['lockeandkey_vol1_welcometolovecraft.epub']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:lockeandkey_vol1_welcometolovecraft.epub']).toEqual({
        urlLastModified: expect.any(String),
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('matches book-one metadata to old volume-one filenames inside a Humble bundle', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const bundleFolder = path.join(temporaryRoot, 'Saga Bundle')
      await mkdir(bundleFolder)
      await writeFile(path.join(bundleFolder, 'saga_vol1_1398379699.cbz'), 'old file')

      await auditLibrary({
        client: createClient('Saga Bundle', ['saga_bookone.cbz']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:saga_bookone.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('audits only the preferred available format for a product', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const bundleFolder = path.join(temporaryRoot, 'Preferred Bundle')
      await mkdir(bundleFolder)
      await writeFile(path.join(bundleFolder, 'story.cbz'), 'cbz file')

      const summary = await auditLibrary({
        client: createSingleProductClient('Preferred Bundle', [
          'story.cbz',
          'story.pdf',
          'story.epub',
        ]),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
          formatPriority: ['cbz', 'pdf', 'epub'],
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:story.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache?.['order-1:story.pdf']).toBeUndefined()
      expect(cache?.['order-1:story.epub']).toBeUndefined()
      expect(summary).toMatchObject({
        candidatesConsidered: 3,
        selectedCandidates: 1,
        matchedFiles: 1,
        cacheEntries: 1,
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('writes order metadata for all web download candidates without URLs', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const bundleFolder = path.join(temporaryRoot, 'Preferred Bundle')
      const metadataPath = path.join(temporaryRoot, '.hbd', 'metadata.json')
      await mkdir(bundleFolder, { recursive: true })
      await writeFile(path.join(bundleFolder, 'story.cbz'), 'cbz file')

      const summary = await auditLibrary({
        client: createSingleProductClient('Preferred Bundle', [
          'story.cbz',
          'story.pdf',
          'story.epub',
        ]),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          metadataPath,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
          formatPriority: ['cbz', 'pdf', 'epub'],
        }),
      })

      const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
        version: number
        orders: Record<
          string,
          {
            bundleTitle: string
            products: Array<{
              productTitle: string
              downloads: Array<{
                cacheKey: string
                filename: string
                extension: string
                platform: string
                url?: string
              }>
            }>
          }
        >
      }

      expect(summary.metadataOrders).toBe(1)
      expect(summary.metadataPath).toBe(metadataPath)
      expect(metadata.version).toBe(1)
      expect(metadata.orders['order-1']?.bundleTitle).toBe('Preferred Bundle')
      expect(metadata.orders['order-1']?.products[0]?.downloads).toEqual([
        {
          cacheKey: 'order-1:story.cbz',
          filename: 'story.cbz',
          extension: 'cbz',
          platform: 'ebook',
        },
        {
          cacheKey: 'order-1:story.pdf',
          filename: 'story.pdf',
          extension: 'pdf',
          platform: 'ebook',
        },
        {
          cacheKey: 'order-1:story.epub',
          filename: 'story.epub',
          extension: 'epub',
          platform: 'ebook',
        },
      ])
      expect(JSON.stringify(metadata)).not.toContain('https://')
      expect(metadata.orders['order-1']?.products[0]?.downloads[0]?.url).toBeUndefined()
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('does not let a lower-priority local format satisfy a preferred remote format', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const bundleFolder = path.join(temporaryRoot, 'Preferred Bundle')
      await mkdir(bundleFolder)
      await writeFile(path.join(bundleFolder, 'story.pdf'), 'pdf file')

      await auditLibrary({
        client: createSingleProductClient('Preferred Bundle', ['story.cbz', 'story.pdf']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
          formatPriority: ['cbz', 'pdf'],
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:story.cbz']).toBeUndefined()
      expect(cache?.['order-1:story.pdf']).toBeUndefined()
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('does not let unranked local extensions satisfy unranked remote extensions', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const bundleFolder = path.join(temporaryRoot, 'Manual Bundle')
      await mkdir(bundleFolder)
      await writeFile(path.join(bundleFolder, 'manual.txt'), 'text file')

      await auditLibrary({
        client: createSingleProductClient('Manual Bundle', ['manual.zip']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
          formatPriority: ['cbz', 'pdf'],
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:manual.zip']).toBeUndefined()
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('lets existing ebook formats satisfy PDF-only book downloads', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      const bundleFolder = path.join(temporaryRoot, 'Geek Gals')
      await mkdir(bundleFolder)
      await writeFile(path.join(bundleFolder, 'geekgirlsguidetogeekwomen.mobi'), 'mobi file')

      await auditLibrary({
        client: createSingleProductClient('Geek Gals', ['geekgirlsguidetogeekwomen.pdf']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
          formatPriority: ['cbz', 'pdf'],
          extInclude: ['cbz', 'pdf'],
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:geekgirlsguidetogeekwomen.pdf']).toEqual({
        urlLastModified: expect.any(String),
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('emits audit progress messages', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      await writeFile(path.join(temporaryRoot, 'root-only.cbz'), 'root file')
      const messages: string[] = []

      const summary = await auditLibrary({
        client: createClient('Bundle', ['root-only.cbz']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
        onProgress: (message) => messages.push(message),
      })

      expect(messages).toContain('Indexing local files...')
      expect(messages).toContain('Auditing order 1/1...')
      expect(messages).toContain('Wrote 1 cache entries.')
      expect(messages.at(-1)).toBe('Wrote metadata for 1 order(s).')
      expect(summary.cacheEntries).toBe(1)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('rebuilds stale download entries while preserving transform metadata', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-audit-layout-'))

    try {
      await writeFile(
        path.join(temporaryRoot, '.cache.json'),
        JSON.stringify({
          'order-1:stale.cbz': {
            urlLastModified: 'old',
          },
          transforms: {
            pdf: {
              cbz: {
                version: 1,
                entries: {},
              },
            },
          },
        })
      )
      await writeFile(path.join(temporaryRoot, 'fresh.cbz'), 'root file')

      await auditLibrary({
        client: createClient('Bundle', ['fresh.cbz']),
        config: resolveConfig({
          libraryPath: temporaryRoot,
          sessionAuth: 'session',
          purchaseKeys: ['order-1'],
          offlineAudit: true,
        }),
      })

      const cache = JSON.parse(await readFile(path.join(temporaryRoot, '.cache.json'), 'utf8')) as
        | {
            transforms?: unknown
          }
        | Record<string, unknown>
        | undefined

      expect(cache?.['order-1:stale.cbz']).toBeUndefined()
      expect(cache?.['order-1:fresh.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache?.transforms).toEqual({
        pdf: {
          cbz: {
            version: 1,
            entries: {},
          },
        },
      })
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})
