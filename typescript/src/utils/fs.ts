import { mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Ensure the parent directory for a file path exists.
 */
export async function ensureDirectory(pathToFile: string): Promise<void> {
  await mkdir(path.dirname(pathToFile), { recursive: true })
}

/**
 * Mirror the Python `_clean_name` normalization rules for folder/file names.
 */
export function cleanName(dirtyName: string): string {
  const allowedChars = new Set([' ', '_', '.', '-', '[', ']'])
  const normalized = dirtyName.replaceAll('+', '_').replaceAll(':', ' -')
  const cleaned = [...normalized]
    .filter((char) => {
      const isAllowed = allowedChars.has(char)
      const isAlphaNumeric = /[\da-z]/i.test(char)
      return isAllowed || isAlphaNumeric
    })
    .join('')

  return cleaned.trim().replace(/\.+$/, '')
}

export function buildProductFolder(
  libraryPath: string,
  bundleTitle: string,
  productTitle: string
): string {
  return path.join(libraryPath, cleanName(bundleTitle), cleanName(productTitle))
}

export function buildTroveFolder(libraryPath: string, title: string): string {
  return path.join(libraryPath, 'Humble Trove', cleanName(title))
}
