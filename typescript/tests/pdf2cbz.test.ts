import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'
import { ZipFile } from 'yazl'
import yauzl from 'yauzl'

import { pdf2cbzTestUtils } from '../src/tools/pdf2cbz'

async function readZipEntry(
  zipPath: string,
  entryName: string
): Promise<Buffer | undefined> {
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
    const sorted = ['page-2.png', 'page-10.png', 'page-1.png'].sort(
      pdf2cbzTestUtils.naturalSort
    )
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
})
