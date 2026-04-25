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

export function comparableTitle(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/['`‘’]/g, '')
    .replaceAll('&', ' ')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replaceAll(/\bhumble\b/g, ' ')
    .replaceAll(/\b(?:book|tech|comic|comics|manga)\s+bundle\b/g, ' ')
    .replaceAll(/\bby\b.+$/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

function comparableTitleTokens(title: string): Set<string> {
  return new Set(
    comparableTitle(title)
      .split(' ')
      .filter((token) => token.length >= 3)
  )
}

export function hasSimilarTitle(candidateTitle: string, expectedTitle: string): boolean {
  const candidate = comparableTitle(candidateTitle)
  const expected = comparableTitle(expectedTitle)
  if (!candidate || !expected) {
    return false
  }
  if (candidate === expected || candidate.includes(expected) || expected.includes(candidate)) {
    return true
  }

  const candidateTokens = comparableTitleTokens(candidateTitle)
  const expectedTokens = comparableTitleTokens(expectedTitle)
  if (candidateTokens.size === 0 || expectedTokens.size === 0) {
    return false
  }

  let overlap = 0
  for (const token of candidateTokens) {
    if (expectedTokens.has(token)) {
      overlap += 1
    }
  }

  return overlap >= 2 && overlap / candidateTokens.size >= 0.5
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
