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
})
