import type { Command } from 'commander'

import { commandExists } from '../utils/command'

type Pdf2CbzOptions = {
  render?: boolean
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

export async function assertPdf2CbzDependencies(
  options: Pdf2CbzOptions,
  program: Command
): Promise<void> {
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
