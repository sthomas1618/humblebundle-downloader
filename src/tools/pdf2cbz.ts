import { createWriteStream } from 'node:fs'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'

import yauzl from 'yauzl'
import { ZipFile } from 'yazl'

import { ensureDirectory } from '../utils/fs'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.jp2', '.tif', '.tiff'])

function naturalSort(a: string, b: string): number {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return collator.compare(a, b)
}

async function runCommand(command: string, commandArguments: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArguments, { stdio: 'inherit' })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `Command failed (${command} ${commandArguments.join(' ')}): exit code ${code ?? ''}`
        )
      )
    })
  })
}

async function runPdfImages(pdfPath: string, outputPrefix: string): Promise<void> {
  await runCommand('pdfimages', ['-all', pdfPath, outputPrefix])
}

async function runPdfRender(
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

async function collectImages(directory: string): Promise<string[]> {
  const entries = await readdir(directory)
  return entries
    .filter((entry) => IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .map((entry) => path.join(directory, entry))
}

function normalizeEntryName(index: number, extension: string): string {
  const padded = String(index).padStart(4, '0')
  return `${padded}${extension.toLowerCase()}`
}

async function createCbz(
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

async function readComicInfoXml(cbzPath: string): Promise<Buffer | undefined> {
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

export type Pdf2CbzOptions = {
  cbzPath: string
  keepTemp?: boolean
  renderFallback?: boolean
  renderTool?: 'pdftoppm' | 'mutool'
}

export type Pdf2CbzResult = {
  cbzPath: string
  temporaryDirectory: string
  imageCount: number
  usedRenderFallback: boolean
}

export async function convertPdfToCbz(
  pdfPath: string,
  options: Pdf2CbzOptions
): Promise<Pdf2CbzResult> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-pdf2cbz-'))
  const outputPrefix = path.join(temporaryDirectory, 'page')
  let usedRenderFallback = false
  let preservedComicInfo: Buffer | undefined

  try {
    try {
      preservedComicInfo = await readComicInfoXml(options.cbzPath)
    } catch {
      // ignore missing ComicInfo.xml
    }

    await runPdfImages(pdfPath, outputPrefix)
    let images = await collectImages(temporaryDirectory)

    if (images.length === 0 && options.renderFallback) {
      usedRenderFallback = true
      const tool = options.renderTool ?? 'pdftoppm'
      await runPdfRender(pdfPath, temporaryDirectory, tool)
      images = await collectImages(temporaryDirectory)
    }

    if (images.length === 0) {
      throw new Error('No embedded images found; PDF may be vector/text-only or protected.')
    }

    images.sort((a, b) => naturalSort(path.basename(a), path.basename(b)))
    await createCbz(options.cbzPath, images, preservedComicInfo)

    return {
      cbzPath: options.cbzPath,
      temporaryDirectory,
      imageCount: images.length,
      usedRenderFallback,
    }
  } finally {
    if (!options.keepTemp) {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}
