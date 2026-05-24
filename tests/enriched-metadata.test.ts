import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'
import { ZipFile } from 'yazl'

import { resolveConfig } from '../src/config'
import {
  enrichMetadata,
  getEnrichedPublisherForProduct,
  loadEnrichedMetadata,
  resolveEnrichedMetadataPath,
} from '../src/download/enriched-metadata'

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-enriched-'))
  try {
    return await callback(temporaryDirectory)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function writeMetadata(metadataPath: string): Promise<void> {
  await writeMetadataDownloads(metadataPath, [
    {
      cacheKey: 'order-1:useful.epub',
      filename: 'useful.epub',
      extension: 'epub',
      platform: 'ebook',
    },
    {
      cacheKey: 'order-1:useful.pdf',
      filename: 'useful.pdf',
      extension: 'pdf',
      platform: 'ebook',
    },
  ])
}

async function writeMetadataDownloads(
  metadataPath: string,
  downloads: Array<{
    cacheKey: string
    filename: string
    extension: string
    platform: string
  }>
): Promise<void> {
  await mkdir(path.dirname(metadataPath), { recursive: true })
  await writeFile(
    metadataPath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        orders: {
          'order-1': {
            orderId: 'order-1',
            bundleTitle: 'Humble Book Bundle: Indie Press Sampler',
            updatedAt: new Date().toISOString(),
            products: [
              {
                productTitle: 'Useful Book Vol. 1',
                downloads,
              },
            ],
          },
        },
      },
      undefined,
      2
    )
  )
}

async function writeZip(zipPath: string, entries: Record<string, string>): Promise<void> {
  await mkdir(path.dirname(zipPath), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const zip = new ZipFile()
    const output = createWriteStream(zipPath)
    output.on('error', reject)
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(output).on('close', resolve)
    for (const [entryName, contents] of Object.entries(entries)) {
      zip.addBuffer(Buffer.from(contents), entryName)
    }
    zip.end()
  })
}

async function writeEpub(epubPath: string, publisher: string): Promise<void> {
  await writeZip(epubPath, {
    'META-INF/container.xml': `<container><rootfiles><rootfile full-path="OPS/content.opf" /></rootfiles></container>`,
    'OPS/content.opf': `<package><metadata><dc:title>Useful Book</dc:title><dc:publisher>${publisher}</dc:publisher></metadata></package>`,
  })
}

async function writePdf(pdfPath: string, publisher: string): Promise<void> {
  await mkdir(path.dirname(pdfPath), { recursive: true })
  await writeFile(
    pdfPath,
    `%PDF-1.7
<x:xmpmeta><rdf:RDF><rdf:Description><dc:publisher><rdf:Bag><rdf:li>${publisher}</rdf:li></rdf:Bag></dc:publisher></rdf:Description></rdf:RDF></x:xmpmeta>
%%EOF`
  )
}

describe('enriched metadata', () => {
  it('resolves CLI-only enriched metadata path beside the library', () => {
    expect(resolveEnrichedMetadataPath('Library')).toBe(
      path.join('Library', '.enriched-metadata.json')
    )
  })

  it('scans all supported files, extracts EPUB metadata, and keeps unmatched files', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      const enrichedMetadataPath = path.join(temporaryDirectory, '.hbd', 'enriched-metadata.json')
      await writeMetadata(metadataPath)
      await writeEpub(path.join(booksPath, 'useful.epub'), 'Indie Press')
      await writeEpub(path.join(booksPath, 'unmatched.epub'), 'Loose Publisher')
      await writeFile(path.join(booksPath, 'comic.cbz'), 'not inspected in v1')

      const { metadata, outputPath } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
          enrichedMetadataPath,
        }),
      })

      expect(outputPath).toBe(enrichedMetadataPath)
      expect(metadata.summary).toMatchObject({
        scanned: 3,
        extracted: 2,
        skipped: 1,
        matchedFiles: 1,
        unmatchedFiles: 2,
      })
      expect(getEnrichedPublisherForProduct(metadata, 'Useful Book Vol. 1')).toBe('Indie Press')
      expect(metadata.files.find((file) => file.path.endsWith('unmatched.epub'))?.matches).toEqual(
        []
      )
      await expect(loadEnrichedMetadata(booksPath, enrichedMetadataPath)).resolves.toMatchObject({
        version: 1,
      })
    })
  })

  it('extracts PDF XMP publishers and rejects PDF tool metadata as publisher evidence', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      await mkdir(booksPath, { recursive: true })
      await writeMetadata(metadataPath)
      await writeFile(
        path.join(booksPath, 'useful.pdf'),
        `%PDF-1.7
1 0 obj
<< /Title (cover.pdf) /Creator (Adobe Acrobat) /Producer (pdfFactory Pro) >>
endobj
<x:xmpmeta><rdf:RDF><rdf:Description><dc:publisher><rdf:Bag><rdf:li>Careful Publisher</rdf:li></rdf:Bag></dc:publisher></rdf:Description></rdf:RDF></x:xmpmeta>
%%EOF`
      )

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
        }),
      })

      const file = metadata.files[0]
      expect(file?.publisher).toMatchObject({
        value: 'Careful Publisher',
        source: 'pdf-xmp',
      })
      expect(file?.rawFields['pdf-info:Creator']).toBe('Adobe Acrobat')
      expect(getEnrichedPublisherForProduct(metadata, 'Useful Book Vol. 1')).toBeUndefined()
    })
  })

  it('reports extraction errors without aborting the scan', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      await mkdir(booksPath, { recursive: true })
      await writeFile(path.join(booksPath, 'broken.epub'), 'not a zip')

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
        }),
      })

      expect(metadata.summary).toMatchObject({
        scanned: 1,
        errors: 1,
      })
      expect(metadata.files[0]).toMatchObject({
        status: 'error',
        extension: 'epub',
      })
      expect(await readFile(path.join(booksPath, '.enriched-metadata.json'), 'utf8')).toContain(
        '"errors": 1'
      )
    })
  })

  it('scans configured archive mirrors when archive formats are enabled', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const mediaRoot = path.join(temporaryDirectory, 'Media')
      const comicsPath = path.join(mediaRoot, 'Comics', 'comics')
      const archiveRoot = path.join(temporaryDirectory, 'Archive')
      const archiveComicsPath = path.join(archiveRoot, 'Comics', 'comics')
      const metadataPath = path.join(mediaRoot, '.hbd', 'metadata.json')
      const enrichedMetadataPath = path.join(mediaRoot, '.hbd', 'enriched-metadata.json')
      await writeMetadataDownloads(metadataPath, [
        {
          cacheKey: 'order-1:useful.cbz',
          filename: 'useful.cbz',
          extension: 'cbz',
          platform: 'ebook',
        },
        {
          cacheKey: 'order-1:useful.epub',
          filename: 'useful.epub',
          extension: 'epub',
          platform: 'ebook',
        },
      ])
      await mkdir(comicsPath, { recursive: true })
      await writeFile(path.join(comicsPath, 'useful.cbz'), 'not inspected in v1')
      await writeEpub(
        path.join(archiveComicsPath, 'Useful Publisher', 'Useful Book', 'useful.epub'),
        'Archive Press'
      )

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          mediaRoot,
          libraryName: 'comics',
          defaultLibrary: 'comics',
          metadataPath,
          enrichedMetadataPath,
          archiveRoot,
          libraries: {
            comics: {
              path: comicsPath,
              layout: 'flat',
              formatPriority: ['cbz', 'pdf'],
              archiveFormats: ['epub'],
            },
          },
        }),
      })

      expect(metadata.summary).toMatchObject({
        scanned: 2,
        extracted: 1,
        skipped: 1,
        matchedFiles: 2,
      })
      const archiveFile = metadata.files.find((file) => file.path.endsWith('useful.epub'))
      expect(archiveFile?.source).toMatchObject({
        role: 'archive',
        libraryName: 'comics',
        libraryPath: comicsPath,
      })
      expect(getEnrichedPublisherForProduct(metadata, 'Useful Book Vol. 1')).toBe('Archive Press')
    })
  })

  it('does not scan archive mirrors when archive formats are absent', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const mediaRoot = path.join(temporaryDirectory, 'Media')
      const comicsPath = path.join(mediaRoot, 'Comics', 'comics')
      const archiveRoot = path.join(temporaryDirectory, 'Archive')
      const metadataPath = path.join(mediaRoot, '.hbd', 'metadata.json')
      await writeMetadata(metadataPath)
      await writeEpub(path.join(archiveRoot, 'Comics', 'comics', 'useful.epub'), 'Archive Press')

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          mediaRoot,
          libraryName: 'comics',
          defaultLibrary: 'comics',
          metadataPath,
          archiveRoot,
          libraries: {
            comics: {
              path: comicsPath,
              layout: 'flat',
              formatPriority: ['cbz', 'pdf'],
            },
          },
        }),
      })

      expect(metadata.summary.scanned).toBe(0)
      expect(getEnrichedPublisherForProduct(metadata, 'Useful Book Vol. 1')).toBeUndefined()
    })
  })

  it('mirrors bundle archive paths under archive root', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const mediaRoot = path.join(temporaryDirectory, 'Media')
      const booksPath = path.join(mediaRoot, 'Books')
      const archiveRoot = path.join(temporaryDirectory, 'Archive')
      const metadataPath = path.join(mediaRoot, '.hbd', 'metadata.json')
      await writeMetadata(metadataPath)
      await writeEpub(
        path.join(archiveRoot, 'Books', 'Bundle', 'Useful Book', 'useful.epub'),
        'Bundle Press'
      )

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          mediaRoot,
          libraryName: 'books',
          defaultLibrary: 'books',
          metadataPath,
          archiveRoot,
          libraries: {
            books: {
              path: booksPath,
              layout: 'bundle',
              formatPriority: ['pdf'],
              archiveFormats: ['epub'],
            },
          },
        }),
      })

      expect(metadata.files[0]?.source).toMatchObject({
        role: 'archive',
        libraryName: 'books',
      })
      expect(metadata.files[0]?.path).toContain(path.join('Archive', 'Books'))
    })
  })

  it('deduplicates files discovered through multiple scan roots and prefers library source', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      await writeMetadata(metadataPath)
      await writeEpub(path.join(booksPath, 'useful.epub'), 'Indie Press')

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          scanPaths: [booksPath],
          metadataPath,
        }),
      })

      expect(metadata.summary.scanned).toBe(1)
      expect(metadata.files[0]?.source?.role).toBe('library')
    })
  })

  it('records high-confidence publisher conflicts while keeping the top ranked evidence', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      await writeMetadata(metadataPath)
      await writeEpub(path.join(booksPath, 'useful.epub'), 'Strong Press')
      await writePdf(path.join(booksPath, 'useful.pdf'), 'Different Media')

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
        }),
      })

      const product = metadata.products['useful book vol 1']
      expect(product?.publisher?.value).toBe('Strong Press')
      expect(product?.publisherConflicts?.map((field) => field.value)).toContain('Different Media')
      expect(getEnrichedPublisherForProduct(metadata, 'Useful Book Vol. 1')).toBe('Strong Press')
    })
  })

  it('canonicalizes rare publisher typos to common close spellings', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      await writeMetadata(metadataPath)

      for (const name of ['one', 'two', 'three']) {
        await writeEpub(path.join(booksPath, `${name}.epub`), 'Dynamite Entertainment')
      }
      await writeEpub(path.join(booksPath, 'useful.epub'), 'Dynamite Entertianment')

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
        }),
      })

      expect(getEnrichedPublisherForProduct(metadata, 'Useful Book Vol. 1')).toBe(
        'Dynamite Entertainment'
      )
      expect(metadata.products['useful book vol 1']?.publisher?.evidence).toContain(
        'publisher-spelling-canonicalized'
      )
    })
  })

  it('decodes numeric XML entities before accepting publisher metadata', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      await writeMetadata(metadataPath)
      await writeEpub(path.join(booksPath, 'useful.epub'), 'O&#8217;Reilly Media Inc')

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
        }),
      })

      expect(metadata.files[0]?.rawFields['epub:dc:publisher']).toBe('O\u2019Reilly Media Inc')
      expect(getEnrichedPublisherForProduct(metadata, 'Useful Book Vol. 1')).toBe(
        'OReilly Media Inc'
      )
    })
  })

  it('rejects generic publisher placeholders', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      await writeMetadata(metadataPath)
      await writeEpub(path.join(booksPath, 'useful.epub'), 'Publisher')

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
        }),
      })

      expect(metadata.files[0]?.publisher).toBeUndefined()
      expect(metadata.files[0]?.rejectedFields.publisher?.[0]?.rejectionReasons).toContain(
        'generic-placeholder'
      )
    })
  })

  it('cleans publisher boilerplate before product routing', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      await writeMetadata(metadataPath)
      await writeEpub(path.join(booksPath, 'useful.epub'), 'Adams Media a division of FW Media Inc')

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
        }),
      })

      expect(getEnrichedPublisherForProduct(metadata, 'Useful Book Vol. 1')).toBe('Adams Media')
    })
  })

  it('separates safely detected concatenated publisher suffixes', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      await writeMetadata(metadataPath)
      await writeEpub(
        path.join(booksPath, 'useful.epub'),
        'CRC Press/Taylor &amp; Francis Group, LLC'
      )

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
        }),
      })

      expect(getEnrichedPublisherForProduct(metadata, 'Useful Book Vol. 1')).toBe(
        'CRC Press Taylor & Francis Group LLC'
      )
    })
  })

  it('cleans publisher prefixes and all-caps names without losing real suffixes', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      await writeMetadata(metadataPath)
      await writeEpub(path.join(booksPath, 'useful.epub'), 'Published by C T Publishing Inc')
      await writeEpub(path.join(booksPath, 'second.epub'), 'United States by Cleis Press Inc')
      await writeEpub(path.join(booksPath, 'third.epub'), 'SEARCH PRESS')
      await writeEpub(path.join(booksPath, 'fourth.epub'), 'A David and Charles Book')
      await writeEpub(path.join(booksPath, 'fifth.epub'), 'F+W Media, Inc.')
      await writeEpub(
        path.join(booksPath, 'sixth.epub'),
        'David &amp; Charles is an imprint of F&amp;W Media International, Ltd'
      )

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
        }),
      })

      expect(
        metadata.files.find((file) => file.path.endsWith('useful.epub'))?.publisher?.value
      ).toBe('C T Publishing Inc')
      expect(
        metadata.files.find((file) => file.path.endsWith('second.epub'))?.publisher?.value
      ).toBe('Cleis Press Inc')
      expect(
        metadata.files.find((file) => file.path.endsWith('third.epub'))?.publisher?.value
      ).toBe('Search Press')
      expect(
        metadata.files.find((file) => file.path.endsWith('fourth.epub'))?.publisher?.value
      ).toBe('David & Charles')
      expect(
        metadata.files.find((file) => file.path.endsWith('fifth.epub'))?.publisher?.value
      ).toBe('F W Media Inc')
      expect(
        metadata.files.find((file) => file.path.endsWith('sixth.epub'))?.publisher?.value
      ).toBe('David & Charles')
    })
  })

  it('accepts short publisher brand names that resemble person names', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      await writeMetadata(metadataPath)
      await writeEpub(path.join(booksPath, 'useful.epub'), 'Insight Editions')
      await writeEpub(path.join(booksPath, 'second.epub'), 'Abrams Image')
      await writeEpub(path.join(booksPath, 'third.epub'), 'Lion Forge')
      await writeEpub(path.join(booksPath, 'fourth.epub'), 'Humanoids Inc')
      await writeEpub(path.join(booksPath, 'fifth.epub'), 'Abrams Noterie')

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
        }),
      })

      expect(
        metadata.files.find((file) => file.path.endsWith('useful.epub'))?.publisher?.value
      ).toBe('Insight Editions')
      expect(
        metadata.files.find((file) => file.path.endsWith('second.epub'))?.publisher?.value
      ).toBe('Abrams Image')
      expect(
        metadata.files.find((file) => file.path.endsWith('third.epub'))?.publisher?.value
      ).toBe('Lion Forge')
      expect(
        metadata.files.find((file) => file.path.endsWith('fourth.epub'))?.publisher?.value
      ).toBe('Humanoids Inc')
      expect(
        metadata.files.find((file) => file.path.endsWith('fifth.epub'))?.publisher?.value
      ).toBe('Abrams Noterie')
    })
  })

  it('canonicalizes known publisher values that look like person names or bad OCR', async () => {
    await withTemporaryDirectory(async (temporaryDirectory) => {
      const booksPath = path.join(temporaryDirectory, 'Books')
      const metadataPath = path.join(temporaryDirectory, '.hbd', 'metadata.json')
      await writeMetadataDownloads(metadataPath, [
        {
          cacheKey: 'order-1:useful.epub',
          filename: 'useful.epub',
          extension: 'epub',
          platform: 'ebook',
        },
        {
          cacheKey: 'order-1:second.epub',
          filename: 'second.epub',
          extension: 'epub',
          platform: 'ebook',
        },
        {
          cacheKey: 'order-1:third.epub',
          filename: 'third.epub',
          extension: 'epub',
          platform: 'ebook',
        },
        {
          cacheKey: 'order-1:fourth.epub',
          filename: 'fourth.epub',
          extension: 'epub',
          platform: 'ebook',
        },
      ])
      await writeEpub(path.join(booksPath, 'useful.epub'), 'Bobbi Dempsey')
      await writeEpub(path.join(booksPath, 'second.epub'), 'Praful Palekar')
      await writeEpub(path.join(booksPath, 'third.epub'), 'Walter Tester')
      await writeEpub(path.join(booksPath, 'fourth.epub'), 'Simon &amp; Schuster')

      const { metadata } = await enrichMetadata({
        config: resolveConfig({
          libraryPath: booksPath,
          metadataPath,
        }),
      })

      expect(
        metadata.files.find((file) => file.path.endsWith('useful.epub'))?.publisher?.value
      ).toBe('Adams Media')
      expect(
        metadata.files.find((file) => file.path.endsWith('second.epub'))?.publisher?.value
      ).toBe('Packt Publishing')
      expect(
        metadata.files.find((file) => file.path.endsWith('third.epub'))?.publisher?.value
      ).toBe('Walter Foster')
      expect(
        metadata.files.find((file) => file.path.endsWith('fourth.epub'))?.publisher?.value
      ).toBe('Simon & Schuster')
    })
  })
})
