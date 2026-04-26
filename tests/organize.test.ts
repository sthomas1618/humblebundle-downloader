import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import { resolveConfig } from '../src/config'
import { organizeLibrary } from '../src/organize/organize'
import { buildProductFolder } from '../src/utils/fs'

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function writeMetadata(metadataPath: string, orders: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(metadataPath), { recursive: true })
  await writeFile(
    metadataPath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        orders,
      },
      undefined,
      2
    )
  )
}

describe('organizeLibrary', () => {
  it('plans flat publisher and series moves without changing files during a dry run', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Creator Spotlight by Image Comics'
      const productTitle = 'Saga Vol. 1: Chapters One-Six'
      const filename = 'saga_vol1.cbz'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        filename
      )
      const destinationPath = path.join(comicsPath, 'Image Comics', 'Saga', filename)
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'cbz content')
      await writeMetadata(metadataPath, {
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
      })

      const report = await organizeLibrary({
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          metadataPath,
          routes: [{ id: 'comic-formats', library: 'comics', extensions: ['cbz'] }],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf', 'epub', 'mobi'],
              extInclude: ['cbz', 'pdf', 'epub', 'mobi'],
            },
          },
        }),
      })

      expect(report).toMatchObject({
        dryRun: true,
        selectedCandidates: 1,
        wouldMove: 1,
        moved: 0,
        missing: 0,
        conflicts: 0,
      })
      expect(report.actions[0]).toMatchObject({
        status: 'would-move',
        sourcePath,
        destinationPath,
      })
      expect(await pathExists(sourcePath)).toBe(true)
      expect(await pathExists(destinationPath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('uses humble for flat products when publisher cannot be inferred', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Book Bundle: Be the Change'
      const productTitle = 'Civic Guide Book 1'
      const filename = 'civic_guide.epub'
      const sourcePath = path.join(
        buildProductFolder(booksPath, bundleTitle, productTitle),
        filename
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'epub content')
      await writeMetadata(metadataPath, {
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
                  extension: 'epub',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              formatPriority: ['epub', 'pdf', 'mobi'],
              extInclude: ['epub', 'pdf', 'mobi'],
            },
          },
        }),
      })

      expect(report.actions[0]?.destinationPath).toBe(
        path.join(booksPath, 'humble', 'Civic Guide', filename)
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('dedupes repeated flat products while keeping other formats and volumes', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const sagaOne = path.join(
        buildProductFolder(comicsPath, 'Humble Comics Bundle: Saga by Image Comics', 'Saga Vol. 1'),
        'saga_vol1.cbz'
      )
      const sagaOnePdf = sagaOne.replace(/\.cbz$/, '.pdf')
      const sagaTwo = path.join(
        buildProductFolder(comicsPath, 'Humble Conquer COVID-19 Bundle', 'Saga Vol. 2'),
        'saga_vol2.cbz'
      )
      for (const filePath of [sagaOne, sagaOnePdf, sagaTwo]) {
        await mkdir(path.dirname(filePath), { recursive: true })
        await writeFile(filePath, path.basename(filePath))
      }
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Comics Bundle: Saga by Image Comics',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Saga Vol. 1',
              downloads: [
                {
                  cacheKey: 'order-1:saga_vol1.cbz',
                  filename: 'saga_vol1.cbz',
                  extension: 'cbz',
                  platform: 'ebook',
                },
                {
                  cacheKey: 'order-1:saga_vol1.pdf',
                  filename: 'saga_vol1.pdf',
                  extension: 'pdf',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
        'order-2': {
          orderId: 'order-2',
          bundleTitle: 'Humble Conquer COVID-19 Bundle',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Saga Vol. 1',
              downloads: [
                {
                  cacheKey: 'order-2:saga_vol1.cbz',
                  filename: 'saga_vol1.cbz',
                  extension: 'cbz',
                  platform: 'ebook',
                },
              ],
            },
            {
              productTitle: 'Saga Vol. 2',
              downloads: [
                {
                  cacheKey: 'order-2:saga_vol2.cbz',
                  filename: 'saga_vol2.cbz',
                  extension: 'cbz',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf'],
              extInclude: ['cbz', 'pdf'],
            },
          },
        }),
      })

      expect(report.actions.map((action) => action.destinationPath).sort()).toEqual(
        [
          path.join(comicsPath, 'Image Comics', 'Saga', 'saga_vol1.cbz'),
          path.join(comicsPath, 'Image Comics', 'Saga', 'saga_vol1.pdf'),
          path.join(comicsPath, 'humble', 'Saga', 'saga_vol2.cbz'),
        ].sort()
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('does not let a missing flat duplicate hide a later available copy', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const availableCopy = path.join(
        buildProductFolder(comicsPath, 'Humble Conquer COVID-19 Bundle', 'Saga Vol. 1'),
        'saga_vol1.cbz'
      )
      await mkdir(path.dirname(availableCopy), { recursive: true })
      await writeFile(availableCopy, 'cbz')
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Comics Bundle: Saga by Image Comics',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Saga Vol. 1',
              downloads: [
                {
                  cacheKey: 'order-1:saga_vol1.cbz',
                  filename: 'saga_vol1.cbz',
                  extension: 'cbz',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
        'order-2': {
          orderId: 'order-2',
          bundleTitle: 'Humble Conquer COVID-19 Bundle',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Saga Vol. 1',
              downloads: [
                {
                  cacheKey: 'order-2:saga_vol1.cbz',
                  filename: 'saga_vol1.cbz',
                  extension: 'cbz',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz'],
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.missing).toBe(1)
      expect(report.wouldMove).toBe(1)
      expect(
        report.actions.find((action) => action.cacheKey === 'order-2:saga_vol1.cbz')
      ).toMatchObject({
        status: 'would-move',
        sourcePath: availableCopy,
        destinationPath: path.join(comicsPath, 'Image Comics', 'Saga', 'saga_vol1.cbz'),
      })
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('keeps the local filename for flat equivalent format matches', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Art Books by Dynamite'
      const productTitle = 'The Art of Atari'
      const remoteFilename = 'theartofatari.pdf'
      const localFilename = 'theartofatari.cbz'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        localFilename
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'cbz content')
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                {
                  cacheKey: `order-1:${remoteFilename}`,
                  filename: remoteFilename,
                  extension: 'pdf',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf'],
              extInclude: ['cbz', 'pdf'],
            },
          },
        }),
      })

      expect(report).toMatchObject({
        conflicts: 0,
        wouldMove: 1,
      })
      expect(report.actions[0]).toMatchObject({
        filename: localFilename,
        sourcePath,
        destinationPath: path.join(comicsPath, 'Dynamite', 'The Art of Atari', localFilename),
      })
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('collapses flat aliases that match the same local source filename', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: The Ultimate Top Cow by Top Cow'
      const productTitle = 'Midnight Nation Vol 1'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        'midnightnation_vol1.pdf'
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'pdf content')
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                {
                  cacheKey: 'order-1:midnightnation_vol1.pdf',
                  filename: 'midnightnation_vol1.pdf',
                  extension: 'pdf',
                  platform: 'ebook',
                },
                {
                  cacheKey: 'order-1:midnightnation_vol1_optimized.pdf',
                  filename: 'midnightnation_vol1_optimized.pdf',
                  extension: 'pdf',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['pdf'],
              extInclude: ['pdf'],
            },
          },
        }),
      })

      expect(report).toMatchObject({
        conflicts: 0,
        wouldMove: 1,
      })
      expect(report.actions).toHaveLength(1)
      expect(report.actions[0]).toMatchObject({
        filename: 'midnightnation_vol1.pdf',
        sourcePath,
        destinationPath: path.join(
          comicsPath,
          'Top Cow',
          'Midnight Nation',
          'midnightnation_vol1.pdf'
        ),
      })
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('marks configured libraries flat when flat organize is applied', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const mediaRoot = temporaryDirectory
      const comicsPath = path.join(mediaRoot, 'Comics')
      const appHome = path.join(mediaRoot, '.hbd')
      const configPath = path.join(appHome, 'config.json')
      const metadataPath = path.join(appHome, 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Saga by Image Comics'
      const productTitle = 'Saga Vol. 1'
      const filename = 'saga_vol1.cbz'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        filename
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'cbz content')
      await mkdir(appHome, { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify(
          {
            version: 1,
            defaultLibrary: 'comics',
            metadataPath: '.hbd/metadata.json',
            libraries: {
              comics: {
                path: 'Comics',
                extInclude: ['cbz'],
                formatPriority: ['cbz'],
              },
            },
          },
          undefined,
          2
        )
      )
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                { cacheKey: `order-1:${filename}`, filename, extension: 'cbz', platform: 'ebook' },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        flat: true,
        config: resolveConfig({
          configPath,
          mediaRoot,
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz'],
              formatPriority: ['cbz'],
            },
          },
        }),
      })

      expect(report.moved).toBe(1)
      const updatedConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
        libraries: { comics: { layout?: string } }
      }
      expect(updatedConfig.libraries.comics.layout).toBe('flat')
      expect(await pathExists(path.join(comicsPath, 'Image Comics', 'Saga', filename))).toBe(true)
      const cache = JSON.parse(await readFile(path.join(comicsPath, '.cache.json'), 'utf8')) as
        | Record<string, unknown>
        | undefined
      expect(cache?.['order-1:saga_vol1.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache?.['flat:comics:saga_vol_1:saga_vol1.cbz']).toEqual({
        urlLastModified: expect.any(String),
      })
      expect(cache?.flatIndex).toMatchObject({
        entries: {
          'flat:comics:saga_vol_1:saga_vol1.cbz': {
            canonicalPath: path.join(comicsPath, 'Image Comics', 'Saga', filename),
            publisher: 'Image Comics',
            series: 'Saga',
            bundleLocations: [
              {
                cacheKey: 'order-1:saga_vol1.cbz',
                bundlePath: path.join(
                  comicsPath,
                  'Humble Comics Bundle - Saga by Image Comics',
                  'Saga Vol. 1',
                  filename
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

  it('fails flat apply without a config file before moving files', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Saga by Image Comics'
      const productTitle = 'Saga Vol. 1'
      const filename = 'saga_vol1.cbz'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        filename
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'cbz content')
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                { cacheKey: `order-1:${filename}`, filename, extension: 'cbz', platform: 'ebook' },
              ],
            },
          ],
        },
      })

      await expect(
        organizeLibrary({
          apply: true,
          flat: true,
          config: resolveConfig({
            defaultLibrary: 'comics',
            metadataPath,
            libraries: {
              comics: {
                path: comicsPath,
                extInclude: ['cbz'],
                formatPriority: ['cbz'],
              },
            },
          }),
        })
      ).rejects.toThrow('requires a loaded config file')
      expect(await pathExists(sourcePath)).toBe(true)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('plans moves from metadata without changing files during a dry run', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = "Humble Comics Bundle: Mike Mignola's B.P.R.D. by Dark Horse ENCORE"
      const productTitle = 'Hellboy: Odd Jobs'
      const filename = 'hellboy_oddjobs.epub'
      const sourcePath = path.join(
        buildProductFolder(booksPath, bundleTitle, productTitle),
        filename
      )
      const destinationPath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        filename
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'epub content')
      await writeMetadata(metadataPath, {
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
                  extension: 'epub',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        config: resolveConfig({
          defaultLibrary: 'books',
          metadataPath,
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

      expect(report).toMatchObject({
        dryRun: true,
        selectedCandidates: 1,
        wouldMove: 1,
        moved: 0,
        missing: 0,
        conflicts: 0,
      })
      expect(report.actions[0]).toMatchObject({
        status: 'would-move',
        sourcePath,
        destinationPath,
        expectedLibraryName: 'comics',
      })
      expect(await pathExists(sourcePath)).toBe(true)
      expect(await pathExists(destinationPath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('moves local alternate formats by routed library without satisfying the preferred download', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Art Books by Dynamite'
      const productTitle = 'Art of Goosebumps'
      const preferredFilename = 'artofgoosebumps.pdf'
      const alternateFilename = 'artofgoosebumps.epub'
      const alternateSourcePath = path.join(
        buildProductFolder(booksPath, bundleTitle, productTitle),
        alternateFilename
      )
      const alternateDestinationPath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        alternateFilename
      )
      await mkdir(path.dirname(alternateSourcePath), { recursive: true })
      await writeFile(alternateSourcePath, 'epub content')
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                {
                  cacheKey: `order-1:${preferredFilename}`,
                  filename: preferredFilename,
                  extension: 'pdf',
                  platform: 'ebook',
                },
                {
                  cacheKey: `order-1:${alternateFilename}`,
                  filename: alternateFilename,
                  extension: 'epub',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        config: resolveConfig({
          defaultLibrary: 'books',
          metadataPath,
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

      expect(report).toMatchObject({
        selectedCandidates: 1,
        wouldMove: 1,
        missing: 1,
        conflicts: 0,
      })
      expect(report.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: preferredFilename,
            selected: true,
            status: 'missing',
          }),
          expect.objectContaining({
            filename: alternateFilename,
            selected: false,
            status: 'would-move',
            sourcePath: alternateSourcePath,
            destinationPath: alternateDestinationPath,
            expectedLibraryName: 'comics',
          }),
        ])
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('moves local alternates even when the preferred format already exists in the target library', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Dynamite Character Crossover Comics by Dynamite'
      const productTitle = 'Vampirella vs Reanimator Vol 1-4'
      const preferredFilename = 'vampirellavsreanimatorvol1-4.pdf'
      const alternateFilename = 'vampirellavsreanimatorvol1-4.epub'
      const preferredPath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        preferredFilename
      )
      const alternateSourcePath = path.join(
        buildProductFolder(booksPath, bundleTitle, productTitle),
        alternateFilename
      )
      const alternateDestinationPath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        alternateFilename
      )
      await mkdir(path.dirname(preferredPath), { recursive: true })
      await mkdir(path.dirname(alternateSourcePath), { recursive: true })
      await writeFile(preferredPath, 'pdf content')
      await writeFile(alternateSourcePath, 'epub content')
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                {
                  cacheKey: `order-1:${preferredFilename}`,
                  filename: preferredFilename,
                  extension: 'pdf',
                  platform: 'ebook',
                },
                {
                  cacheKey: `order-1:${alternateFilename}`,
                  filename: alternateFilename,
                  extension: 'epub',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        config: resolveConfig({
          defaultLibrary: 'books',
          metadataPath,
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

      expect(report).toMatchObject({
        selectedCandidates: 1,
        alreadyCorrect: 1,
        wouldMove: 1,
        missing: 0,
        conflicts: 0,
      })
      expect(report.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: preferredFilename,
            selected: true,
            status: 'already-correct',
          }),
          expect.objectContaining({
            filename: alternateFilename,
            selected: false,
            status: 'would-move',
            sourcePath: alternateSourcePath,
            destinationPath: alternateDestinationPath,
            expectedLibraryName: 'comics',
          }),
        ])
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('ignores duplicate metadata rows for the same source and destination move', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Duplicate Orders'
      const productTitle = 'Comic'
      const filename = 'comic.epub'
      const sourcePath = path.join(
        buildProductFolder(booksPath, bundleTitle, productTitle),
        filename
      )
      const destinationPath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        filename
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'epub content')

      const orders = Object.fromEntries(
        ['order-1', 'order-2'].map((orderId) => [
          orderId,
          {
            orderId,
            bundleTitle,
            updatedAt: new Date().toISOString(),
            products: [
              {
                productTitle,
                downloads: [
                  {
                    cacheKey: `${orderId}:${filename}`,
                    filename,
                    extension: 'epub',
                    platform: 'ebook',
                  },
                ],
              },
            ],
          },
        ])
      )
      await writeMetadata(metadataPath, orders)

      const report = await organizeLibrary({
        config: resolveConfig({
          defaultLibrary: 'books',
          metadataPath,
          routes: [
            {
              id: 'comic-bundles',
              library: 'comics',
              bundleTitlePatterns: [String.raw`\bcomics?\s+bundle\b`],
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

      expect(report).toMatchObject({
        selectedCandidates: 2,
        wouldMove: 1,
        conflicts: 0,
      })
      expect(report.actions).toEqual([
        expect.objectContaining({
          status: 'would-move',
          sourcePath,
          destinationPath,
        }),
      ])
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('does not move a file that is already correct for another bundle', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const filename = 'shared_vol1.epub'
      const productTitle = 'Shared Vol. 1'
      const sourceBundleTitle = 'Humble Comics Bundle: Source'
      const duplicateBundleTitle = 'Humble Comics Bundle: Duplicate'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, sourceBundleTitle, productTitle),
        filename
      )
      const duplicateDestinationPath = path.join(
        buildProductFolder(comicsPath, duplicateBundleTitle, productTitle),
        filename
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'epub content')
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: sourceBundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                {
                  cacheKey: `order-1:${filename}`,
                  filename,
                  extension: 'epub',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
        'order-2': {
          orderId: 'order-2',
          bundleTitle: duplicateBundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                {
                  cacheKey: `order-2:${filename}`,
                  filename,
                  extension: 'epub',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        canonical: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          metadataPath,
          routes: [
            {
              id: 'comic-bundles',
              library: 'comics',
              bundleTitlePatterns: [String.raw`\bcomics?\s+bundle\b`],
            },
          ],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf', 'epub', 'mobi'],
              extInclude: ['cbz', 'pdf', 'epub', 'mobi'],
            },
          },
        }),
      })

      expect(report).toMatchObject({
        alreadyCorrect: 1,
        wouldMove: 0,
        conflicts: 1,
      })
      expect(report.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bundleTitle: sourceBundleTitle,
            status: 'already-correct',
            sourcePath,
            destinationPath: sourcePath,
          }),
          expect.objectContaining({
            bundleTitle: duplicateBundleTitle,
            status: 'conflict',
            sourcePath,
            destinationPath: duplicateDestinationPath,
            reason: 'Source file is already planned for another candidate.',
          }),
        ])
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('does not move files between canonical Humble bundle folders', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const filename = 'shared_vol1.epub'
      const productTitle = 'Shared Vol. 1'
      const sourceBundleTitle = 'Humble Comics Bundle: Source'
      const duplicateBundleTitle = 'Humble Comics Bundle: Duplicate'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, sourceBundleTitle, productTitle),
        filename
      )
      const duplicateDestinationPath = path.join(
        buildProductFolder(comicsPath, duplicateBundleTitle, productTitle),
        filename
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'epub content')
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: duplicateBundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                {
                  cacheKey: `order-1:${filename}`,
                  filename,
                  extension: 'epub',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
        'order-2': {
          orderId: 'order-2',
          bundleTitle: sourceBundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                {
                  cacheKey: `order-2:${filename}`,
                  filename,
                  extension: 'epub',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        canonical: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          metadataPath,
          routes: [
            {
              id: 'comic-bundles',
              library: 'comics',
              bundleTitlePatterns: [String.raw`\bcomics?\s+bundle\b`],
            },
          ],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf', 'epub', 'mobi'],
              extInclude: ['cbz', 'pdf', 'epub', 'mobi'],
            },
          },
        }),
      })

      expect(report).toMatchObject({
        alreadyCorrect: 1,
        wouldMove: 0,
        conflicts: 1,
      })
      expect(report.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            bundleTitle: duplicateBundleTitle,
            status: 'conflict',
            sourcePath,
            destinationPath: duplicateDestinationPath,
            reason: 'Source file is already inside another canonical Humble bundle folder.',
          }),
          expect.objectContaining({
            bundleTitle: sourceBundleTitle,
            status: 'already-correct',
            sourcePath,
            destinationPath: sourcePath,
          }),
        ])
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('moves selected files into the routed library when applied', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const booksPath = path.join(temporaryDirectory, 'Books')
      const mangaPath = path.join(temporaryDirectory, 'Manga')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const misplaced = [
        {
          orderId: 'order-book',
          bundleTitle: 'Humble Book Bundle: Space Novels',
          productTitle: 'Space Novel',
          filename: 'space-novel.epub',
          platform: 'ebook',
          extension: 'epub',
          sourceRoot: comicsPath,
          destinationRoot: booksPath,
        },
        {
          orderId: 'order-cbz',
          bundleTitle: 'Humble Book Bundle: Geek Gals',
          productTitle: 'Paper Girls Vol. 1',
          filename: 'papergirls_vol1.cbz',
          platform: 'ebook',
          extension: 'cbz',
          sourceRoot: booksPath,
          destinationRoot: comicsPath,
        },
        {
          orderId: 'order-manga',
          bundleTitle: 'Humble Manga Bundle - Fantasy by Kodansha Comics',
          productTitle: 'Flying Witch Vol. 1',
          filename: 'flyingwitch_vol1.pdf',
          platform: 'ebook',
          extension: 'pdf',
          sourceRoot: comicsPath,
          destinationRoot: mangaPath,
        },
      ]
      const orders = Object.fromEntries(
        misplaced.map((item) => [
          item.orderId,
          {
            orderId: item.orderId,
            bundleTitle: item.bundleTitle,
            updatedAt: new Date().toISOString(),
            products: [
              {
                productTitle: item.productTitle,
                downloads: [
                  {
                    cacheKey: `${item.orderId}:${item.filename}`,
                    filename: item.filename,
                    extension: item.extension,
                    platform: item.platform,
                  },
                ],
              },
            ],
          },
        ])
      )
      await writeMetadata(metadataPath, orders)
      for (const item of misplaced) {
        const sourcePath = path.join(
          buildProductFolder(item.sourceRoot, item.bundleTitle, item.productTitle),
          item.filename
        )
        await mkdir(path.dirname(sourcePath), { recursive: true })
        await writeFile(sourcePath, item.filename)
      }

      const report = await organizeLibrary({
        apply: true,
        canonical: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          metadataPath,
          routes: [
            {
              id: 'manga-bundles',
              library: 'manga',
              bundleTitlePatterns: [String.raw`\bmanga\s+bundle\b`],
            },
            {
              id: 'comic-bundles',
              library: 'comics',
              bundleTitlePatterns: [String.raw`\bcomics?\s+bundle\b`],
            },
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
            manga: {
              path: mangaPath,
              formatPriority: ['cbz', 'pdf', 'epub', 'mobi'],
              extInclude: ['cbz', 'pdf', 'epub', 'mobi'],
            },
          },
        }),
      })

      expect(report).toMatchObject({
        dryRun: false,
        selectedCandidates: 3,
        wouldMove: 0,
        moved: 3,
        missing: 0,
        conflicts: 0,
      })
      for (const item of misplaced) {
        const sourcePath = path.join(
          buildProductFolder(item.sourceRoot, item.bundleTitle, item.productTitle),
          item.filename
        )
        const destinationPath = path.join(
          buildProductFolder(item.destinationRoot, item.bundleTitle, item.productTitle),
          item.filename
        )
        expect(await pathExists(sourcePath)).toBe(false)
        expect(await readFile(destinationPath, 'utf8')).toBe(item.filename)
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('canonicalizes an equivalent local format without renaming it to the remote extension', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Book Bundle: PDF Only'
      const productTitle = 'Book'
      const sourcePath = path.join(booksPath, 'Humble Book Bundle - PDF Only', 'book.epub')
      const destinationPath = path.join(
        buildProductFolder(booksPath, bundleTitle, productTitle),
        'book.epub'
      )
      const remoteDestinationPath = path.join(
        buildProductFolder(booksPath, bundleTitle, productTitle),
        'book.pdf'
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'epub content')
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                {
                  cacheKey: 'order-1:book.pdf',
                  filename: 'book.pdf',
                  extension: 'pdf',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        canonical: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          metadataPath,
          routes: [
            {
              id: 'book-bundles',
              library: 'books',
              bundleTitlePatterns: [String.raw`\b(?:book bundle|ebooks?|e-books?|novels?)\b`],
            },
          ],
          libraries: {
            books: {
              path: booksPath,
              formatPriority: ['epub', 'pdf', 'mobi'],
              extInclude: ['epub', 'pdf', 'mobi'],
            },
          },
        }),
      })

      expect(report.conflicts).toBe(0)
      expect(report.moved).toBe(1)
      expect(report.actions[0]).toMatchObject({
        filename: 'book.epub',
        sourcePath,
        destinationPath,
        status: 'moved',
      })
      expect(await pathExists(sourcePath)).toBe(false)
      expect(await readFile(destinationPath, 'utf8')).toBe('epub content')
      expect(await pathExists(remoteDestinationPath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('finds unique legacy equivalent files outside the inferred bundle folder', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Star Trek 2019 by IDW Publishing'
      const existingProducts = [
        {
          productTitle: 'Star Trek: Waypoint Vol. 1',
          filename: 'startrek_waypoint_vol1.cbz',
        },
        {
          productTitle: 'Star Trek: The Q Conflict #1',
          filename: 'startrek_theqconflict_issue1.cbz',
        },
      ]
      const legacyProductTitle = 'Star Trek: New Visions Vol. 1'
      const remoteFilename = 'startrek_newvisions_vol1.pdf'
      const legacyFilename = 'startrek_newvisions_vol1.cbz'
      const legacySourcePath = path.join(comicsPath, 'STAR TREK 2019', legacyFilename)
      const legacyDestinationPath = path.join(
        buildProductFolder(comicsPath, bundleTitle, legacyProductTitle),
        legacyFilename
      )

      for (const product of existingProducts) {
        const filePath = path.join(
          buildProductFolder(comicsPath, bundleTitle, product.productTitle),
          product.filename
        )
        await mkdir(path.dirname(filePath), { recursive: true })
        await writeFile(filePath, product.filename)
      }
      await mkdir(path.dirname(legacySourcePath), { recursive: true })
      await writeFile(legacySourcePath, 'legacy cbz')
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            ...existingProducts.map((product) => ({
              productTitle: product.productTitle,
              downloads: [
                {
                  cacheKey: `order-1:${product.filename}`,
                  filename: product.filename,
                  extension: 'cbz',
                  platform: 'ebook',
                },
              ],
            })),
            {
              productTitle: legacyProductTitle,
              downloads: [
                {
                  cacheKey: `order-1:${remoteFilename}`,
                  filename: remoteFilename,
                  extension: 'pdf',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        canonical: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          metadataPath,
          routes: [
            {
              id: 'comic-bundles',
              library: 'comics',
              bundleTitlePatterns: [String.raw`\bcomics?\s+bundle\b`],
            },
          ],
          libraries: {
            comics: {
              path: comicsPath,
              formatPriority: ['cbz', 'pdf'],
              extInclude: ['cbz', 'pdf'],
            },
          },
        }),
      })

      expect(report).toMatchObject({
        moved: 1,
        conflicts: 0,
        missing: 0,
      })
      expect(report.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: legacyFilename,
            sourcePath: legacySourcePath,
            destinationPath: legacyDestinationPath,
            status: 'moved',
          }),
        ])
      )
      expect(await pathExists(legacySourcePath)).toBe(false)
      expect(await readFile(legacyDestinationPath, 'utf8')).toBe('legacy cbz')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('canonicalizes path casing when source and destination differ only by case', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'The NaNoWriMo Writing Bundle'
      const productTitle = 'Writing Humor'
      const filename = 'writinghumor.epub'
      const sourcePath = path.join(
        booksPath,
        'THE NANOWRIMO WRITING BUNDLE',
        productTitle,
        filename
      )
      const destinationPath = path.join(
        buildProductFolder(booksPath, bundleTitle, productTitle),
        filename
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'epub content')
      await writeMetadata(metadataPath, {
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
                  extension: 'epub',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        canonical: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          metadataPath,
          routes: [
            {
              id: 'book-bundles',
              library: 'books',
              bundleTitlePatterns: [String.raw`\bnanowrimo\b`],
            },
          ],
          libraries: {
            books: {
              path: booksPath,
              formatPriority: ['epub', 'pdf', 'mobi'],
              extInclude: ['epub', 'pdf', 'mobi'],
            },
          },
        }),
      })

      expect(report).toMatchObject({
        moved: 1,
        alreadyCorrect: 0,
        conflicts: 0,
      })
      const libraryEntries = await readdir(booksPath)
      expect(libraryEntries).toContain('The NaNoWriMo Writing Bundle')
      expect(libraryEntries).not.toContain('THE NANOWRIMO WRITING BUNDLE')
      expect(await readFile(destinationPath, 'utf8')).toBe('epub content')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
