import type { Command } from 'commander'

import { commandExists } from '../utils/command'

type Pdf2CbzOptions = {
  archiveMode?: string
  render?: boolean
  validate?: boolean
  repair?: boolean
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
  if (options.archiveMode === 'only') {
    return
  }

  if (options.validate && !options.repair) {
    const hasPdfInfo = await commandExists('pdfinfo')
    if (!hasPdfInfo) {
      program.error(buildDependencyMessage('pdfinfo'), { exitCode: 1 })
    }
    return
  }

  if (options.repair) {
    const hasPdfInfo = await commandExists('pdfinfo')
    if (!hasPdfInfo) {
      program.error(buildDependencyMessage('pdfinfo'), { exitCode: 1 })
    }
    const hasPdftoppm = await commandExists('pdftoppm')
    if (!hasPdftoppm) {
      program.error(buildDependencyMessage('pdftoppm'), { exitCode: 1 })
    }
    return
  }

  const hasPdfImages = await commandExists('pdfimages')
  if (!hasPdfImages) {
    program.error(buildDependencyMessage('pdfimages'), { exitCode: 1 })
  }

  const hasPdfInfo = await commandExists('pdfinfo')
  if (!hasPdfInfo) {
    program.error(buildDependencyMessage('pdfinfo'), { exitCode: 1 })
  }

  const hasPdftoppm = await commandExists('pdftoppm')
  if (!hasPdftoppm) {
    program.error(buildDependencyMessage('pdftoppm'), { exitCode: 1 })
  }
}
