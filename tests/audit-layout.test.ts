import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import type { ApiClient } from '../src/api/client'
import { resolveConfig } from '../src/config'
import { auditLibrary } from '../src/download/downloader'

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
      expect(messages.at(-1)).toBe('Wrote 1 cache entries.')
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
