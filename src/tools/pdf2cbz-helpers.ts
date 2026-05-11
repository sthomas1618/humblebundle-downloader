import { createWriteStream } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import path from 'node:path'

import yauzl from 'yauzl'
import { ZipFile } from 'yazl'

import { runCommand } from '../utils/command'
import { ensureDirectory } from '../utils/fs'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.jp2', '.tif', '.tiff'])
const COMIC_INFO_FIELD_ORDER = ['Title', 'Series', 'Publisher', 'Notes'] as const

export type ComicInfoFieldName = (typeof COMIC_INFO_FIELD_ORDER)[number]

export type ComicInfoFields = Partial<Record<ComicInfoFieldName, string>>

export type ComicInfoResult = {
  xml?: Buffer
  fields: ComicInfoFieldName[]
  preserved: boolean
  generated: boolean
  merged: boolean
}

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

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function normalizedComicInfoFields(fields: ComicInfoFields): Array<[ComicInfoFieldName, string]> {
  return COMIC_INFO_FIELD_ORDER.map((field) => [field, fields[field]?.trim()] as const).filter(
    (entry): entry is [ComicInfoFieldName, string] => Boolean(entry[1])
  )
}

function hasComicInfoField(xml: string, field: ComicInfoFieldName): boolean {
  const match = xml.match(new RegExp(`<${field}\\b[^>]*>([\\s\\S]*?)<\\/${field}>`, 'i'))
  return Boolean(match?.[1]?.trim())
}

export function buildComicInfoXml(fields: ComicInfoFields): ComicInfoResult {
  const entries = normalizedComicInfoFields(fields)
  if (entries.length === 0) {
    return { fields: [], preserved: false, generated: false, merged: false }
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ComicInfo>',
    ...entries.map(([field, value]) => `  <${field}>${escapeXml(value)}</${field}>`),
    '</ComicInfo>',
    '',
  ]
  return {
    xml: Buffer.from(lines.join('\n'), 'utf8'),
    fields: entries.map(([field]) => field),
    preserved: false,
    generated: true,
    merged: false,
  }
}

export function mergeComicInfoXml(
  existingComicInfo: Buffer | undefined,
  fields: ComicInfoFields
): ComicInfoResult {
  if (!existingComicInfo) {
    return buildComicInfoXml(fields)
  }

  const existingXml = existingComicInfo.toString('utf8')
  const entries = normalizedComicInfoFields(fields).filter(
    ([field]) => !hasComicInfoField(existingXml, field)
  )
  if (entries.length === 0 || !/<\/comicinfo\s*>/i.test(existingXml)) {
    return {
      xml: existingComicInfo,
      fields: [],
      preserved: true,
      generated: false,
      merged: false,
    }
  }

  const insertion = entries
    .map(([field, value]) => `  <${field}>${escapeXml(value)}</${field}>`)
    .join('\n')
  const mergedXml = existingXml.replace(/(\s*)<\/comicinfo\s*>/i, `\n${insertion}$1</ComicInfo>`)
  return {
    xml: Buffer.from(mergedXml, 'utf8'),
    fields: entries.map(([field]) => field),
    preserved: true,
    generated: false,
    merged: true,
  }
}

export async function createCbz(
  cbzPath: string,
  imagePaths: string[],
  comicInfo?: Buffer
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

    if (comicInfo) {
      zip.addBuffer(comicInfo, 'ComicInfo.xml', { compress: false })
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
  buildComicInfoXml,
  mergeComicInfoXml,
  naturalSort,
  normalizeEntryName,
  readComicInfoXml,
}
