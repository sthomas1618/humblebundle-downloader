import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { Command } from 'commander'

import {
  getPdfCbzEntry,
  loadCache,
  saveCache,
  setPdfCbzEntry,
  shouldRegeneratePdfCbz,
} from '../download/cache'
import { convertPdfToCbz } from '../tools/pdf2cbz'
import { runWithConcurrency } from '../utils/async'
import { commonParentDirectory } from '../utils/path'
import { getOutputPath, isGlobInput, resolveInputFiles } from './pdf2cbz-utils'

type Pdf2CbzOptions = {
  out?: string
  overwrite?: boolean
  force?: boolean
  keepTemp?: boolean
  concurrency?: number
  dryRun?: boolean
  render?: boolean
}

async function commandExists(command: string): Promise<boolean> {
  const isWindows = process.platform === 'win32'
  const shell = isWindows ? 'cmd' : 'sh'
  const commandArguments = isWindows ? ['/c', `where ${command}`] : ['-c', `command -v ${command}`]

  return await new Promise<boolean>((resolve) => {
    const child = spawn(shell, commandArguments, { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

function buildDependencyMessage(command: string): string {
  return [
    `Missing dependency: ${command}`,
    'Install hints:',
    '  macOS: brew install poppler',
    '  Linux: apt install poppler-utils',
    '  Windows: install Poppler and add bin to PATH',
  ].join('\n')
}

async function assertDependencies(options: Pdf2CbzOptions, program: Command): Promise<void> {
  const hasPdfImages = await commandExists('pdfimages')
  if (!hasPdfImages) {
    program.error(buildDependencyMessage('pdfimages'), { exitCode: 1 })
  }

  if (options.render) {
    const hasPdftoppm = await commandExists('pdftoppm')
    if (!hasPdftoppm) {
      program.error(buildDependencyMessage('pdftoppm'), { exitCode: 1 })
    }
  }
}

export function registerPdf2CbzCommand(program: Command): void {
  program
    .command('pdf2cbz')
    .description('Convert comic PDFs into CBZ archives')
    .argument('<glob-or-path>', 'PDF path or glob to process')
    .option('-o, --out <dir>', 'Output directory (defaults to the PDF directory)')
    .option('--overwrite', 'Overwrite existing CBZ files', false)
    .option('--force', 'Regenerate CBZ even if cache is up-to-date', false)
    .option('--keep-temp', 'Keep temporary extraction directory', false)
    .option('--concurrency <n>', 'Number of concurrent conversions', (value) =>
      Number.parseInt(value, 10)
    )
    .option('--dry-run', 'Print actions without writing CBZs or cache', false)
    .option('--render', 'Render pages to PNGs when no embedded images exist', false)
    .action(async (input: string, options: Pdf2CbzOptions) => {
      await assertDependencies(options, program)
      const { files, root } = await resolveInputFiles(input)
      if (files.length === 0) {
        program.error('No PDF files found to process.', { exitCode: 1 })
      }

      const cacheRoot = isGlobInput(input) ? root : commonParentDirectory(files)
      const cache = await loadCache(cacheRoot)
      const concurrency =
        options.concurrency && Number.isFinite(options.concurrency) && options.concurrency > 0
          ? options.concurrency
          : 2

      let skippedCount = 0
      let convertedCount = 0
      let dryRunCount = 0

      await runWithConcurrency(files, concurrency, async (pdfPath) => {
        const fileStats = await stat(pdfPath)
        const pdfStats = { mtimeMs: fileStats.mtimeMs, size: fileStats.size }
        const cbzPath = getOutputPath(pdfPath, options.out)
        const cacheKey = path.relative(cacheRoot, pdfPath)
        const entry = getPdfCbzEntry(cache, cacheKey)
        const needsRegeneration = shouldRegeneratePdfCbz(entry, pdfStats, options.force ?? false)
        const cbzExists = existsSync(cbzPath)

        if (!needsRegeneration && !options.overwrite) {
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
          console.log(`Dry run: convert ${pdfPath} -> ${cbzPath}`)
          return
        }

        console.log(`Converting ${pdfPath} -> ${cbzPath}`)
        await convertPdfToCbz(pdfPath, {
          cbzPath,
          keepTemp: options.keepTemp,
          renderFallback: options.render,
        })
        setPdfCbzEntry(cache, cacheKey, {
          pdfMtimeMs: pdfStats.mtimeMs,
          pdfSize: pdfStats.size,
          cbzPath,
          lastGeneratedMs: Date.now(),
        })
        convertedCount += 1
      })

      if (!options.dryRun) {
        await saveCache(cacheRoot, cache)
      }

      console.log(
        `Processed ${files.length} PDFs. Converted: ${convertedCount}, skipped: ${skippedCount}, dry-run: ${dryRunCount}.`
      )
    })
}
