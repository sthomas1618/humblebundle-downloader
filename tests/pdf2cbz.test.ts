import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'
import { Command } from 'commander'
import { ZipFile } from 'yazl'
import yauzl from 'yauzl'

import {
  buildComicInfoFields,
  pdf2cbzCommandTestUtils,
  registerPdf2CbzCommand,
} from '../src/cli/commands/pdf2cbz'
import { resolveConfig } from '../src/config'
import { pdf2cbzTestUtils } from '../src/tools/pdf2cbz'
import { createCbz } from '../src/tools/pdf2cbz-helpers'

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function readZipEntry(zipPath: string, entryName: string): Promise<Buffer | undefined> {
  return await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error ?? new Error('Unable to open zip'))
        return
      }

      function handleClose(): void {
        zipfile.close()
      }
      zipfile.on('error', (error_) => {
        handleClose()
        reject(error_)
      })

      zipfile.readEntry()
      zipfile.on('entry', (entry) => {
        if (entry.fileName === entryName) {
          zipfile.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              handleClose()
              reject(streamError ?? new Error('Unable to read zip entry'))
              return
            }
            const chunks: Buffer[] = []
            stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
            stream.on('error', (streamError_) => {
              handleClose()
              reject(streamError_)
            })
            stream.on('end', () => {
              handleClose()
              resolve(Buffer.concat(chunks))
            })
          })
          return
        }
        zipfile.readEntry()
      })

      zipfile.on('end', () => {
        handleClose()
        resolve()
      })
    })
  })
}

describe('pdf2cbz naming and preservation helpers', () => {
  it('exposes a limit option for bounded batches', () => {
    const program = new Command()

    registerPdf2CbzCommand(program)

    const command = program.commands.find(
      (registeredCommand) => registeredCommand.name() === 'pdf2cbz'
    )
    const help = command?.helpInformation()
    expect(help).toContain('--limit <n>')
    expect(help).toContain('--validate')
    expect(help).toContain('--repair')
  })

  it('natural sorts and normalizes entry names', () => {
    const sorted = ['page-2.png', 'page-10.png', 'page-1.png'].sort(pdf2cbzTestUtils.naturalSort)
    expect(sorted).toEqual(['page-1.png', 'page-2.png', 'page-10.png'])
    expect(pdf2cbzTestUtils.normalizeEntryName(1, '.JPG')).toBe('0001.jpg')
    expect(pdf2cbzTestUtils.normalizeEntryName(12, '.png')).toBe('0012.png')
  })

  it('rejects extracted image sets that do not map to reader-safe PDF pages', () => {
    expect(
      pdf2cbzTestUtils.validatePdfImageSet(['/tmp/page-000.jpg', '/tmp/page-001.jpg'], 2, {
        requireReaderSafeFormats: true,
      })
    ).toMatchObject({ valid: true })

    expect(
      pdf2cbzTestUtils.validatePdfImageSet(['/tmp/page-000.jpg', '/tmp/page-001.jpg'], 1, {
        requireReaderSafeFormats: true,
      })
    ).toMatchObject({
      valid: false,
      reasons: ['expected 1 page image(s), found 2'],
    })

    expect(
      pdf2cbzTestUtils.validatePdfImageSet(['/tmp/page-000.jp2'], 1, {
        requireReaderSafeFormats: true,
      })
    ).toMatchObject({
      valid: false,
      reasons: ['reader-unsafe image format(s): .jp2'],
    })
  })

  it('inspects CBZ image entries without extracting archive contents', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-pdf2cbz-test-'))
    const cbzPath = path.join(temporaryDirectory, 'sample.cbz')

    try {
      await new Promise<void>((resolve, reject) => {
        const zip = new ZipFile()
        const output = createWriteStream(cbzPath)
        output.on('error', reject)
        zip.outputStream.on('error', reject)
        zip.outputStream.pipe(output).on('close', resolve)
        zip.addBuffer(Buffer.from('page'), '0001.jpg', { compress: false })
        zip.addBuffer(Buffer.from('mask'), '0002.jp2', { compress: false })
        zip.addBuffer(Buffer.from('<ComicInfo />'), 'ComicInfo.xml', { compress: false })
        zip.end()
      })

      const inspection = await pdf2cbzTestUtils.inspectCbzImageSet(cbzPath)

      expect(inspection).toMatchObject({
        imageCount: 2,
        imageExtensions: ['.jp2', '.jpg'],
        entries: ['0001.jpg', '0002.jp2'],
      })
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('extracts ComicInfo.xml from an existing CBZ', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-pdf2cbz-test-'))
    const cbzPath = path.join(temporaryDirectory, 'sample.cbz')
    const comicInfo = Buffer.from('<ComicInfo><Title>Sample</Title></ComicInfo>')

    try {
      await new Promise<void>((resolve, reject) => {
        const zip = new ZipFile()
        const output = createWriteStream(cbzPath)
        output.on('error', reject)
        zip.outputStream.on('error', reject)
        zip.outputStream.pipe(output).on('close', resolve)
        zip.addBuffer(comicInfo, 'ComicInfo.xml', { compress: false })
        zip.end()
      })

      const extracted = await pdf2cbzTestUtils.readComicInfoXml(cbzPath)
      expect(extracted?.toString()).toBe(comicInfo.toString())

      const regeneratedPath = path.join(temporaryDirectory, 'regenerated.cbz')
      await new Promise<void>((resolve, reject) => {
        const zip = new ZipFile()
        const output = createWriteStream(regeneratedPath)
        output.on('error', reject)
        zip.outputStream.on('error', reject)
        zip.outputStream.pipe(output).on('close', resolve)
        zip.addBuffer(extracted ?? Buffer.from(''), 'ComicInfo.xml', { compress: false })
        zip.end()
      })

      const regenerated = await readZipEntry(regeneratedPath, 'ComicInfo.xml')
      expect(regenerated?.toString()).toBe(comicInfo.toString())
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('builds deterministic escaped ComicInfo.xml', () => {
    const result = pdf2cbzTestUtils.buildComicInfoXml({
      Title: 'A & B <C>',
      Series: 'Series "One"',
      Publisher: "Publisher's House",
      Notes: 'Line one\nLine two',
    })

    expect(result.generated).toBe(true)
    expect(result.fields).toEqual(['Title', 'Series', 'Publisher', 'Notes'])
    expect(result.xml?.toString()).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ComicInfo>',
        '  <Title>A &amp; B &lt;C&gt;</Title>',
        '  <Series>Series &quot;One&quot;</Series>',
        '  <Publisher>Publisher&apos;s House</Publisher>',
        '  <Notes>Line one\nLine two</Notes>',
        '</ComicInfo>',
        '',
      ].join('\n')
    )
  })

  it('fills missing ComicInfo fields without overwriting existing values', () => {
    const existing = Buffer.from('<ComicInfo><Title>Existing Title</Title></ComicInfo>')
    const result = pdf2cbzTestUtils.mergeComicInfoXml(existing, {
      Title: 'Generated Title',
      Series: 'Generated Series',
      Publisher: 'Generated Publisher',
    })

    expect(result.preserved).toBe(true)
    expect(result.generated).toBe(false)
    expect(result.merged).toBe(true)
    expect(result.fields).toEqual(['Series', 'Publisher'])
    expect(result.xml?.toString()).toContain('<Title>Existing Title</Title>')
    expect(result.xml?.toString()).not.toContain('<Title>Generated Title</Title>')
    expect(result.xml?.toString().match(/<Series>/g)).toHaveLength(1)
    expect(result.xml?.toString()).toContain('<Publisher>Generated Publisher</Publisher>')
  })

  it('writes CBZ archives through a temporary file and removes it after success', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-pdf2cbz-test-'))
    const imagePath = path.join(temporaryDirectory, 'page-1.JPG')
    const cbzPath = path.join(temporaryDirectory, 'sample.cbz')

    try {
      await writeFile(imagePath, 'fake image bytes')

      await createCbz(cbzPath, [imagePath], Buffer.from('<ComicInfo />'))

      const imageEntry = await readZipEntry(cbzPath, '0001.jpg')
      const comicInfoEntry = await readZipEntry(cbzPath, 'ComicInfo.xml')
      const entries = await readdir(temporaryDirectory)
      const leftovers = entries.filter(
        (entry) => entry.startsWith('.sample.cbz.') && entry.endsWith('.tmp')
      )
      expect(imageEntry?.toString()).toBe('fake image bytes')
      expect(comicInfoEntry?.toString()).toBe('<ComicInfo />')
      expect(leftovers).toEqual([])
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('preserves an existing CBZ and removes the temporary file when archive creation fails', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-pdf2cbz-test-'))
    const cbzPath = path.join(temporaryDirectory, 'sample.cbz')
    const missingImagePath = path.join(temporaryDirectory, 'missing.jpg')

    try {
      await writeFile(cbzPath, 'existing cbz bytes')

      await expect(createCbz(cbzPath, [missingImagePath])).rejects.toThrow()

      expect(await readFile(cbzPath, 'utf8')).toBe('existing cbz bytes')
      const entries = await readdir(temporaryDirectory)
      const leftovers = entries.filter(
        (entry) => entry.startsWith('.sample.cbz.') && entry.endsWith('.tmp')
      )
      expect(leftovers).toEqual([])
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('builds ComicInfo fields from Humble product titles and enriched publishers', () => {
    const pdfPath = path.join('/library', 'Bundle', 'Issue 1', 'issue.pdf')
    const fields = buildComicInfoFields(pdfPath, {
      humbleMetadata: {
        version: 1,
        updatedAt: 'now',
        orders: {
          'order-1': {
            orderId: 'order-1',
            bundleTitle: 'Bundle & Friends',
            updatedAt: 'now',
            products: [
              {
                productTitle: 'Issue 1',
                downloads: [
                  {
                    cacheKey: 'order-1:issue.pdf',
                    filename: 'issue.pdf',
                    extension: 'pdf',
                    platform: 'ebook',
                  },
                ],
              },
            ],
          },
        },
      },
      enrichedMetadata: {
        version: 1,
        updatedAt: 'now',
        summary: {
          scanned: 1,
          extracted: 1,
          skipped: 0,
          errors: 0,
          matchedFiles: 1,
          unmatchedFiles: 0,
        },
        files: [
          {
            path: pdfPath,
            extension: 'pdf',
            status: 'extracted',
            matches: [
              {
                cacheKey: 'order-1:issue.pdf',
                orderId: 'order-1',
                bundleTitle: 'Bundle & Friends',
                productTitle: 'Issue 1',
                filename: 'issue.pdf',
              },
            ],
            title: {
              value: 'FrontCover_image.eps',
              source: 'pdf-xmp',
              confidence: 0.75,
              evidence: ['xmp:dc:title'],
            },
            publisher: {
              value: 'Careful Publisher',
              source: 'pdf-xmp',
              confidence: 0.85,
              evidence: ['xmp:dc:publisher'],
            },
            rawFields: {},
            rejectedFields: {},
          },
        ],
        products: {},
      },
    })

    expect(fields).toMatchObject({
      Title: 'Issue 1',
      Series: 'Issue 1',
      Publisher: 'Careful Publisher',
    })
    expect(fields?.Notes).toContain('Bundle: Bundle & Friends')
    expect(fields?.Notes).toContain('Order: order-1')
    expect(fields?.Notes).toContain('Source PDF: issue.pdf')
  })

  it('does not build ComicInfo fields for unmatched PDFs', () => {
    expect(buildComicInfoFields('/library/unmatched.pdf', {})).toBeUndefined()
  })

  it('builds local product identity and ComicInfo fields from filenames over PDF titles', async () => {
    const pdfPath = path.join('/library', 'Local Series', 'Afterglow Digital Copy.pdf')
    const identity = await pdf2cbzCommandTestUtils.buildLocalProductIdentity(
      pdfPath,
      {
        enrichedMetadata: {
          version: 1,
          updatedAt: 'now',
          summary: {
            scanned: 1,
            extracted: 1,
            skipped: 0,
            errors: 0,
            matchedFiles: 0,
            unmatchedFiles: 1,
          },
          files: [
            {
              path: pdfPath,
              extension: 'pdf',
              status: 'extracted',
              matches: [],
              title: {
                value: 'Print',
                source: 'pdf-xmp',
                confidence: 0.75,
                evidence: ['xmp:dc:title'],
              },
              publisher: {
                value: 'Local Press',
                source: 'pdf-xmp',
                confidence: 0.75,
                evidence: ['xmp:dc:publisher'],
              },
              rawFields: {
                'xmp:calibre:series': 'Metadata Series',
              },
              rejectedFields: {},
            },
          ],
          products: {},
        },
      },
      path.join('Local Series', 'Afterglow Digital Copy.pdf'),
      {
        name: 'comics',
        path: '/library',
      }
    )

    expect(identity).toMatchObject({
      source: 'local',
      localProductKey: `comics:${path.join('Local Series', 'Afterglow Digital Copy.pdf')}`,
      productTitle: 'Afterglow Digital Copy',
      series: 'Metadata Series',
      publisher: 'Local Press',
      metadataSources: {
        title: 'filename',
        series: 'xmp:calibre:series',
        publisher: 'pdf-xmp',
      },
      comicInfoFields: {
        Title: 'Afterglow Digital Copy',
        Series: 'Metadata Series',
        Publisher: 'Local Press',
      },
    })
    expect(identity.comicInfoFields.Notes).toContain('Source: local PDF')
  })

  it('uses filename titles for local products even when PDF titles look useful', async () => {
    const pdfPath = path.join('/library', 'Local Series', 'issue-001.pdf')
    const identity = await pdf2cbzCommandTestUtils.buildLocalProductIdentity(
      pdfPath,
      {
        enrichedMetadata: {
          version: 1,
          updatedAt: 'now',
          summary: {
            scanned: 1,
            extracted: 1,
            skipped: 0,
            errors: 0,
            matchedFiles: 0,
            unmatchedFiles: 1,
          },
          files: [
            {
              path: pdfPath,
              extension: 'pdf',
              status: 'extracted',
              matches: [],
              title: {
                value: 'The Local Issue',
                source: 'pdf-xmp',
                confidence: 0.75,
                evidence: ['xmp:dc:title'],
              },
              rawFields: {},
              rejectedFields: {},
            },
          ],
          products: {},
        },
      },
      path.join('Local Series', 'issue-001.pdf')
    )

    expect(identity).toMatchObject({
      productTitle: 'issue-001',
      metadataSources: {
        title: 'filename',
        series: 'path-parent',
      },
      comicInfoFields: {
        Title: 'issue-001',
        Series: 'Local Series',
      },
    })
  })

  it('builds local product identity from path fallbacks when metadata is absent', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-pdf2cbz-test-'))
    const pdfPath = path.join(temporaryDirectory, 'Series', 'issue-002.pdf')

    try {
      await mkdir(path.dirname(pdfPath), { recursive: true })
      await writeFile(pdfPath, '%PDF-1.7\n%%EOF')

      const identity = await pdf2cbzCommandTestUtils.buildLocalProductIdentity(
        pdfPath,
        {},
        path.join('Series', 'issue-002.pdf')
      )

      expect(identity).toMatchObject({
        localProductKey: path.join('Series', 'issue-002.pdf'),
        productTitle: 'issue-002',
        series: 'Series',
        metadataSources: {
          title: 'filename',
          series: 'path-parent',
        },
        comicInfoFields: {
          Title: 'issue-002',
          Series: 'Series',
        },
      })
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('resolves archive targets for Humble products and enabled local products only', () => {
    const mediaRoot = path.resolve('MediaRoot')
    const config = resolveConfig({
      defaultLibrary: 'comics',
      libraryName: 'comics',
      archiveRoot: path.join(mediaRoot, 'Archive'),
      libraries: {
        comics: {
          path: path.join(mediaRoot, 'Comics'),
          archiveFormats: ['pdf'],
        },
      },
    })
    const library = config.scanLibraries.find((scanLibrary) => scanLibrary.name === 'comics')
    const pdfPath = path.join(mediaRoot, 'Comics', 'Series', 'issue.pdf')

    expect(
      pdf2cbzCommandTestUtils.resolvePdfArchivePath(config, library, pdfPath, true, false, {
        trackLocalProducts: false,
        archiveLocalProducts: false,
      })
    ).toBe(path.join(mediaRoot, 'Archive', 'Comics', 'Series', 'issue.pdf'))
    expect(
      pdf2cbzCommandTestUtils.resolvePdfArchivePath(config, library, pdfPath, false, true, {
        trackLocalProducts: true,
        archiveLocalProducts: true,
      })
    ).toBe(path.join(mediaRoot, 'Archive', 'Comics', 'Series', 'issue.pdf'))
    expect(
      pdf2cbzCommandTestUtils.resolvePdfArchivePath(config, library, pdfPath, false, true, {
        trackLocalProducts: true,
        archiveLocalProducts: false,
      })
    ).toBeUndefined()
    expect(
      pdf2cbzCommandTestUtils.resolvePdfArchivePath(
        config,
        undefined,
        path.join(mediaRoot, 'Loose', 'issue.pdf'),
        false,
        true,
        {
          trackLocalProducts: true,
          archiveLocalProducts: true,
        }
      )
    ).toBeUndefined()
  })

  it('formats dry-run details for Humble, local, and untracked PDFs', async () => {
    const pdfPath = path.join('/library', 'Local Series', 'issue-001.pdf')
    const localProduct = await pdf2cbzCommandTestUtils.buildLocalProductIdentity(
      pdfPath,
      {
        enrichedMetadata: {
          version: 1,
          updatedAt: 'now',
          summary: {
            scanned: 1,
            extracted: 1,
            skipped: 0,
            errors: 0,
            matchedFiles: 0,
            unmatchedFiles: 1,
          },
          files: [
            {
              path: pdfPath,
              extension: 'pdf',
              status: 'extracted',
              matches: [],
              title: {
                value: 'The Local Issue',
                source: 'pdf-xmp',
                confidence: 0.75,
                evidence: ['xmp:dc:title'],
              },
              publisher: {
                value: 'Local Press',
                source: 'pdf-xmp',
                confidence: 0.75,
                evidence: ['xmp:dc:publisher'],
              },
              rawFields: {},
              rejectedFields: {},
            },
          ],
          products: {},
        },
      },
      path.join('Local Series', 'issue-001.pdf')
    )

    expect(
      pdf2cbzCommandTestUtils.formatDryRunDetails({
        localProduct,
        trackLocalProducts: true,
        targetArchivePath: '/archive/issue-001.pdf',
      })
    ).toBe(
      '; local product "issue-001", series: Local Series, publisher: Local Press; archive PDF -> /archive/issue-001.pdf'
    )
    expect(
      pdf2cbzCommandTestUtils.formatDryRunDetails({
        humbleComicInfoFields: {
          Title: 'Humble Issue',
          Series: 'Humble Series',
        },
        trackLocalProducts: true,
      })
    ).toBe('; Humble product "Humble Issue"; keep source PDF')
    expect(
      pdf2cbzCommandTestUtils.formatDryRunDetails({
        trackLocalProducts: false,
      })
    ).toBe('; local product tracking disabled; keep source PDF')
  })

  it('does not remove source PDFs when an archive target has only the same size', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-pdf2cbz-test-'))
    const sourcePath = path.join(temporaryDirectory, 'source.pdf')
    const archivePath = path.join(temporaryDirectory, 'Archive', 'source.pdf')

    try {
      await writeFile(sourcePath, 'abc')
      await mkdir(path.dirname(archivePath), { recursive: true })
      await writeFile(archivePath, 'xyz')

      const result = await pdf2cbzCommandTestUtils.archivePdf(
        sourcePath,
        { mtimeMs: Date.now(), size: 3 },
        archivePath
      )

      expect(result).toMatchObject({
        archivePdfPath: archivePath,
        archiveStatus: 'conflict',
        archiveConflictReason:
          'Archive target already exists with the same file size but different content.',
      })
      expect(await readFile(sourcePath, 'utf8')).toBe('abc')
      expect(await readFile(archivePath, 'utf8')).toBe('xyz')
      const message = pdf2cbzCommandTestUtils.formatArchiveResultMessage(sourcePath, result)
      expect(message).toContain('Archive conflict for source PDF')
      expect(message).not.toContain('Archived source PDF')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('removes source PDFs only when an archive target has identical content', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-pdf2cbz-test-'))
    const sourcePath = path.join(temporaryDirectory, 'source.pdf')
    const archivePath = path.join(temporaryDirectory, 'Archive', 'source.pdf')

    try {
      await writeFile(sourcePath, 'abc')
      await mkdir(path.dirname(archivePath), { recursive: true })
      await writeFile(archivePath, 'abc')

      const result = await pdf2cbzCommandTestUtils.archivePdf(
        sourcePath,
        { mtimeMs: Date.now(), size: 3 },
        archivePath
      )

      expect(result).toEqual({
        archivePdfPath: archivePath,
        archiveStatus: 'duplicate-removed',
      })
      expect(await pathExists(sourcePath)).toBe(false)
      expect(await readFile(archivePath, 'utf8')).toBe('abc')
      const message = pdf2cbzCommandTestUtils.formatArchiveResultMessage(sourcePath, result)
      expect(message).toContain('Removed duplicate source PDF already archived')
      expect(message).not.toContain('Archived source PDF')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('copies and removes source PDFs for cross-device archive moves', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-pdf2cbz-test-'))
    const sourcePath = path.join(temporaryDirectory, 'source.pdf')
    const archivePath = path.join(temporaryDirectory, 'Archive', 'source.pdf')

    try {
      await writeFile(sourcePath, 'abc')
      await mkdir(path.dirname(archivePath), { recursive: true })

      await pdf2cbzCommandTestUtils.moveFileAcrossDevices(sourcePath, archivePath)

      expect(await pathExists(sourcePath)).toBe(false)
      expect(await readFile(archivePath, 'utf8')).toBe('abc')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('formats moved archive results as archived source PDFs', () => {
    const message = pdf2cbzCommandTestUtils.formatArchiveResultMessage('/library/source.pdf', {
      archivePdfPath: '/archive/source.pdf',
      archiveStatus: 'moved',
    })

    expect(message).toBe('Archived source PDF: /library/source.pdf -> /archive/source.pdf')
  })

  it('formats progress totals with adoption and failure counts', () => {
    const message = pdf2cbzCommandTestUtils.formatProgressTotals(
      {
        converted: 3,
        adopted: 2,
        skipped: 1,
        archived: 4,
        archiveConflicts: 1,
        dryRun: 0,
        failed: 1,
      },
      7,
      10,
      Date.now() - 7000
    )

    expect(message).toContain('Progress: 7/10')
    expect(message).toContain('converted 3')
    expect(message).toContain('adopted 2')
    expect(message).toContain('failed 1')
    expect(message).toContain('ETA')
  })

  it('formats CBZ validation summaries for repair reporting', () => {
    expect(
      pdf2cbzCommandTestUtils.formatValidationSummary(
        false,
        82,
        166,
        ['.jpg', '.png'],
        ['expected 82 page image(s), found 166']
      )
    ).toBe(
      'repair-needed; pages 82; images 166; formats .jpg,.png; expected 82 page image(s), found 166'
    )

    expect(pdf2cbzCommandTestUtils.formatValidationSummary(true, 82, 82, ['.png'], [])).toBe(
      'ok; pages 82; images 82; formats .png'
    )
  })
})
