import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import type { AppConfig, ScanLibraryConfig } from '../../config'
import {
  getPdfCbzEntry,
  loadCache,
  saveCache,
  setPdfCbzEntry,
  shouldRegeneratePdfCbz,
  type PdfFileStats,
} from '../../download/cache'
import { getArchiveLibraryPath } from '../../download/downloader'
import {
  loadEnrichedMetadata,
  type EnrichedMetadataData,
  type EnrichedMetadataFile,
  type EnrichedMetadataMatch,
} from '../../download/enriched-metadata'
import { loadMetadata, type MetadataData, type MetadataProduct } from '../../download/metadata'
import { convertPdfToCbz } from '../../tools/pdf2cbz'
import type { ComicInfoFields } from '../../tools/pdf2cbz-helpers'
import { runWithConcurrency } from '../../utils/async'
import { normalizeFlatProductKey } from '../../utils/fs'
import { commonParentDirectory } from '../../utils/path'
import { assertPdf2CbzDependencies } from '../pdf2cbz-dependencies'
import { getOutputPath, isGlobInput, resolveInputFiles } from '../pdf2cbz-utils'
import { resolveCommandConfig } from '../utils/config'

type Pdf2CbzOptions = {
  config?: string
  library?: string
  libraryPath?: string
  cachePath?: string
  out?: string
  overwrite?: boolean
  force?: boolean
  keepTemp?: boolean
  concurrency?: number
  dryRun?: boolean
  render?: boolean
}

type ArchiveResult = {
  archivePdfPath?: string
  archiveStatus: 'not-configured' | 'moved' | 'duplicate-removed' | 'conflict' | 'kept'
  archiveConflictReason?: string
}

type ComicInfoContext = {
  enrichedMetadata?: EnrichedMetadataData
  humbleMetadata?: MetadataData
}

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

async function fileStats(filePath: string): Promise<PdfFileStats | undefined> {
  try {
    const stats = await stat(filePath)
    return { mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    return undefined
  }
}

function selectedLibrary(config: AppConfig): ScanLibraryConfig {
  return (
    config.scanLibraries.find((library) => library.name && library.name === config.libraryName) ??
    config.scanLibraries.find((library) => isSamePath(library.path, config.libraryPath)) ?? {
      name: config.libraryName,
      path: config.libraryPath,
      layout: 'bundle',
      formatPriority: config.formatPriority,
      extInclude: config.extInclude,
      extExclude: config.extExclude,
      archiveFormats: config.archiveFormats,
      platformInclude: config.platformInclude,
    }
  )
}

function libraryOutputPath(pdfPath: string, libraryRoot: string, outDirectory?: string): string {
  if (!outDirectory) {
    return getOutputPath(pdfPath)
  }
  const relativePath = path.relative(libraryRoot, pdfPath)
  const parsed = path.parse(relativePath)
  return path.join(path.resolve(outDirectory), parsed.dir, `${parsed.name}.cbz`)
}

function archivePdfPath(
  config: AppConfig,
  library: ScanLibraryConfig,
  pdfPath: string
): string | undefined {
  const archiveLibraryPath = getArchiveLibraryPath(config, library)
  if (!archiveLibraryPath) {
    return undefined
  }
  return path.join(archiveLibraryPath, path.relative(library.path, pdfPath))
}

async function archivePdf(
  pdfPath: string,
  pdfStats: PdfFileStats,
  targetPath?: string
): Promise<ArchiveResult> {
  if (!targetPath) {
    return { archiveStatus: 'not-configured' }
  }
  if (isSamePath(pdfPath, targetPath)) {
    return { archivePdfPath: targetPath, archiveStatus: 'kept' }
  }

  const existingStats = await fileStats(targetPath)
  if (existingStats) {
    if (existingStats.size === pdfStats.size) {
      await rm(pdfPath, { force: false })
      return { archivePdfPath: targetPath, archiveStatus: 'duplicate-removed' }
    }
    return {
      archivePdfPath: targetPath,
      archiveStatus: 'conflict',
      archiveConflictReason: 'Archive target already exists with a different file size.',
    }
  }

  await mkdir(path.dirname(targetPath), { recursive: true })
  await rename(pdfPath, targetPath)
  return { archivePdfPath: targetPath, archiveStatus: 'moved' }
}

function sameResolvedPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function findEnrichedFile(
  enrichedMetadata: EnrichedMetadataData | undefined,
  pdfPath: string
): EnrichedMetadataFile | undefined {
  return enrichedMetadata?.files.find((file) => sameResolvedPath(file.path, pdfPath))
}

function findMetadataProduct(
  metadata: MetadataData | undefined,
  match: EnrichedMetadataMatch | undefined
): MetadataProduct | undefined {
  if (!metadata || !match) {
    return undefined
  }
  return metadata.orders[match.orderId]?.products.find(
    (product) => product.productTitle === match.productTitle
  )
}

function findUniqueMetadataMatch(
  metadata: MetadataData | undefined,
  pdfPath: string
): EnrichedMetadataMatch | undefined {
  if (!metadata) {
    return undefined
  }
  const filename = path.basename(pdfPath).toLowerCase()
  const matches: EnrichedMetadataMatch[] = []
  for (const order of Object.values(metadata.orders)) {
    for (const product of order.products) {
      for (const download of product.downloads) {
        if (download.filename.toLowerCase() !== filename) {
          continue
        }
        matches.push({
          cacheKey: download.cacheKey,
          orderId: order.orderId,
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
          filename: download.filename,
        })
      }
    }
  }
  return matches.length === 1 ? matches[0] : undefined
}

export function buildComicInfoFields(
  pdfPath: string,
  context: ComicInfoContext
): ComicInfoFields | undefined {
  const enrichedFile = findEnrichedFile(context.enrichedMetadata, pdfPath)
  const match =
    enrichedFile?.matches.length === 1
      ? enrichedFile.matches[0]
      : findUniqueMetadataMatch(context.humbleMetadata, pdfPath)
  if (!match) {
    return undefined
  }

  const product = findMetadataProduct(context.humbleMetadata, match)
  const enrichedProduct =
    context.enrichedMetadata?.products[normalizeFlatProductKey(match.productTitle)]
  const title = enrichedFile?.title?.value ?? product?.productTitle ?? match.productTitle
  const publisher = enrichedFile?.publisher?.value ?? enrichedProduct?.publisher?.value
  const notes = [
    `Bundle: ${match.bundleTitle}`,
    `Order: ${match.orderId}`,
    `Source PDF: ${path.basename(pdfPath)}`,
    'Generated by humblebundle-downloader pdf2cbz.',
  ].join('\n')

  return {
    Title: title,
    Series: product?.productTitle ?? match.productTitle,
    Publisher: publisher,
    Notes: notes,
  }
}

export function registerPdf2CbzCommand(program: Command): void {
  program
    .command('pdf2cbz')
    .description('Convert comic PDFs into CBZ archives')
    .argument('[glob-or-path]', 'PDF path or glob to process')
    .option('--config <path>', 'Path to .hbd/config.json')
    .option('--library <name>', 'Configured library to transform')
    .option('-l, --library-path <path>', 'Library directory when no config is used')
    .option('--cache-path <path>', 'Cache file path (defaults to <library-path>/.cache.json)')
    .option('-o, --out <dir>', 'Output directory (defaults to the PDF directory)')
    .option('--overwrite', 'Overwrite existing CBZ files', false)
    .option('--force', 'Regenerate CBZ even if cache is up-to-date', false)
    .option('--keep-temp', 'Keep temporary extraction directory', false)
    .option('--concurrency <n>', 'Number of concurrent conversions', (value) =>
      Number.parseInt(value, 10)
    )
    .option('--dry-run', 'Print actions without writing CBZs or cache', false)
    .option('--render', 'Render pages to PNGs when no embedded images exist', false)
    .action(async (input: string | undefined, options: Pdf2CbzOptions) => {
      await assertPdf2CbzDependencies(options, program)
      const libraryMode = !input
      const resolvedConfig = libraryMode
        ? await resolveCommandConfig(program, {
            config: options.config,
            library: options.library,
            libraryPath: options.libraryPath,
            cachePath: options.cachePath,
          })
        : undefined
      const config = resolvedConfig?.config
      const library = config ? selectedLibrary(config) : undefined
      const resolvedInput = libraryMode ? library?.path : input
      if (!resolvedInput) {
        program.error('No PDF files found to process.', { exitCode: 1 })
      }

      const { files, root } = await resolveInputFiles(resolvedInput)
      if (files.length === 0) {
        program.error('No PDF files found to process.', { exitCode: 1 })
      }

      const cacheRoot = libraryMode
        ? (library?.path ?? root)
        : isGlobInput(resolvedInput)
          ? root
          : commonParentDirectory(files)
      const cacheLibraryPath = config?.libraryPath ?? cacheRoot
      const cachePath = libraryMode ? config?.cachePath : options.cachePath
      const cache = await loadCache(cacheLibraryPath, cachePath)
      const comicInfoContext: ComicInfoContext =
        libraryMode && config
          ? {
              enrichedMetadata: await loadEnrichedMetadata(
                config.libraryPath,
                config.enrichedMetadataPath
              ),
              humbleMetadata: await loadMetadata(config.libraryPath, config.metadataPath),
            }
          : {}
      const concurrency =
        options.concurrency && Number.isFinite(options.concurrency) && options.concurrency > 0
          ? options.concurrency
          : 2

      let skippedCount = 0
      let convertedCount = 0
      let dryRunCount = 0
      let archivedCount = 0
      let archiveConflictCount = 0

      await runWithConcurrency(files, concurrency, async (pdfPath) => {
        const stats = await stat(pdfPath)
        const pdfStats = { mtimeMs: stats.mtimeMs, size: stats.size }
        const cbzPath =
          libraryMode && library
            ? libraryOutputPath(pdfPath, library.path, options.out)
            : getOutputPath(pdfPath, options.out)
        const cacheKey = path.relative(cacheRoot, pdfPath)
        const entry = getPdfCbzEntry(cache, cacheKey)
        const cbzStats = await fileStats(cbzPath)
        const needsRegeneration = shouldRegeneratePdfCbz(
          entry,
          pdfStats,
          options.force ?? false,
          cbzStats
        )
        const cbzExists = existsSync(cbzPath)
        const targetArchivePath =
          libraryMode && config && library ? archivePdfPath(config, library, pdfPath) : undefined
        const shouldArchiveFreshPdf =
          libraryMode &&
          targetArchivePath &&
          entry?.archiveStatus !== 'moved' &&
          entry?.archiveStatus !== 'duplicate-removed'

        if (!needsRegeneration && !options.overwrite) {
          if (shouldArchiveFreshPdf) {
            if (options.dryRun) {
              dryRunCount += 1
              console.log(`Dry run: archive ${pdfPath} -> ${targetArchivePath}`)
              return
            }
            const archiveResult = await archivePdf(pdfPath, pdfStats, targetArchivePath)
            if (
              archiveResult.archiveStatus === 'moved' ||
              archiveResult.archiveStatus === 'duplicate-removed'
            ) {
              archivedCount += 1
            }
            if (archiveResult.archiveStatus === 'conflict') {
              archiveConflictCount += 1
            }
            setPdfCbzEntry(cache, cacheKey, {
              ...entry!,
              archivePdfPath: archiveResult.archivePdfPath,
              archiveStatus: archiveResult.archiveStatus,
              archiveConflictReason: archiveResult.archiveConflictReason,
              cbzMtimeMs: cbzStats?.mtimeMs ?? entry?.cbzMtimeMs,
              cbzSize: cbzStats?.size ?? entry?.cbzSize,
            })
            console.log(`Archived source PDF: ${pdfPath}`)
            return
          }
          skippedCount += 1
          console.log(`Skipping (cache fresh): ${pdfPath}`)
          return
        }

        if (cbzExists && !options.overwrite && needsRegeneration) {
          skippedCount += 1
          console.log(`Skipping (exists, use --overwrite): ${cbzPath}`)
          return
        }

        if (options.dryRun) {
          dryRunCount += 1
          const archiveMessage = targetArchivePath ? `; archive PDF -> ${targetArchivePath}` : ''
          console.log(`Dry run: convert ${pdfPath} -> ${cbzPath}${archiveMessage}`)
          return
        }

        console.log(`Converting ${pdfPath} -> ${cbzPath}`)
        const result = await convertPdfToCbz(pdfPath, {
          cbzPath,
          keepTemp: options.keepTemp,
          renderFallback: options.render,
          comicInfoFields: libraryMode
            ? buildComicInfoFields(pdfPath, comicInfoContext)
            : undefined,
        })
        const generatedStats = await fileStats(cbzPath)
        const archiveResult = libraryMode
          ? await archivePdf(pdfPath, pdfStats, targetArchivePath)
          : ({ archiveStatus: 'kept' } satisfies ArchiveResult)
        if (
          archiveResult.archiveStatus === 'moved' ||
          archiveResult.archiveStatus === 'duplicate-removed'
        ) {
          archivedCount += 1
        }
        if (archiveResult.archiveStatus === 'conflict') {
          archiveConflictCount += 1
        }

        setPdfCbzEntry(cache, cacheKey, {
          version: 1,
          libraryName: library?.name,
          libraryPath: library?.path,
          pdfKey: cacheKey,
          pdfOriginalPath: pdfPath,
          pdfMtimeMs: pdfStats.mtimeMs,
          pdfSize: pdfStats.size,
          cbzPath,
          cbzMtimeMs: generatedStats?.mtimeMs,
          cbzSize: generatedStats?.size,
          archivePdfPath: archiveResult.archivePdfPath,
          archiveStatus: archiveResult.archiveStatus,
          archiveConflictReason: archiveResult.archiveConflictReason,
          lastGeneratedMs: Date.now(),
          imageCount: result.imageCount,
          renderFallbackUsed: result.usedRenderFallback,
          comicInfoPreserved: result.comicInfoPreserved,
          comicInfoGenerated: result.comicInfoGenerated,
          comicInfoMerged: result.comicInfoMerged,
          comicInfoFields: result.comicInfoFields,
        })
        convertedCount += 1
      })

      if (!options.dryRun) {
        await saveCache(cacheLibraryPath, cache, cachePath)
      }

      const modeLabel = libraryMode ? ` in library "${library?.name ?? cacheRoot}"` : ''
      console.log(
        `Processed ${files.length} PDFs${modeLabel}. Converted: ${convertedCount}, skipped: ${skippedCount}, archived: ${archivedCount}, archive conflicts: ${archiveConflictCount}, dry-run: ${dryRunCount}.`
      )
    })
}
