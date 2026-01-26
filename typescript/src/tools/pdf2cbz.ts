import { createWriteStream } from 'node:fs'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { spawn } from 'node:child_process'

import yauzl from 'yauzl'
import { ZipFile } from 'yazl'

import { ensureDirectory } from '../utils/fs'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.jp2', '.tif', '.tiff'])

const naturalSort = (a: string, b: string) => {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return collator.compare(a, b)
}

const runCommand = async (command: string, args: string[]): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`Command failed (${command} ${args.join(' ')}): exit code ${code ?? ''}`))
    })
  })
}

const runPdfImages = async (pdfPath: string, outputPrefix: string): Promise<void> => {
  await runCommand('pdfimages', ['-all', pdfPath, outputPrefix])
}

const runPdfRender = async (
  pdfPath: string,
  outputDir: string,
  tool: 'pdftoppm' | 'mutool'
): Promise<void> => {
  if (tool === 'mutool') {
    const outputTemplate = join(outputDir, 'page-%04d.png')
    await runCommand('mutool', ['draw', '-o', outputTemplate, pdfPath])
    return
  }
  const outputPrefix = join(outputDir, 'page')
  await runCommand('pdftoppm', ['-png', pdfPath, outputPrefix])
}

const collectImages = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory)
  return entries
    .filter((entry) => IMAGE_EXTENSIONS.has(extname(entry).toLowerCase()))
    .map((entry) => join(directory, entry))
}

const normalizeEntryName = (index: number, extension: string): string => {
  const padded = String(index).padStart(4, '0')
  return `${padded}${extension.toLowerCase()}`
}

const createCbz = async (
  cbzPath: string,
  imagePaths: string[],
  preservedComicInfo?: Buffer
): Promise<void> => {
  await ensureDirectory(cbzPath)
  await new Promise<void>((resolve, reject) => {
    const zip = new ZipFile()
    const output = createWriteStream(cbzPath)
    output.on('error', reject)
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(output).on('close', resolve)

    imagePaths.forEach((imagePath, index) => {
      const extension = extname(imagePath)
      const entryName = normalizeEntryName(index + 1, extension)
      zip.addFile(imagePath, entryName, { compress: false })
    })

    if (preservedComicInfo) {
      zip.addBuffer(preservedComicInfo, 'ComicInfo.xml', { compress: false })
    }

    zip.end()
  })
}

const readComicInfoXml = async (cbzPath: string): Promise<Buffer | undefined> => {
  await access(cbzPath)
  return await new Promise<Buffer | undefined>((resolve, reject) => {
    yauzl.open(cbzPath, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(error ?? new Error('Unable to open CBZ for ComicInfo.xml'))
        return
      }

      const handleClose = () => zipfile.close()
      zipfile.on('error', (err) => {
        handleClose()
        reject(err)
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
            stream.on('error', (streamErr) => {
              handleClose()
              reject(streamErr)
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
        resolve(undefined)
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
  tempDir: string
  imageCount: number
  usedRenderFallback: boolean
}

export const convertPdfToCbz = async (
  pdfPath: string,
  options: Pdf2CbzOptions
): Promise<Pdf2CbzResult> => {
  const tempDir = await mkdtemp(join(tmpdir(), 'hbd-pdf2cbz-'))
  const outputPrefix = join(tempDir, 'page')
  let usedRenderFallback = false
  let preservedComicInfo: Buffer | undefined

  try {
    try {
      preservedComicInfo = await readComicInfoXml(options.cbzPath)
    } catch {
      preservedComicInfo = undefined
    }

    await runPdfImages(pdfPath, outputPrefix)
    let images = await collectImages(tempDir)

    if (images.length === 0 && options.renderFallback) {
      usedRenderFallback = true
      const tool = options.renderTool ?? 'pdftoppm'
      await runPdfRender(pdfPath, tempDir, tool)
      images = await collectImages(tempDir)
    }

    if (images.length === 0) {
      throw new Error('No embedded images found; PDF may be vector/text-only or protected.')
    }

    images.sort((a, b) => naturalSort(basename(a), basename(b)))
    await createCbz(options.cbzPath, images, preservedComicInfo)

    return {
      cbzPath: options.cbzPath,
      tempDir,
      imageCount: images.length,
      usedRenderFallback,
    }
  } finally {
    if (!options.keepTemp) {
      await rm(tempDir, { recursive: true, force: true })
    }
  }
}
