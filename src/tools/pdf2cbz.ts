import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  collectImages,
  createCbz,
  getPdfPageCount,
  mergeComicInfoXml,
  naturalSort,
  readComicInfoXml,
  removeImages,
  runPdfImages,
  runPdfRender,
  validatePdfImageSet,
  type ComicInfoFields,
  type PdfRenderImageFormat,
} from './pdf2cbz-helpers'

export { pdf2cbzTestUtils } from './pdf2cbz-helpers'

export type Pdf2CbzOptions = {
  cbzPath: string
  keepTemp?: boolean
  renderFallback?: boolean
  renderImageFormat?: PdfRenderImageFormat
  renderJpegQuality?: number
  renderTool?: 'pdftoppm' | 'mutool'
  comicInfoFields?: ComicInfoFields
}

export type Pdf2CbzResult = {
  cbzPath: string
  temporaryDirectory: string
  imageCount: number
  usedRenderFallback: boolean
  conversionMode: 'extracted' | 'rendered'
  renderImageFormat?: PdfRenderImageFormat
  pageCount: number
  validationWarnings: string[]
  comicInfoPreserved: boolean
  comicInfoGenerated: boolean
  comicInfoMerged: boolean
  comicInfoFields: string[]
}

export async function convertPdfToCbz(
  pdfPath: string,
  options: Pdf2CbzOptions
): Promise<Pdf2CbzResult> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-pdf2cbz-'))
  const outputPrefix = path.join(temporaryDirectory, 'page')
  let usedRenderFallback = false
  let conversionMode: 'extracted' | 'rendered' = 'extracted'
  const renderImageFormat = options.renderImageFormat ?? 'png'
  let validationWarnings: string[] = []
  let preservedComicInfo: Buffer | undefined

  try {
    try {
      preservedComicInfo = await readComicInfoXml(options.cbzPath)
    } catch {
      // ignore missing ComicInfo.xml
    }

    const pageCount = await getPdfPageCount(pdfPath)
    let images: string[] = []

    if (options.renderFallback) {
      usedRenderFallback = true
      conversionMode = 'rendered'
      const tool = options.renderTool ?? 'pdftoppm'
      await runPdfRender(
        pdfPath,
        temporaryDirectory,
        tool,
        renderImageFormat,
        options.renderJpegQuality
      )
      images = await collectImages(temporaryDirectory)
    } else {
      await runPdfImages(pdfPath, outputPrefix)
      images = await collectImages(temporaryDirectory)
      const extractedValidation = validatePdfImageSet(images, pageCount, {
        requireReaderSafeFormats: true,
      })

      if (!extractedValidation.valid) {
        validationWarnings = extractedValidation.reasons
        await removeImages(temporaryDirectory)
        usedRenderFallback = true
        conversionMode = 'rendered'
        await runPdfRender(
          pdfPath,
          temporaryDirectory,
          'pdftoppm',
          renderImageFormat,
          options.renderJpegQuality
        )
        images = await collectImages(temporaryDirectory)
      }
    }

    if (images.length === 0) {
      throw new Error('No embedded images found; PDF may be vector/text-only or protected.')
    }

    const finalValidation = validatePdfImageSet(images, pageCount)
    if (!finalValidation.valid) {
      throw new Error(
        `Generated image set failed validation: ${finalValidation.reasons.join('; ')}.`
      )
    }

    images.sort((a, b) => naturalSort(path.basename(a), path.basename(b)))
    const comicInfo = mergeComicInfoXml(preservedComicInfo, options.comicInfoFields ?? {})
    await createCbz(options.cbzPath, images, comicInfo.xml)

    return {
      cbzPath: options.cbzPath,
      temporaryDirectory,
      imageCount: images.length,
      usedRenderFallback,
      conversionMode,
      renderImageFormat: conversionMode === 'rendered' ? renderImageFormat : undefined,
      pageCount,
      validationWarnings,
      comicInfoPreserved: comicInfo.preserved,
      comicInfoGenerated: comicInfo.generated,
      comicInfoMerged: comicInfo.merged,
      comicInfoFields: comicInfo.fields,
    }
  } finally {
    if (!options.keepTemp) {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}
