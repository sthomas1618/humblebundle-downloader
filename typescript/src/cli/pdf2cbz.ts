import { spawn } from 'node:child_process'

import type { Command } from 'commander'

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
  const commandArguments = isWindows
    ? ['/c', `where ${command}`]
    : ['-c', `command -v ${command}`]

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
    .action(async (_input: string, _options: Pdf2CbzOptions) => {
      await assertDependencies(_options, program)
      program.error('pdf2cbz command is not yet implemented in the CLI handler.')
    })
}
