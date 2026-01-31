import { createWriteStream } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import path from 'node:path'

import yauzl from 'yauzl'
import { ZipFile } from 'yazl'

import { runCommand } from '../utils/command'
import { ensureDirectory } from '../utils/fs'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.jp2', '.tif', '.tiff'])

export function naturalSort(a: string, b: string): number {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return collator.compare(a, b)
}

export async function runPdfImages(pdfPath: string, outputPrefix: string): Promise<void> {
  await runCommand('pdfimages', ['-all', pdfPath, outputPrefix])
}

export async function runPdfRender(
  pdfPath: string,
  outputDirectory: string,
  tool: 'pdftoppm' | 'mutool'
): Promise<void> {
  if (tool === 'mutool') {
    const outputTemplate = path.join(outputDirectory, 'page-%04d.png')
    await runCommand('mutool', ['draw', '-o', outputTemplate, pdfPath])
    return
  }
  const outputPrefix = path.join(outputDirectory, 'page')
  await runCommand('pdftoppm', ['-png', pdfPath, outputPrefix])
}

export async function collectImages(directory: string): Promise<string[]> {
  const entries = await readdir(directory)
  return entries
    .filter((entry) => IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .map((entry) => path.join(directory, entry))
}

export function normalizeEntryName(index: number, extension: string): string {
  const padded = String(index).padStart(4, '0')
  return `${padded}${extension.toLowerCase()}`
}

export async function createCbz(
  cbzPath: string,
  imagePaths: string[],
  preservedComicInfo?: Buffer
): Promise<void> {
  await ensureDirectory(cbzPath)
  await new Promise<void>((resolve, reject) => {
    const zip = new ZipFile()
    const output = createWriteStream(cbzPath)
    output.on('error', reject)
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(output).on('close', resolve)

    let index = 0
    for (const imagePath of imagePaths) {
      index += 1
      const extension = path.extname(imagePath)
      const entryName = normalizeEntryName(index, extension)
      zip.addFile(imagePath, entryName, { compress: false })
    }

    if (preservedComicInfo) {
      zip.addBuffer(preservedComicInfo, 'ComicInfo.xml', { compress: false })
    }

    zip.end()
  })
}

export async function readComicInfoXml(cbzPath: string): Promise<Buffer | undefined> {
  await access(cbzPath)
  return await new Promise<Buffer | undefined>((resolve, reject) => {
    yauzl.open(cbzPath, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error ?? new Error('Unable to open CBZ for ComicInfo.xml'))
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
        if (entry.fileName === 'ComicInfo.xml') {
          zipfile.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              handleClose()
              reject(streamError ?? new Error('Unable to read ComicInfo.xml'))
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

export const pdf2cbzTestUtils = {
  naturalSort,
  normalizeEntryName,
  readComicInfoXml,
}
