import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  collectImages,
  createCbz,
  mergeComicInfoXml,
  naturalSort,
  readComicInfoXml,
  runPdfImages,
  runPdfRender,
  type ComicInfoFields,
} from './pdf2cbz-helpers'

export { pdf2cbzTestUtils } from './pdf2cbz-helpers'

export type Pdf2CbzOptions = {
  cbzPath: string
  keepTemp?: boolean
  renderFallback?: boolean
  renderTool?: 'pdftoppm' | 'mutool'
  comicInfoFields?: ComicInfoFields
}

export type Pdf2CbzResult = {
  cbzPath: string
  temporaryDirectory: string
  imageCount: number
  usedRenderFallback: boolean
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
    const comicInfo = mergeComicInfoXml(preservedComicInfo, options.comicInfoFields ?? {})
    await createCbz(options.cbzPath, images, comicInfo.xml)

    return {
      cbzPath: options.cbzPath,
      temporaryDirectory,
      imageCount: images.length,
      usedRenderFallback,
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
