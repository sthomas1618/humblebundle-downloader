import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import { resolveConfig, type ConflictResolutionMode } from '../src/config'
import { organizeLibrary } from '../src/organize/organize'
import { buildProductFolder, cleanName } from '../src/utils/fs'

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

async function writeConfig(configPath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, JSON.stringify(data, undefined, 2))
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

async function setupKnownMd5FlatConflict({
  temporaryDirectory,
  libraryLayout,
  flatConflictResolution,
}: {
  temporaryDirectory: string
  libraryLayout?: 'bundle' | 'flat'
  flatConflictResolution?: ConflictResolutionMode
}): Promise<{
  comicsPath: string
  configPath: string
  metadataPath: string
  sourcePath: string
  destinationPath: string
  sourceContents: string
  destinationContents: string
}> {
  const comicsPath = path.join(temporaryDirectory, 'Comics')
  const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
  const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
  const productTitle = 'Saga Vol. 1'
  const filename = 'saga_vol1.cbz'
  const sourceContents = 'known source'
  const destinationContents = 'larger unknown destination'
  const sourcePath = path.join(
    buildProductFolder(comicsPath, 'Humble Comics Bundle: Saga by Image Comics', productTitle),
    filename
  )
  const destinationPath = path.join(comicsPath, 'Image Comics', 'Saga', filename)
  await mkdir(path.dirname(sourcePath), { recursive: true })
  await mkdir(path.dirname(destinationPath), { recursive: true })
  await writeFile(sourcePath, sourceContents)
  await writeFile(destinationPath, destinationContents)
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      defaultLibrary: 'comics',
      ...(flatConflictResolution ? { flatConflictResolution } : {}),
      libraries: {
        comics: {
          path: 'Comics',
          ...(libraryLayout ? { layout: libraryLayout } : {}),
          extInclude: ['cbz'],
        },
      },
    })
  )
  await writeMetadata(metadataPath, {
    'order-1': {
      orderId: 'order-1',
      bundleTitle: 'Humble Comics Bundle: Saga by Image Comics',
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
    'order-2': {
      orderId: 'order-2',
      bundleTitle: 'Humble Comics Bundle: Image Favorites by Image Comics',
      updatedAt: new Date().toISOString(),
      products: [
        {
          productTitle,
          downloads: [
            {
              cacheKey: `order-2:${filename}`,
              filename,
              extension: 'cbz',
              platform: 'ebook',
              md5: md5(sourceContents),
            },
          ],
        },
      ],
    },
  })

  return {
    comicsPath,
    configPath,
    metadataPath,
    sourcePath,
    destinationPath,
    sourceContents,
    destinationContents,
  }
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

  it('uses observed publisher variants to choose one flat publisher folder', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const idwFile = path.join(
        buildProductFolder(comicsPath, 'Humble Comics Bundle: Godzilla by IDW', 'Godzilla Vol. 1'),
        'godzilla_vol1.cbz'
      )
      const idwPublishingFile = path.join(
        buildProductFolder(
          comicsPath,
          'Humble Comics Bundle: Star Trek 2019 by IDW Publishing',
          'Star Trek Vol. 1'
        ),
        'startrek_vol1.cbz'
      )
      for (const filePath of [idwFile, idwPublishingFile]) {
        await mkdir(path.dirname(filePath), { recursive: true })
        await writeFile(filePath, path.basename(filePath))
      }
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Comics Bundle: Godzilla by IDW',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Godzilla Vol. 1',
              downloads: [
                {
                  cacheKey: 'order-1:godzilla_vol1.cbz',
                  filename: 'godzilla_vol1.cbz',
                  extension: 'cbz',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
        'order-2': {
          orderId: 'order-2',
          bundleTitle: 'Humble Comics Bundle: Star Trek 2019 by IDW Publishing',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Star Trek Vol. 1',
              downloads: [
                {
                  cacheKey: 'order-2:startrek_vol1.cbz',
                  filename: 'startrek_vol1.cbz',
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

      expect(report.actions.map((action) => action.destinationPath).sort()).toEqual(
        [
          path.join(comicsPath, 'IDW', 'Godzilla', 'godzilla_vol1.cbz'),
          path.join(comicsPath, 'IDW', 'Star Trek', 'startrek_vol1.cbz'),
        ].sort()
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

  it('removes same-size legacy bundle duplicates when a flat destination exists', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Saga by Image Comics'
      const productTitle = 'Saga Vol. 1'
      const filename = 'saga_vol1.cbz'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        filename
      )
      const destinationPath = path.join(comicsPath, 'Image Comics', 'Saga', filename)
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await mkdir(path.dirname(destinationPath), { recursive: true })
      await writeFile(sourcePath, 'same content')
      await writeFile(destinationPath, 'same content')
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: path.relative(temporaryDirectory, comicsPath),
              formatPriority: ['cbz'],
              extInclude: ['cbz'],
            },
          },
        })
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
        apply: true,
        flat: true,
        config: resolveConfig({
          configPath,
          mediaRoot: temporaryDirectory,
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

      expect(report.removedDuplicate).toBe(1)
      expect(report.conflicts).toBe(0)
      expect(report.actions[0]).toMatchObject({
        status: 'removed-duplicate',
        sourcePath,
        destinationPath,
      })
      expect(await pathExists(sourcePath)).toBe(false)
      expect(await pathExists(path.dirname(sourcePath))).toBe(false)
      expect(await readFile(destinationPath, 'utf8')).toBe('same content')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('moves supplementary local formats during flat organize', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Book Bundle: Game Development by Packt'
      const productTitle = 'Lighting in Unity'
      const supplementPath = path.join(
        buildProductFolder(booksPath, bundleTitle, productTitle),
        'lighting_video.zip'
      )
      const bundleFolder = path.join(booksPath, cleanName(bundleTitle))
      const destinationPath = path.join(booksPath, 'Packt', productTitle, 'lighting_video.zip')
      await mkdir(path.dirname(supplementPath), { recursive: true })
      await writeFile(supplementPath, 'zip content')
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'books',
          libraries: {
            books: {
              path: 'Books',
              formatPriority: ['epub'],
              extInclude: ['epub'],
            },
          },
        })
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
                {
                  cacheKey: 'order-1:lighting.epub',
                  filename: 'lighting.epub',
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
        flat: true,
        config: resolveConfig({
          configPath,
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'books',
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              formatPriority: ['epub'],
              extInclude: ['epub'],
            },
          },
        }),
      })

      expect(report.moved + report.movedSupplement).toBe(1)
      expect(await pathExists(supplementPath)).toBe(false)
      expect(await pathExists(bundleFolder)).toBe(false)
      expect(await readFile(destinationPath, 'utf8')).toBe('zip content')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('moves single-level flat leftovers by exact metadata filename match', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const sourcePath = path.join(booksPath, 'STAND WITH UKRAINE BUNDLE (Books)', 'theblight.pdf')
      const destinationPath = path.join(booksPath, 'humble', 'The Blight', 'theblight.pdf')
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'the blight')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'books',
        libraries: { books: { path: 'Books', layout: 'flat', extInclude: ['pdf'] } },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Stand with Ukraine Bundle',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'The Blight',
              downloads: [
                {
                  cacheKey: 'order-1:theblight.pdf',
                  filename: 'theblight.pdf',
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
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              layout: 'flat',
              extInclude: ['pdf'],
            },
          },
        }),
      })

      expect(report.moved + report.movedSupplement).toBe(1)
      expect(await readFile(destinationPath, 'utf8')).toBe('the blight')
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('moves single-level alternate formats by unique metadata stem without renaming', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const sourcePath = path.join(
        booksPath,
        "DEVOPS BY O'REILLY",
        'designingdistributedsystems.mobi'
      )
      const destinationPath = path.join(
        booksPath,
        'OReilly',
        'Designing Distributed Systems',
        'designingdistributedsystems.mobi'
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'mobi')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'books',
        libraries: {
          books: { path: 'Books', layout: 'flat', extInclude: ['epub', 'pdf', 'mobi'] },
        },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: "Humble Book Bundle: DevOps by O'Reilly",
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Designing Distributed Systems',
              downloads: [
                {
                  cacheKey: 'order-1:designingdistributedsystems.epub',
                  filename: 'designingdistributedsystems.epub',
                  extension: 'epub',
                  platform: 'ebook',
                },
                {
                  cacheKey: 'order-1:designingdistributedsystems.pdf',
                  filename: 'designingdistributedsystems.pdf',
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
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              layout: 'flat',
              extInclude: ['epub', 'pdf', 'mobi'],
            },
          },
        }),
      })

      expect(report.movedSupplement).toBe(1)
      expect(await readFile(destinationPath, 'utf8')).toBe('mobi')
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('moves legacy Humble archive zips by normalized archive stem', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const sourcePath = path.join(
        comicsPath,
        'DYNAMITE 20TH ANNIVERSARY 20,000-PAGE MEGA BUNDLE',
        'projectsuperpowers_vol1_cbz_1403295425.zip'
      )
      const destinationPath = path.join(
        comicsPath,
        'humble',
        'Project Superpowers',
        'projectsuperpowers_vol1_cbz_1403295425.zip'
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'legacy archive')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'comics',
        libraries: { comics: { path: 'Comics', layout: 'flat', extInclude: ['pdf', 'zip'] } },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Comics Bundle: Dynamite 20th Anniversary 20,000-Page Mega Bundle',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Project Superpowers, Vol. 1',
              downloads: [
                {
                  cacheKey: 'order-1:projectsuperpowers_svol1_1403556328.pdf',
                  filename: 'projectsuperpowers_svol1_1403556328.pdf',
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
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              layout: 'flat',
              extInclude: ['pdf', 'zip'],
            },
          },
        }),
      })

      expect(report.movedSupplement).toBe(1)
      expect(report.untracked).toBe(0)
      expect(await readFile(destinationPath, 'utf8')).toBe('legacy archive')
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('removes same-size legacy Humble archive zip duplicates', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const filename = 'projectsuperpowers_vol1_cbz_1403295425.zip'
      const sourcePath = path.join(
        comicsPath,
        'DYNAMITE 20TH ANNIVERSARY 20,000-PAGE MEGA BUNDLE',
        filename
      )
      const expectedDestinationPath = path.join(
        comicsPath,
        'humble',
        'Project Superpowers',
        filename
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await mkdir(path.dirname(expectedDestinationPath), { recursive: true })
      await writeFile(sourcePath, 'same archive')
      await writeFile(expectedDestinationPath, 'same archive')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'comics',
        libraries: { comics: { path: 'Comics', layout: 'flat', extInclude: ['pdf', 'zip'] } },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Comics Bundle: Dynamite 20th Anniversary 20,000-Page Mega Bundle',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Project Superpowers, Vol. 1',
              downloads: [
                {
                  cacheKey: 'order-1:projectsuperpowers_svol1_1403556328.pdf',
                  filename: 'projectsuperpowers_svol1_1403556328.pdf',
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
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              layout: 'flat',
              extInclude: ['pdf', 'zip'],
            },
          },
        }),
      })

      expect(report.removedDuplicate).toBe(1)
      expect(await readFile(expectedDestinationPath, 'utf8')).toBe('same archive')
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('routes single-level leftovers across configured flat libraries', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const sourcePath = path.join(
        booksPath,
        'GET THE VOTE OUT! SUPPORTING THE ACLU',
        'bitchplanet_vol1.cbz'
      )
      const destinationPath = path.join(
        comicsPath,
        'humble',
        'Bitch Planet',
        'bitchplanet_vol1.cbz'
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'comic')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'books',
        routes: [{ extensions: ['cbz'], library: 'comics' }],
        libraries: {
          books: { path: 'Books', layout: 'flat', extInclude: ['epub', 'pdf', 'mobi'] },
          comics: { path: 'Comics', layout: 'flat', extInclude: ['cbz'] },
        },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Book Bundle: Get the Vote Out! supporting the ACLU',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Bitch Planet Vol. 1: Extraordinary Machine',
              downloads: [
                {
                  cacheKey: 'order-1:bitchplanet_vol1.cbz',
                  filename: 'bitchplanet_vol1.cbz',
                  extension: 'cbz',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          routes: [{ extensions: ['cbz'], library: 'comics' }],
          libraries: {
            books: {
              path: booksPath,
              layout: 'flat',
              extInclude: ['epub', 'pdf', 'mobi'],
            },
            comics: {
              path: comicsPath,
              layout: 'flat',
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.moved).toBe(1)
      expect(await readFile(destinationPath, 'utf8')).toBe('comic')
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('reports ambiguous legacy Humble archive stem matches without moving them', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const sourcePath = path.join(
        comicsPath,
        'DYNAMITE 20TH ANNIVERSARY 20,000-PAGE MEGA BUNDLE',
        'shared_vol1_cbz_1403295425.zip'
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'ambiguous archive')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'comics',
        libraries: { comics: { path: 'Comics', layout: 'flat', extInclude: ['pdf', 'zip'] } },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Comics Bundle: Dynamite 20th Anniversary 20,000-Page Mega Bundle',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'First Shared',
              downloads: [
                {
                  cacheKey: 'order-1:shared_svol1_1403556328.pdf',
                  filename: 'shared_svol1_1403556328.pdf',
                  extension: 'pdf',
                  platform: 'ebook',
                },
              ],
            },
            {
              productTitle: 'Second Shared',
              downloads: [
                {
                  cacheKey: 'order-1:shared_vol01_1403556328.pdf',
                  filename: 'shared_vol01_1403556328.pdf',
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
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              layout: 'flat',
              extInclude: ['pdf', 'zip'],
            },
          },
        }),
      })

      expect(report.ambiguous).toBe(1)
      expect(report.movedSupplement).toBe(0)
      expect(await readFile(sourcePath, 'utf8')).toBe('ambiguous archive')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('removes same-size single-level leftover duplicates', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const sourcePath = path.join(booksPath, 'GAME DEVELOPMENT BY PACKT', 'godot.mobi')
      const destinationPath = path.join(booksPath, 'Packt', 'Godot', 'godot.mobi')
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await mkdir(path.dirname(destinationPath), { recursive: true })
      await writeFile(sourcePath, 'same')
      await writeFile(destinationPath, 'same')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'books',
        libraries: { books: { path: 'Books', layout: 'flat', extInclude: ['mobi'] } },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Book Bundle: Game Development by Packt',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Godot',
              downloads: [
                {
                  cacheKey: 'order-1:godot.mobi',
                  filename: 'godot.mobi',
                  extension: 'mobi',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              layout: 'flat',
              extInclude: ['mobi'],
            },
          },
        }),
      })

      expect(report.removedDuplicate).toBe(1)
      expect(await readFile(destinationPath, 'utf8')).toBe('same')
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('resolves single-level leftover destination conflicts with the effective conflict mode', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const sourcePath = path.join(booksPath, 'GAME DEVELOPMENT BY PACKT', 'godot.mobi')
      const destinationPath = path.join(booksPath, 'Packt', 'Godot', 'godot.mobi')
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await mkdir(path.dirname(destinationPath), { recursive: true })
      await writeFile(sourcePath, 'larger source')
      await writeFile(destinationPath, 'small')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'books',
        libraries: { books: { path: 'Books', layout: 'flat', extInclude: ['mobi'] } },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Book Bundle: Game Development by Packt',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Godot',
              downloads: [
                {
                  cacheKey: 'order-1:godot.mobi',
                  filename: 'godot.mobi',
                  extension: 'mobi',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        flat: true,
        resolveConflicts: 'prefer-largest',
        config: resolveConfig({
          defaultLibrary: 'books',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              layout: 'flat',
              extInclude: ['mobi'],
            },
          },
        }),
      })

      expect(report.resolvedConflict).toBe(1)
      expect(await readFile(destinationPath, 'utf8')).toBe('larger source')
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('coalesces same-size planned single-level leftover destinations', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const filename = 'drawingcomicslab.mobi'
      const sourcePaths = [
        path.join(booksPath, 'CREATING COMICS, MANGA, & ANIMATION', filename),
        path.join(booksPath, 'CREATING COMICS, MANGA, & ANIMATION BY QUARTO', filename),
        path.join(booksPath, 'HOW TO START DRAWING WITH WALTER FOSTER', filename),
      ]
      for (const sourcePath of sourcePaths) {
        await mkdir(path.dirname(sourcePath), { recursive: true })
        await writeFile(sourcePath, 'same file')
      }
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'books',
        libraries: { books: { path: 'Books', layout: 'flat', extInclude: ['mobi'] } },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Book Bundle: Creating Comics, Manga, & Animation by Quarto',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Drawing Comics Lab',
              downloads: [
                {
                  cacheKey: `order-1:${filename}`,
                  filename,
                  extension: 'mobi',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              layout: 'flat',
              extInclude: ['mobi'],
            },
          },
        }),
      })

      const destinationPath = path.join(booksPath, 'Quarto', 'Drawing Comics Lab', filename)
      expect(report.movedSupplement).toBe(1)
      expect(report.removedDuplicate).toBe(2)
      expect(report.conflicts).toBe(0)
      expect(await readFile(destinationPath, 'utf8')).toBe('same file')
      for (const sourcePath of sourcePaths) {
        expect(await pathExists(sourcePath)).toBe(false)
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('uses known md5 before largest for planned single-level leftover collisions', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const filename = 'drawingcomicslab.mobi'
      const knownContents = 'known'
      const largerContents = 'larger unknown file'
      const largerSourcePath = path.join(booksPath, 'AAA QUARTO LEFTOVER', filename)
      const knownSourcePath = path.join(booksPath, 'BBB QUARTO LEFTOVER', filename)
      await mkdir(path.dirname(largerSourcePath), { recursive: true })
      await mkdir(path.dirname(knownSourcePath), { recursive: true })
      await writeFile(largerSourcePath, largerContents)
      await writeFile(knownSourcePath, knownContents)
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'books',
        libraries: { books: { path: 'Books', layout: 'flat', extInclude: ['mobi'] } },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Book Bundle: Creating Comics, Manga, & Animation by Quarto',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Drawing Comics Lab',
              downloads: [
                {
                  cacheKey: `order-1:${filename}`,
                  filename,
                  extension: 'mobi',
                  platform: 'ebook',
                  md5: md5(knownContents),
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              layout: 'flat',
              extInclude: ['mobi'],
            },
          },
        }),
      })

      const destinationPath = path.join(booksPath, 'Quarto', 'Drawing Comics Lab', filename)
      expect(report.movedSupplement).toBe(1)
      expect(report.resolvedConflict).toBe(1)
      expect(report.conflicts).toBe(0)
      expect(await readFile(destinationPath, 'utf8')).toBe(knownContents)
      expect(await pathExists(largerSourcePath)).toBe(false)
      expect(await pathExists(knownSourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('falls back to largest for planned single-level leftover collisions', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const filename = 'drawingcomicslab.mobi'
      const smallerSourcePath = path.join(booksPath, 'AAA QUARTO LEFTOVER', filename)
      const largerSourcePath = path.join(booksPath, 'BBB QUARTO LEFTOVER', filename)
      await mkdir(path.dirname(smallerSourcePath), { recursive: true })
      await mkdir(path.dirname(largerSourcePath), { recursive: true })
      await writeFile(smallerSourcePath, 'small')
      await writeFile(largerSourcePath, 'larger file')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'books',
        libraries: { books: { path: 'Books', layout: 'flat', extInclude: ['mobi'] } },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Book Bundle: Creating Comics, Manga, & Animation by Quarto',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Drawing Comics Lab',
              downloads: [
                {
                  cacheKey: `order-1:${filename}`,
                  filename,
                  extension: 'mobi',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              layout: 'flat',
              extInclude: ['mobi'],
            },
          },
        }),
      })

      const destinationPath = path.join(booksPath, 'Quarto', 'Drawing Comics Lab', filename)
      expect(report.movedSupplement).toBe(1)
      expect(report.resolvedConflict).toBe(1)
      expect(report.conflicts).toBe(0)
      expect(await readFile(destinationPath, 'utf8')).toBe('larger file')
      expect(await pathExists(smallerSourcePath)).toBe(false)
      expect(await pathExists(largerSourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('reports planned single-level leftover collisions in report mode', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const filename = 'drawingcomicslab.mobi'
      const firstSourcePath = path.join(booksPath, 'AAA QUARTO LEFTOVER', filename)
      const secondSourcePath = path.join(booksPath, 'BBB QUARTO LEFTOVER', filename)
      await mkdir(path.dirname(firstSourcePath), { recursive: true })
      await mkdir(path.dirname(secondSourcePath), { recursive: true })
      await writeFile(firstSourcePath, 'small')
      await writeFile(secondSourcePath, 'larger file')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'books',
        flatConflictResolution: 'report',
        libraries: { books: { path: 'Books', layout: 'flat', extInclude: ['mobi'] } },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Book Bundle: Creating Comics, Manga, & Animation by Quarto',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Drawing Comics Lab',
              downloads: [
                {
                  cacheKey: `order-1:${filename}`,
                  filename,
                  extension: 'mobi',
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
          flatConflictResolution: 'report',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              layout: 'flat',
              extInclude: ['mobi'],
            },
          },
        }),
      })

      expect(report.wouldMoveSupplement).toBe(1)
      expect(report.conflicts).toBe(1)
      expect(report.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'conflict',
            reason:
              'Multiple leftover files map to the same flat destination with different sizes.',
          }),
        ])
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('moves creator and topic publisher leftovers into canonical flat folders', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const mangaPath = path.join(temporaryDirectory, 'Manga')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const proseSourcePath = path.join(
        booksPath,
        'NISIOISIN from Kodansha',
        'KIZUMONOGATARI',
        'kizumonogatari.epub'
      )
      const mangaSourcePath = path.join(
        booksPath,
        'NISIOISIN from Kodansha',
        'BAKEMONOGATARI manga',
        'bakemonogatari_vol1.epub'
      )
      const taylorSourcePath = path.join(
        booksPath,
        'Game Programming by Taylor & Francis',
        '3dgameenvironments.prc'
      )
      await mkdir(path.dirname(proseSourcePath), { recursive: true })
      await mkdir(path.dirname(mangaSourcePath), { recursive: true })
      await mkdir(path.dirname(taylorSourcePath), { recursive: true })
      await writeFile(proseSourcePath, 'prose')
      await writeFile(mangaSourcePath, 'manga')
      await writeFile(taylorSourcePath, 'taylor')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'books',
        routes: [
          {
            id: 'book-bundles',
            library: 'books',
            bundleTitlePatterns: [String.raw`\bbook bundle\b`],
          },
          {
            id: 'manga-products',
            library: 'manga',
            productTitlePatterns: [String.raw`\bmanga\b`],
            filenamePatterns: [String.raw`\bmanga\b`],
          },
          {
            id: 'ebook-formats',
            library: 'books',
            extensions: ['epub', 'mobi', 'prc'],
          },
        ],
        libraries: {
          books: { path: 'Books', layout: 'flat', extInclude: ['epub', 'pdf', 'mobi', 'prc'] },
          manga: { path: 'Manga', layout: 'flat', extInclude: ['epub', 'pdf', 'cbz'] },
        },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle:
            'Humble Book Bundle: MONOGATARI - Supernatural Light Novels by NISIOISIN from Kodansha',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'KIZUMONOGATARI',
              downloads: [
                {
                  cacheKey: 'order-1:kizumonogatari.epub',
                  filename: 'kizumonogatari.epub',
                  extension: 'epub',
                  platform: 'ebook',
                },
              ],
            },
            {
              productTitle: 'BAKEMONOGATARI (manga), volume 1',
              downloads: [
                {
                  cacheKey: 'order-1:bakemonogatari_vol1.epub',
                  filename: 'bakemonogatari_vol1.epub',
                  extension: 'epub',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
        'order-2': {
          orderId: 'order-2',
          bundleTitle: 'Humble Tech Book Bundle: Game Programming by Taylor & Francis',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: '3D Game Environments',
              downloads: [
                {
                  cacheKey: 'order-2:3dgameenvironments.prc',
                  filename: '3dgameenvironments.prc',
                  extension: 'prc',
                  platform: 'ebook',
                },
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
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'books',
          metadataPath,
          routes: [
            {
              id: 'book-bundles',
              library: 'books',
              bundleTitlePatterns: [String.raw`\bbook bundle\b`],
            },
            {
              id: 'manga-products',
              library: 'manga',
              productTitlePatterns: [String.raw`\bmanga\b`],
              filenamePatterns: [String.raw`\bmanga\b`],
            },
            {
              id: 'ebook-formats',
              library: 'books',
              extensions: ['epub', 'mobi', 'prc'],
            },
          ],
          libraries: {
            books: {
              path: booksPath,
              layout: 'flat',
              extInclude: ['epub', 'pdf', 'mobi', 'prc'],
            },
            manga: {
              path: mangaPath,
              layout: 'flat',
              extInclude: ['epub', 'pdf', 'cbz'],
            },
          },
        }),
      })

      expect(report.moved).toBe(3)
      expect(
        await readFile(
          path.join(booksPath, 'Kodansha', 'KIZUMONOGATARI', 'kizumonogatari.epub'),
          'utf8'
        )
      ).toBe('prose')
      expect(
        await readFile(
          path.join(mangaPath, 'Kodansha', 'BAKEMONOGATARI manga', 'bakemonogatari_vol1.epub'),
          'utf8'
        )
      ).toBe('manga')
      expect(
        await readFile(
          path.join(booksPath, 'Taylor Francis', '3D Game Environments', '3dgameenvironments.prc'),
          'utf8'
        )
      ).toBe('taylor')
      expect(await pathExists(path.join(booksPath, 'NISIOISIN from Kodansha'))).toBe(false)
      expect(await pathExists(path.join(booksPath, 'Game Programming by Taylor & Francis'))).toBe(
        false
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('reports ambiguous and untracked single-level leftovers without moving them', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const ambiguousPath = path.join(booksPath, 'ASP NET', 'shared.pdf')
      const untrackedPath = path.join(booksPath, 'ASP NET', 'manual.pdf')
      await mkdir(path.dirname(ambiguousPath), { recursive: true })
      await writeFile(ambiguousPath, 'ambiguous')
      await writeFile(untrackedPath, 'manual')
      await writeConfig(configPath, {
        version: 1,
        defaultLibrary: 'books',
        libraries: { books: { path: 'Books', layout: 'flat', extInclude: ['pdf'] } },
      })
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Book Bundle: Programming by Packt',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'First Product',
              downloads: [
                {
                  cacheKey: 'order-1:shared.pdf',
                  filename: 'shared.pdf',
                  extension: 'pdf',
                  platform: 'ebook',
                },
              ],
            },
            {
              productTitle: 'Second Product',
              downloads: [
                {
                  cacheKey: 'order-1:shared.pdf',
                  filename: 'shared.pdf',
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
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'books',
          configPath,
          mediaRoot: temporaryDirectory,
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              layout: 'flat',
              extInclude: ['pdf'],
            },
          },
        }),
      })

      expect(report.ambiguous).toBe(1)
      expect(report.untracked).toBe(1)
      expect(await readFile(ambiguousPath, 'utf8')).toBe('ambiguous')
      expect(await readFile(untrackedPath, 'utf8')).toBe('manual')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('does not scan valid uppercase publisher folders as single-level leftovers', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const sourcePath = path.join(comicsPath, 'IDW', 'Godzilla', 'godzilla_halfcenturywar.cbz')
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await writeFile(sourcePath, 'cbz')
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Comics Bundle: Godzilla by IDW',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Godzilla: Half Century War',
              downloads: [
                {
                  cacheKey: 'order-1:godzilla_halfcenturywar.pdf',
                  filename: 'godzilla_halfcenturywar.pdf',
                  extension: 'pdf',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: false,
        flat: true,
        config: resolveConfig({
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              layout: 'flat',
              extInclude: ['cbz', 'pdf'],
            },
          },
        }),
      })

      expect(report.untracked).toBe(0)
      expect(report.ambiguous).toBe(0)
      expect(report.wouldMoveSupplement).toBe(0)
      expect(await pathExists(sourcePath)).toBe(true)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('removes empty legacy bundle trees during flat apply', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Stand with Ukraine Bundle'
      const emptyProductFolder = path.join(
        buildProductFolder(booksPath, bundleTitle, 'Empty Product'),
        'nested'
      )
      const bundleFolder = path.join(booksPath, 'Stand with Ukraine Bundle')
      await mkdir(emptyProductFolder, { recursive: true })
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'books',
          libraries: {
            books: {
              path: 'Books',
              extInclude: ['epub'],
            },
          },
        })
      )
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle,
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Empty Product',
              downloads: [
                {
                  cacheKey: 'order-1:empty.epub',
                  filename: 'empty.epub',
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
        flat: true,
        config: resolveConfig({
          configPath,
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'books',
          metadataPath,
          libraries: {
            books: {
              path: booksPath,
              extInclude: ['epub'],
            },
          },
        }),
      })

      expect(report.removedEmptyFolder).toBeGreaterThanOrEqual(2)
      expect(await pathExists(bundleFolder)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('removes empty folders under unknown Humble legacy bundle trees', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const legacyFolder = path.join(
        comicsPath,
        'Humble Comics Bundle - Retired Bundle',
        'Empty Product'
      )
      await mkdir(legacyFolder, { recursive: true })
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: 'Comics',
              extInclude: ['cbz'],
            },
          },
        })
      )
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Comics Bundle: Current Bundle by Example',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Locke & Key, Vol 6',
              downloads: [
                {
                  cacheKey: 'order-1:lockeandkey_vol6.epub',
                  filename: 'lockeandkey_vol6.epub',
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
        flat: true,
        config: resolveConfig({
          configPath,
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.removedEmptyFolder).toBeGreaterThanOrEqual(2)
      expect(await pathExists(path.join(comicsPath, 'Humble Comics Bundle - Retired Bundle'))).toBe(
        false
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('merges flat publisher alias folders into the canonical publisher folder', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const canonicalFile = path.join(comicsPath, 'IDW', 'Locke Key', 'lockeandkey_vol1.cbz')
      const aliasFile = path.join(
        comicsPath,
        'IDW Publishing',
        'Locke Key',
        'lockeandkey_vol1_welcometolovecraft.pdf'
      )
      const megabundleFile = path.join(
        comicsPath,
        'IDW 25th Anniversary Megabundle',
        'lockeandkey_vol6.cbz'
      )
      const kodanshaFile = path.join(
        comicsPath,
        'Kodansha Comics',
        'Clockwork Planet',
        'clockworkplanet_vol1.cbz'
      )
      await mkdir(path.dirname(canonicalFile), { recursive: true })
      await mkdir(path.dirname(aliasFile), { recursive: true })
      await mkdir(path.dirname(megabundleFile), { recursive: true })
      await mkdir(path.join(comicsPath, 'Kodansha'), { recursive: true })
      await mkdir(path.dirname(kodanshaFile), { recursive: true })
      await writeFile(canonicalFile, 'canonical')
      await writeFile(aliasFile, 'alias pdf')
      await writeFile(megabundleFile, 'alias cbz')
      await writeFile(kodanshaFile, 'kodansha alias')
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: 'Comics',
              extInclude: ['cbz', 'pdf'],
            },
          },
        })
      )
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Comics Bundle: Current Bundle by Example',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Locke & Key, Vol 6',
              downloads: [
                {
                  cacheKey: 'order-1:lockeandkey_vol6.epub',
                  filename: 'lockeandkey_vol6.epub',
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
        flat: true,
        config: resolveConfig({
          configPath,
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz', 'pdf'],
            },
          },
        }),
      })

      expect(report.movedSupplement).toBe(3)
      expect(
        await readFile(path.join(comicsPath, 'IDW', 'Locke Key', path.basename(aliasFile)), 'utf8')
      ).toBe('alias pdf')
      expect(
        await readFile(
          path.join(comicsPath, 'IDW', 'Locke Key', path.basename(megabundleFile)),
          'utf8'
        )
      ).toBe('alias cbz')
      expect(
        await readFile(
          path.join(comicsPath, 'Kodansha', 'Clockwork Planet', path.basename(kodanshaFile)),
          'utf8'
        )
      ).toBe('kodansha alias')
      expect(await pathExists(path.join(comicsPath, 'IDW Publishing'))).toBe(false)
      expect(await pathExists(path.join(comicsPath, 'IDW 25th Anniversary Megabundle'))).toBe(false)
      expect(await pathExists(path.join(comicsPath, 'Kodansha Comics'))).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('removes publisher alias duplicates that are satisfied by routed flat libraries', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const mangaPath = path.join(temporaryDirectory, 'Manga')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const sourcePath = path.join(comicsPath, 'Kodansha Comics', 'Parasyte', 'parasyte_vol1.cbz')
      const destinationPath = path.join(mangaPath, 'Kodansha', 'Parasyte', 'parasyte_vol1.cbz')
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await mkdir(path.dirname(destinationPath), { recursive: true })
      await writeFile(sourcePath, 'same content')
      await writeFile(destinationPath, 'same content')
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'manga',
          libraries: {
            comics: {
              path: 'Comics',
              extInclude: ['cbz'],
            },
            manga: {
              path: 'Manga',
              extInclude: ['cbz'],
            },
          },
        })
      )
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Manga Bundle: Fantasy by Kodansha Comics',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Parasyte Vol. 1',
              downloads: [
                {
                  cacheKey: 'order-1:parasyte_vol1.cbz',
                  filename: 'parasyte_vol1.cbz',
                  extension: 'cbz',
                  platform: 'ebook',
                },
              ],
            },
          ],
        },
        'order-2': {
          orderId: 'order-2',
          bundleTitle: 'Humble Manga Bundle: Isekai by Kodansha',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Different Product',
              downloads: [
                {
                  cacheKey: 'order-2:different.cbz',
                  filename: 'different.cbz',
                  extension: 'cbz',
                  platform: 'ebook',
                },
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
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'manga',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz'],
            },
            manga: {
              path: mangaPath,
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.removedDuplicate).toBe(1)
      expect(await pathExists(sourcePath)).toBe(false)
      expect(await readFile(destinationPath, 'utf8')).toBe('same content')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('removes empty publisher family folders left after flat cleanup', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const kodanshaPath = path.join(comicsPath, 'Kodansha')
      const kodanshaComicsPath = path.join(comicsPath, 'Kodansha Comics')
      const unrelatedEmptyPath = path.join(comicsPath, 'Manual Empty Publisher')
      await mkdir(path.join(kodanshaComicsPath, 'Parasyte'), { recursive: true })
      await mkdir(kodanshaPath, { recursive: true })
      await mkdir(unrelatedEmptyPath, { recursive: true })
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: 'Comics',
              extInclude: ['cbz'],
            },
          },
        })
      )
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Manga Bundle: Fantasy by Kodansha',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle: 'Parasyte Vol. 1',
              downloads: [
                {
                  cacheKey: 'order-1:parasyte_vol1.cbz',
                  filename: 'parasyte_vol1.cbz',
                  extension: 'cbz',
                  platform: 'ebook',
                },
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
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.removedEmptyFolder).toBeGreaterThanOrEqual(3)
      expect(await pathExists(kodanshaPath)).toBe(false)
      expect(await pathExists(kodanshaComicsPath)).toBe(false)
      expect(await pathExists(unrelatedEmptyPath)).toBe(true)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('quarantines conflicts when prefer-flat uses a conflict directory', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const conflictDirectory = path.join(temporaryDirectory, 'conflicts')
      const bundleTitle = 'Humble Comics Bundle: Saga by Image Comics'
      const productTitle = 'Saga Vol. 1'
      const filename = 'saga_vol1.cbz'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        filename
      )
      const destinationPath = path.join(comicsPath, 'Image Comics', 'Saga', filename)
      const quarantinePath = path.join(
        conflictDirectory,
        'comics',
        'Humble Comics Bundle - Saga by Image Comics',
        productTitle,
        filename
      )
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await mkdir(path.dirname(destinationPath), { recursive: true })
      await writeFile(sourcePath, 'legacy content')
      await writeFile(destinationPath, 'flat content')
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: 'Comics',
              extInclude: ['cbz'],
            },
          },
        })
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
        apply: true,
        flat: true,
        resolveConflicts: 'prefer-flat',
        conflictDir: conflictDirectory,
        config: resolveConfig({
          configPath,
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.quarantinedConflict).toBe(1)
      expect(await readFile(destinationPath, 'utf8')).toBe('flat content')
      expect(await readFile(quarantinePath, 'utf8')).toBe('legacy content')
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('replaces the flat file when prefer-largest selects the legacy conflict', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Saga by Image Comics'
      const productTitle = 'Saga Vol. 1'
      const filename = 'saga_vol1.cbz'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        filename
      )
      const destinationPath = path.join(comicsPath, 'Image Comics', 'Saga', filename)
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await mkdir(path.dirname(destinationPath), { recursive: true })
      await writeFile(sourcePath, 'larger legacy content')
      await writeFile(destinationPath, 'flat')
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: 'Comics',
              extInclude: ['cbz'],
            },
          },
        })
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
        apply: true,
        flat: true,
        resolveConflicts: 'prefer-largest',
        config: resolveConfig({
          configPath,
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.resolvedConflict).toBe(1)
      expect(await readFile(destinationPath, 'utf8')).toBe('larger legacy content')
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('uses metadata md5 to resolve flat conflicts', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Saga by Image Comics'
      const productTitle = 'Saga Vol. 1'
      const filename = 'saga_vol1.cbz'
      const sourceContents = 'metadata matching content'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        filename
      )
      const destinationPath = path.join(comicsPath, 'Image Comics', 'Saga', filename)
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await mkdir(path.dirname(destinationPath), { recursive: true })
      await writeFile(sourcePath, sourceContents)
      await writeFile(destinationPath, 'flat content')
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: 'Comics',
              extInclude: ['cbz'],
            },
          },
        })
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
                {
                  cacheKey: `order-1:${filename}`,
                  filename,
                  extension: 'cbz',
                  platform: 'ebook',
                  md5: md5(sourceContents),
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        flat: true,
        resolveConflicts: 'prefer-md5-match',
        config: resolveConfig({
          configPath,
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.resolvedConflict).toBe(1)
      const resolvedAction = report.actions.find((action) => action.status === 'resolved-conflict')
      expect(resolvedAction?.conflict).toMatchObject({
        action: 'replace-destination',
        sourceMd5: md5(sourceContents),
      })
      expect(await readFile(destinationPath, 'utf8')).toBe(sourceContents)
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('uses same-product metadata md5 from another bundle to resolve flat conflicts', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const productTitle = 'Saga Vol. 1'
      const filename = 'saga_vol1.cbz'
      const sourceContents = 'known source'
      const largerDestinationContents = 'larger unknown destination'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, 'Humble Comics Bundle: Saga by Image Comics', productTitle),
        filename
      )
      const destinationPath = path.join(comicsPath, 'Image Comics', 'Saga', filename)
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await mkdir(path.dirname(destinationPath), { recursive: true })
      await writeFile(sourcePath, sourceContents)
      await writeFile(destinationPath, largerDestinationContents)
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: 'Comics',
              extInclude: ['cbz'],
            },
          },
        })
      )
      await writeMetadata(metadataPath, {
        'order-1': {
          orderId: 'order-1',
          bundleTitle: 'Humble Comics Bundle: Saga by Image Comics',
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
        'order-2': {
          orderId: 'order-2',
          bundleTitle: 'Humble Comics Bundle: Image Favorites by Image Comics',
          updatedAt: new Date().toISOString(),
          products: [
            {
              productTitle,
              downloads: [
                {
                  cacheKey: `order-2:${filename}`,
                  filename,
                  extension: 'cbz',
                  platform: 'ebook',
                  md5: md5(sourceContents),
                },
              ],
            },
          ],
        },
      })

      const report = await organizeLibrary({
        apply: true,
        flat: true,
        resolveConflicts: 'prefer-known-md5',
        config: resolveConfig({
          configPath,
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.resolvedConflict).toBe(1)
      expect(await readFile(destinationPath, 'utf8')).toBe(sourceContents)
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('falls back to largest only after known md5 cannot resolve a conflict', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const comicsPath = path.join(temporaryDirectory, 'Comics')
      const configPath = path.join(temporaryDirectory, '.hbd', 'config.json')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const bundleTitle = 'Humble Comics Bundle: Saga by Image Comics'
      const productTitle = 'Saga Vol. 1'
      const filename = 'saga_vol1.cbz'
      const sourcePath = path.join(
        buildProductFolder(comicsPath, bundleTitle, productTitle),
        filename
      )
      const destinationPath = path.join(comicsPath, 'Image Comics', 'Saga', filename)
      await mkdir(path.dirname(sourcePath), { recursive: true })
      await mkdir(path.dirname(destinationPath), { recursive: true })
      await writeFile(sourcePath, 'small')
      await writeFile(destinationPath, 'larger destination')
      await mkdir(path.dirname(configPath), { recursive: true })
      await writeFile(
        configPath,
        JSON.stringify({
          version: 1,
          defaultLibrary: 'comics',
          libraries: {
            comics: {
              path: 'Comics',
              extInclude: ['cbz'],
            },
          },
        })
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
        apply: true,
        flat: true,
        resolveConflicts: 'prefer-known-md5-then-largest',
        config: resolveConfig({
          configPath,
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'comics',
          metadataPath,
          libraries: {
            comics: {
              path: comicsPath,
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.resolvedConflict).toBe(1)
      expect(await readFile(destinationPath, 'utf8')).toBe('larger destination')
      expect(await pathExists(sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('uses known-md5 then largest as the implicit conflict mode for config-backed flat libraries', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const fixture = await setupKnownMd5FlatConflict({
        temporaryDirectory,
        libraryLayout: 'flat',
      })

      const report = await organizeLibrary({
        apply: true,
        flat: true,
        config: resolveConfig({
          configPath: fixture.configPath,
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'comics',
          metadataPath: fixture.metadataPath,
          libraries: {
            comics: {
              path: fixture.comicsPath,
              layout: 'flat',
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.resolvedConflict).toBe(1)
      expect(await readFile(fixture.destinationPath, 'utf8')).toBe(fixture.sourceContents)
      expect(await pathExists(fixture.sourcePath)).toBe(false)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('lets an explicit CLI conflict mode override the flat config default', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const fixture = await setupKnownMd5FlatConflict({
        temporaryDirectory,
        libraryLayout: 'flat',
        flatConflictResolution: 'prefer-known-md5-then-largest',
      })

      const report = await organizeLibrary({
        apply: false,
        flat: true,
        resolveConflicts: 'report',
        config: resolveConfig({
          configPath: fixture.configPath,
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'comics',
          flatConflictResolution: 'prefer-known-md5-then-largest',
          metadataPath: fixture.metadataPath,
          libraries: {
            comics: {
              path: fixture.comicsPath,
              layout: 'flat',
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.conflicts).toBe(1)
      expect(report.resolvedConflict).toBe(0)
      expect(await readFile(fixture.destinationPath, 'utf8')).toBe(fixture.destinationContents)
      expect(await pathExists(fixture.sourcePath)).toBe(true)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('keeps report as the default conflict mode without a config-backed flat library', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-organize-'))

    try {
      const fixture = await setupKnownMd5FlatConflict({
        temporaryDirectory,
      })

      const report = await organizeLibrary({
        apply: false,
        flat: true,
        config: resolveConfig({
          mediaRoot: temporaryDirectory,
          defaultLibrary: 'comics',
          metadataPath: fixture.metadataPath,
          libraries: {
            comics: {
              path: fixture.comicsPath,
              extInclude: ['cbz'],
            },
          },
        }),
      })

      expect(report.conflicts).toBe(1)
      expect(report.resolvedConflict).toBe(0)
      expect(await readFile(fixture.destinationPath, 'utf8')).toBe(fixture.destinationContents)
      expect(await pathExists(fixture.sourcePath)).toBe(true)
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
        flatConflictResolution?: string
        libraries: { comics: { layout?: string } }
      }
      expect(updatedConfig.libraries.comics.layout).toBe('flat')
      expect(updatedConfig.flatConflictResolution).toBe('prefer-known-md5-then-largest')
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

  it('preserves an explicit flat conflict resolution when marking libraries flat', async () => {
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
            flatConflictResolution: 'report',
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

      await organizeLibrary({
        apply: true,
        flat: true,
        config: resolveConfig({
          configPath,
          mediaRoot,
          defaultLibrary: 'comics',
          flatConflictResolution: 'report',
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

      const updatedConfig = JSON.parse(await readFile(configPath, 'utf8')) as {
        flatConflictResolution?: string
        libraries: { comics: { layout?: string } }
      }
      expect(updatedConfig.libraries.comics.layout).toBe('flat')
      expect(updatedConfig.flatConflictResolution).toBe('report')
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
