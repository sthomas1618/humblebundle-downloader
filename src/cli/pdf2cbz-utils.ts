import path from 'node:path'

import { isGlobInput, resolveInputFiles as resolveFiles } from '../utils/glob'

const PDF_EXTENSION = '.pdf'

/**
 * Resolve pdf2cbz inputs into PDF file paths and a cache root.
 */
export async function resolveInputFiles(
  input: string
): Promise<{ files: string[]; root: string }> {
  return await resolveFiles(input, {
    filter: (filePath) => path.extname(filePath).toLowerCase() === PDF_EXTENSION,
  })
}

/**
 * Build the target CBZ path for a PDF, optionally using a custom output directory.
 */
export function getOutputPath(pdfPath: string, outDir?: string): string {
  const basename = path.basename(pdfPath, PDF_EXTENSION)
  const targetDir = outDir ? path.resolve(outDir) : path.dirname(pdfPath)
  return path.join(targetDir, `${basename}.cbz`)
}

/**
 * Re-export glob detection for CLI input handling.
 */
export { isGlobInput }
