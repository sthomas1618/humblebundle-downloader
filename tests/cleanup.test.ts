import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import { cleanupEmptyDirectories } from '../src/cleanup/cleanup'
import { resolveConfig } from '../src/config'
import { buildProductFolder, cleanName } from '../src/utils/fs'

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

describe('cleanupEmptyDirectories', () => {
  it('plans empty nested folders without removing them during a dry run', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cleanup-'))

    try {
      const root = path.join(temporaryDirectory, 'Library')
      const emptyChild = path.join(root, 'Empty Parent', 'Empty Child')
      const nonEmpty = path.join(root, 'Non Empty')
      await mkdir(emptyChild, { recursive: true })
      await mkdir(nonEmpty, { recursive: true })
      await writeFile(path.join(nonEmpty, 'book.pdf'), 'content')

      const report = await cleanupEmptyDirectories({
        config: resolveConfig({
          libraryPath: root,
        }),
      })

      expect(report).toMatchObject({
        dryRun: true,
        rootsScanned: 1,
        wouldRemove: 2,
        removed: 0,
        conflicts: 0,
      })
      expect(report.actions.map((action) => action.directoryPath).sort()).toEqual([
        path.join(root, 'Empty Parent'),
        emptyChild,
      ])
      expect(await pathExists(emptyChild)).toBe(true)
      expect(await pathExists(path.join(root, 'Empty Parent'))).toBe(true)
      expect(await pathExists(nonEmpty)).toBe(true)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('removes empty folders from configured library roots when applied', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cleanup-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const emptyBookFolder = path.join(booksPath, 'Empty Book Bundle', 'Product')
      const emptyComicFolder = path.join(comicsPath, 'Empty Comic Bundle')
      const nonEmptyBookFolder = path.join(booksPath, 'Keep Bundle')
      await mkdir(emptyBookFolder, { recursive: true })
      await mkdir(emptyComicFolder, { recursive: true })
      await mkdir(nonEmptyBookFolder, { recursive: true })
      await writeFile(path.join(nonEmptyBookFolder, 'keep.epub'), 'content')

      const report = await cleanupEmptyDirectories({
        apply: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          libraries: {
            books: {
              path: booksPath,
            },
            comics: {
              path: comicsPath,
            },
          },
        }),
      })

      expect(report).toMatchObject({
        dryRun: false,
        rootsScanned: 2,
        wouldRemove: 0,
        removed: 3,
        skipped: 0,
        conflicts: 0,
      })
      expect(await pathExists(path.join(booksPath, 'Empty Book Bundle'))).toBe(false)
      expect(await pathExists(emptyComicFolder)).toBe(false)
      expect(await readFile(path.join(nonEmptyBookFolder, 'keep.epub'), 'utf8')).toBe('content')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('plans duplicate legacy bundle folders covered by canonical folders', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cleanup-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Book Bundle: Forbidden Books supporting Banned Books Week 2018'
      const productTitle = 'Read Banned Books'
      const filename = 'readbannedbooks.pdf'
      const canonicalFile = path.join(
        buildProductFolder(booksPath, bundleTitle, productTitle),
        filename
      )
      const legacyFolder = path.join(booksPath, 'FORBIDDEN BOOKS SUPPORTING BANNED BOOKS WEEK 2018')
      const legacyFile = path.join(legacyFolder, filename)
      await mkdir(path.dirname(canonicalFile), { recursive: true })
      await mkdir(legacyFolder, { recursive: true })
      await writeFile(canonicalFile, 'same content')
      await writeFile(legacyFile, 'same content')
      await mkdir(path.dirname(metadataPath), { recursive: true })
      await writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          orders: {
            'order-1': {
              orderId: 'order-1',
              bundleTitle,
              updatedAt: new Date().toISOString(),
              products: [{ productTitle, downloads: [] }],
            },
          },
        })
      )

      const report = await cleanupEmptyDirectories({
        dedupe: true,
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
        }),
      })

      expect(report).toMatchObject({
        dryRun: true,
        wouldRemove: 1,
        removed: 0,
        conflicts: 0,
      })
      expect(report.actions).toEqual([
        expect.objectContaining({
          kind: 'duplicate-directory',
          directoryPath: legacyFolder,
          duplicateOf: path.join(booksPath, cleanName(bundleTitle)),
          fileCount: 1,
        }),
      ])
      expect(await pathExists(legacyFolder)).toBe(true)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('removes duplicate top-level folders while keeping the better named copy', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cleanup-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const shortFolder = path.join(comicsPath, 'MICROIDS')
      const longFolder = path.join(comicsPath, 'MICROIDS GAMES & COMICS CROSSOVER COLLECTION')
      await mkdir(shortFolder, { recursive: true })
      await mkdir(longFolder, { recursive: true })
      await writeFile(path.join(shortFolder, 'arthustrivium1.epub'), 'same content')
      await writeFile(path.join(longFolder, 'arthustrivium1.epub'), 'same content')

      const report = await cleanupEmptyDirectories({
        apply: true,
        dedupe: true,
        config: resolveConfig({
          libraryPath: comicsPath,
        }),
      })

      expect(report).toMatchObject({
        dryRun: false,
        removed: 1,
        conflicts: 0,
      })
      expect(report.actions).toEqual([
        expect.objectContaining({
          kind: 'duplicate-directory',
          directoryPath: shortFolder,
          duplicateOf: longFolder,
          fileCount: 1,
          status: 'removed',
        }),
      ])
      expect(await pathExists(shortFolder)).toBe(false)
      expect(await readFile(path.join(longFolder, 'arthustrivium1.epub'), 'utf8')).toBe(
        'same content'
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('does not remove unrelated folders that are only covered by file overlap', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cleanup-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const canonicalBundle = 'Humble Book Bundle: Geek Gals'
      const canonicalFile = path.join(
        buildProductFolder(comicsPath, canonicalBundle, 'Jem and the Holograms Vol. 1'),
        'jem.epub'
      )
      const unrelatedFolder = path.join(comicsPath, "BACK TO THE '80S BY IDW")
      await mkdir(path.dirname(canonicalFile), { recursive: true })
      await mkdir(unrelatedFolder, { recursive: true })
      await writeFile(canonicalFile, 'same content')
      await writeFile(path.join(unrelatedFolder, 'jem.epub'), 'same content')
      await mkdir(path.dirname(metadataPath), { recursive: true })
      await writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          orders: {
            'order-1': {
              orderId: 'order-1',
              bundleTitle: canonicalBundle,
              updatedAt: new Date().toISOString(),
              products: [{ productTitle: 'Jem and the Holograms Vol. 1', downloads: [] }],
            },
          },
        })
      )

      const report = await cleanupEmptyDirectories({
        dedupe: true,
        config: resolveConfig({
          libraryPath: comicsPath,
          metadataPath,
        }),
      })

      expect(report.actions).toEqual([])
      expect(await pathExists(unrelatedFolder)).toBe(true)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('matches legacy all-caps folders by content before title similarity', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cleanup-'))

    try {
      const mangaPath = path.join(temporaryDirectory, 'Manga')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const fantasyBundle = 'Humble Manga Bundle: Fantasy by Kodansha Comics'
      const fantasyProduct = 'Fairy Tail Vol. 1'
      const filename = 'fairytail_vol1.cbz'
      const canonicalFile = path.join(
        buildProductFolder(mangaPath, fantasyBundle, fantasyProduct),
        filename
      )
      const legacyFolder = path.join(mangaPath, 'FANTASY')
      const legacyFile = path.join(legacyFolder, filename)
      await mkdir(path.dirname(canonicalFile), { recursive: true })
      await mkdir(legacyFolder, { recursive: true })
      await writeFile(canonicalFile, 'same content')
      await writeFile(legacyFile, 'same content')
      await mkdir(path.dirname(metadataPath), { recursive: true })
      await writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          orders: {
            fantasy: {
              orderId: 'fantasy',
              bundleTitle: fantasyBundle,
              updatedAt: new Date().toISOString(),
              products: [
                {
                  productTitle: fantasyProduct,
                  downloads: [
                    {
                      cacheKey: 'fantasy:fairytail_vol1.cbz',
                      filename,
                      extension: 'cbz',
                      platform: 'ebook',
                      fileSize: 'same content'.length,
                    },
                  ],
                },
              ],
            },
            finalFantasy: {
              orderId: 'finalFantasy',
              bundleTitle: 'Final Fantasy VII Remake Intergrade',
              updatedAt: new Date().toISOString(),
              products: [
                {
                  productTitle: 'Final Fantasy VII Remake Intergrade',
                  downloads: [
                    {
                      cacheKey: 'finalFantasy:game.zip',
                      filename: 'game.zip',
                      extension: 'zip',
                      platform: 'windows',
                    },
                  ],
                },
              ],
            },
          },
        })
      )

      const report = await cleanupEmptyDirectories({
        legacyFolders: true,
        config: resolveConfig({
          defaultLibrary: 'manga',
          libraries: {
            manga: {
              path: mangaPath,
              extInclude: ['cbz'],
              formatPriority: ['cbz'],
            },
          },
          metadataPath,
        }),
      })

      expect(report).toMatchObject({
        dryRun: true,
        wouldRemove: 1,
        review: 0,
        conflicts: 0,
      })
      expect(report.actions).toContainEqual(
        expect.objectContaining({
          kind: 'legacy-file',
          sourcePath: legacyFile,
          duplicateOf: canonicalFile,
          bundleTitle: fantasyBundle,
          classification: 'covered-by-canonical-file',
          status: 'would-remove',
        })
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('leaves legacy folders for review when content matches multiple orders equally', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cleanup-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const legacyFolder = path.join(comicsPath, 'DYNAMITE MEGA')
      await mkdir(legacyFolder, { recursive: true })
      await writeFile(path.join(legacyFolder, 'shared.cbz'), 'content')
      await mkdir(path.dirname(metadataPath), { recursive: true })
      await writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          orders: {
            original: {
              orderId: 'original',
              bundleTitle: 'Humble Comics Bundle: Dynamite Mega',
              updatedAt: new Date().toISOString(),
              products: [
                {
                  productTitle: 'Shared',
                  downloads: [
                    {
                      cacheKey: 'original:shared.cbz',
                      filename: 'shared.cbz',
                      extension: 'cbz',
                      platform: 'ebook',
                    },
                  ],
                },
              ],
            },
            encore: {
              orderId: 'encore',
              bundleTitle: 'Humble Comics Bundle: Dynamite Mega Encore',
              updatedAt: new Date().toISOString(),
              products: [
                {
                  productTitle: 'Shared',
                  downloads: [
                    {
                      cacheKey: 'encore:shared.cbz',
                      filename: 'shared.cbz',
                      extension: 'cbz',
                      platform: 'ebook',
                    },
                  ],
                },
              ],
            },
          },
        })
      )

      const report = await cleanupEmptyDirectories({
        legacyFolders: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz'],
              formatPriority: ['cbz'],
            },
          },
          metadataPath,
        }),
      })

      expect(report).toMatchObject({
        review: 1,
        wouldMove: 0,
        wouldRemove: 0,
      })
      expect(report.actions).toContainEqual(
        expect.objectContaining({
          kind: 'legacy-directory',
          directoryPath: legacyFolder,
          status: 'review',
          classification: 'ambiguous-content-match',
        })
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('moves legacy filename aliases into canonical product folders when applied', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cleanup-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Book Bundle: Become a Game Developer'
      const productTitle = 'Unity Games'
      const legacyFolder = path.join(booksPath, 'BECOME A GAME DEVELOPER')
      const legacyFile = path.join(legacyFolder, 'unitygames_1557360768.epub')
      const canonicalFile = path.join(
        buildProductFolder(booksPath, bundleTitle, productTitle),
        'unitygames.epub'
      )
      await mkdir(legacyFolder, { recursive: true })
      await writeFile(legacyFile, 'content')
      await mkdir(path.dirname(metadataPath), { recursive: true })
      await writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          orders: {
            'order-1': {
              orderId: 'order-1',
              bundleTitle,
              updatedAt: new Date().toISOString(),
              products: [
                {
                  productTitle,
                  downloads: [
                    {
                      cacheKey: 'order-1:unitygames.epub',
                      filename: 'unitygames.epub',
                      extension: 'epub',
                      platform: 'ebook',
                      fileSize: 'content'.length,
                    },
                  ],
                },
              ],
            },
          },
        })
      )

      const report = await cleanupEmptyDirectories({
        apply: true,
        legacyFolders: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          libraries: {
            books: {
              path: booksPath,
              extInclude: ['epub'],
              formatPriority: ['epub'],
            },
          },
          metadataPath,
        }),
      })

      expect(report).toMatchObject({
        dryRun: false,
        moved: 1,
        conflicts: 0,
      })
      expect(await pathExists(legacyFile)).toBe(false)
      expect(await readFile(canonicalFile, 'utf8')).toBe('content')
      expect(await pathExists(legacyFolder)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('resolves legacy size conflicts by keeping canonical files when requested', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cleanup-'))

    try {
      const mangaPath = path.join(temporaryDirectory, 'Manga')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Manga Bundle: Fantasy by Kodansha Comics'
      const productTitle = 'Clockwork Planet Vol. 1'
      const filename = 'clockworkplanet_vol1.cbz'
      const legacyFolder = path.join(mangaPath, 'FANTASY')
      const legacyFile = path.join(legacyFolder, filename)
      const canonicalFile = path.join(
        buildProductFolder(mangaPath, bundleTitle, productTitle),
        filename
      )
      await mkdir(legacyFolder, { recursive: true })
      await mkdir(path.dirname(canonicalFile), { recursive: true })
      await writeFile(legacyFile, 'legacy content')
      await writeFile(canonicalFile, 'canonical content is different')
      await mkdir(path.dirname(metadataPath), { recursive: true })
      await writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          orders: {
            'order-1': {
              orderId: 'order-1',
              bundleTitle,
              updatedAt: new Date().toISOString(),
              products: [
                {
                  productTitle,
                  downloads: [
                    {
                      cacheKey: `order-1:${filename}`,
                      filename,
                      extension: 'cbz',
                      platform: 'ebook',
                    },
                  ],
                },
              ],
            },
          },
        })
      )

      const report = await cleanupEmptyDirectories({
        apply: true,
        legacyFolders: true,
        resolveConflicts: 'prefer-canonical',
        config: resolveConfig({
          defaultLibrary: 'manga',
          libraries: {
            manga: {
              path: mangaPath,
              extInclude: ['cbz'],
              formatPriority: ['cbz'],
            },
          },
          metadataPath,
        }),
      })

      expect(report).toMatchObject({
        removed: 2,
        conflicts: 0,
      })
      expect(report.actions).toContainEqual(
        expect.objectContaining({
          kind: 'legacy-file',
          sourcePath: legacyFile,
          duplicateOf: canonicalFile,
          status: 'removed',
          classification: 'conflict-prefer-canonical',
        })
      )
      expect(await pathExists(legacyFile)).toBe(false)
      expect(await readFile(canonicalFile, 'utf8')).toBe('canonical content is different')
      expect(await pathExists(legacyFolder)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('moves preferred legacy formats when metadata only has lower-priority formats', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cleanup-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Start Here!'
      const productTitle = 'Ghost/Hellboy Special'
      const legacyFolder = path.join(comicsPath, 'START HERE!')
      const legacyFile = path.join(legacyFolder, 'ghost_hellboy_special.cbz')
      const canonicalFile = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        'ghost_hellboy_special.cbz'
      )
      await mkdir(legacyFolder, { recursive: true })
      await writeFile(legacyFile, 'cbz content')
      await mkdir(path.dirname(metadataPath), { recursive: true })
      await writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          orders: {
            'order-1': {
              orderId: 'order-1',
              bundleTitle,
              updatedAt: new Date().toISOString(),
              products: [
                {
                  productTitle,
                  downloads: [
                    {
                      cacheKey: 'order-1:ghost_hellboy_special.pdf',
                      filename: 'ghost_hellboy_special.pdf',
                      extension: 'pdf',
                      platform: 'ebook',
                    },
                  ],
                },
              ],
            },
          },
        })
      )

      const report = await cleanupEmptyDirectories({
        apply: true,
        legacyFolders: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz', 'pdf'],
              formatPriority: ['cbz', 'pdf'],
            },
          },
          metadataPath,
        }),
      })

      expect(report).toMatchObject({
        moved: 1,
        conflicts: 0,
      })
      expect(report.actions).toContainEqual(
        expect.objectContaining({
          kind: 'legacy-file',
          sourcePath: legacyFile,
          destinationPath: canonicalFile,
          status: 'moved',
          classification: 'metadata-alias',
        })
      )
      expect(await pathExists(legacyFile)).toBe(false)
      expect(await readFile(canonicalFile, 'utf8')).toBe('cbz content')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('matches legacy filenames with extra article and book words to product titles', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cleanup-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Start Here!'
      const productTitle = 'Maggie the Mechanic (Love & Rockets)'
      const legacyFolder = path.join(comicsPath, 'START HERE!')
      const legacyFile = path.join(legacyFolder, 'maggiethemechanic_aloveandrocketsbook.cbz')
      const canonicalFile = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        'maggiethemechanic_aloveandrocketsbook.cbz'
      )
      await mkdir(legacyFolder, { recursive: true })
      await writeFile(legacyFile, 'cbz content')
      await mkdir(path.dirname(metadataPath), { recursive: true })
      await writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          orders: {
            'order-1': {
              orderId: 'order-1',
              bundleTitle,
              updatedAt: new Date().toISOString(),
              products: [
                {
                  productTitle,
                  downloads: [
                    {
                      cacheKey: 'order-1:maggiethemechanic_loveandrockets.cbz',
                      filename: 'maggiethemechanic_loveandrockets.cbz',
                      extension: 'cbz',
                      platform: 'ebook',
                    },
                  ],
                },
              ],
            },
          },
        })
      )

      const report = await cleanupEmptyDirectories({
        apply: true,
        legacyFolders: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz'],
              formatPriority: ['cbz'],
            },
          },
          metadataPath,
        }),
      })

      expect(report).toMatchObject({
        moved: 1,
        review: 0,
        conflicts: 0,
      })
      expect(await pathExists(legacyFile)).toBe(false)
      expect(await readFile(canonicalFile, 'utf8')).toBe('cbz content')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
