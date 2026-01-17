import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Ensure the parent directory for a file path exists.
 */
export const ensureDirectory = async (path: string) => {
  await mkdir(dirname(path), { recursive: true })
}

/**
 * Mirror the Python `_clean_name` normalization rules for folder/file names.
 */
export const cleanName = (dirtyName: string): string => {
  const allowedChars = new Set([' ', '_', '.', '-', '[', ']'])
  const normalized = dirtyName.replaceAll('+', '_').replaceAll(':', ' -')
  const cleaned = Array.from(normalized)
    .filter((char) => {
      const isAllowed = allowedChars.has(char)
      const isAlphaNumeric = /[a-z0-9]/i.test(char)
      return isAllowed || isAlphaNumeric
    })
    .join('')

  return cleaned.trim().replace(/\.+$/, '')
}

export const buildProductFolder = (
  libraryPath: string,
  bundleTitle: string,
  productTitle: string
): string => {
  return join(libraryPath, cleanName(bundleTitle), cleanName(productTitle))
}

export const buildTroveFolder = (libraryPath: string, title: string): string => {
  return join(libraryPath, 'Humble Trove', cleanName(title))
}
