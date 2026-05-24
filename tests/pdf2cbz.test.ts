import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'
import { ZipFile } from 'yazl'
import yauzl from 'yauzl'

import { buildComicInfoFields, pdf2cbzCommandTestUtils } from '../src/cli/commands/pdf2cbz'
import { pdf2cbzTestUtils } from '../src/tools/pdf2cbz'

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
  it('natural sorts and normalizes entry names', () => {
    const sorted = ['page-2.png', 'page-10.png', 'page-1.png'].sort(pdf2cbzTestUtils.naturalSort)
    expect(sorted).toEqual(['page-1.png', 'page-2.png', 'page-10.png'])
    expect(pdf2cbzTestUtils.normalizeEntryName(1, '.JPG')).toBe('0001.jpg')
    expect(pdf2cbzTestUtils.normalizeEntryName(12, '.png')).toBe('0012.png')
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

  it('builds ComicInfo fields from enriched and Humble metadata matches', () => {
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
              value: 'Enriched Issue Title',
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
      Title: 'Enriched Issue Title',
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
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
