import { mkdir, readdir } from 'node:fs/promises'
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

  return cleaned.trim().replaceAll(/\s+/g, ' ').replace(/\.+$/, '')
}

export function comparableTitle(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/['`\u2018\u2019]/g, '')
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

function inferColonPublisher(title: string): string | undefined {
  if (/^humble\b/i.test(title)) {
    return undefined
  }
  return title.match(/^([^:]+):\s+.+$/i)?.[1]
}

const PUBLISHER_SHOWCASE_PATTERNS = [
  /\b(?:best year of|year of)\s+(.+?)\s*$/i,
  /^humble\s+(?:books?|comics?|manga)\s+bundle:\s+(.+?)\s+\d+(?:st|nd|rd|th)?\s+anniversary\b/i,
  /^humble\s+(?:books?|comics?|manga)\s+bundle:\s+(.+?)\s+(?:mega\s+bundle|anniversary(?:\s+bundle)?|spotlight|showcase)\s*$/i,
  /^(.+?)\s+(?:mega\s+bundle|anniversary(?:\s+bundle)?|spotlight|showcase)\s*$/i,
]

export function inferPublisherFocusedFolder(bundleTitle: string): string | undefined {
  const title = bundleTitle.replace(/\s+encore\b/i, '').trim()
  for (const pattern of PUBLISHER_SHOWCASE_PATTERNS) {
    const publisher = title.match(pattern)?.[1]
    const cleaned = publisher ? cleanName(publisher) : undefined
    if (cleaned) {
      return cleaned
    }
  }
  return undefined
}

export function inferPublisherFolder(bundleTitle: string): string {
  const title = bundleTitle.replace(/\s+encore\b/i, '').trim()
  const byMatches = [...title.matchAll(/\bby\s+(.+?)(?=\s+by\s+|\s*$)/gi)]
  const finalByPublisher = byMatches.at(-1)?.[1]
  const finalFromPublisher = title.match(/\bfrom\s+(.+?)\s*$/i)?.[1]
  const inferredPublisher =
    title.match(/\bpresented by\s+(.+?)\s*$/i)?.[1] ??
    (finalByPublisher?.match(/\bfrom\b/i) ? undefined : finalByPublisher) ??
    finalFromPublisher ??
    inferPublisherFocusedFolder(title) ??
    inferColonPublisher(title) ??
    'humble'

  return cleanName(inferredPublisher) || 'humble'
}

const PUBLISHER_SUFFIX_WORDS = new Set([
  'book',
  'books',
  'comic',
  'comics',
  'company',
  'entertainment',
  'game',
  'games',
  'group',
  'inc',
  'lab',
  'labs',
  'limited',
  'llc',
  'ltd',
  'media',
  'press',
  'production',
  'productions',
  'publisher',
  'publishers',
  'publishing',
  'studio',
  'studios',
  'megabundle',
  'anniversary',
  'collection',
  'bundle',
])

export function normalizePublisherFamilyKey(publisherFolder: string): string {
  const tokens = normalizeFlatPublisherKey(publisherFolder).split(' ').filter(Boolean)
  while (tokens.length > 1 && PUBLISHER_SUFFIX_WORDS.has(tokens.at(-1) ?? '')) {
    tokens.pop()
  }
  while (tokens.length > 1 && /^\d+(?:st|nd|rd|th)?$/.test(tokens.at(-1) ?? '')) {
    tokens.pop()
  }
  return tokens.join(' ')
}

function isLegacyBundleLikePublisherFolder(publisherFolder: string): boolean {
  const key = normalizeFlatPublisherKey(publisherFolder)
  return /\b(?:bundle|megabundle)\b/.test(key)
}

export async function findExistingPublisherFolders(
  libraryPath: string,
  publisherFolder: string
): Promise<string[]> {
  const familyKey = normalizePublisherFamilyKey(publisherFolder)

  try {
    const entries = await readdir(libraryPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(
        (entryName) =>
          normalizePublisherFamilyKey(entryName) === familyKey &&
          !isLegacyBundleLikePublisherFolder(entryName)
      )
      .sort((left, right) => {
        const lengthDifference = left.length - right.length
        if (lengthDifference !== 0) {
          return lengthDifference
        }
        return left.localeCompare(right)
      })
  } catch {
    return []
  }
}

export async function resolvePublisherFolder(
  libraryPath: string,
  publisherFolder: string
): Promise<string> {
  const existingPublisherFolders = await findExistingPublisherFolders(libraryPath, publisherFolder)
  return existingPublisherFolders[0] ?? publisherFolder
}

export function inferSeriesFolder(productTitle: string): string {
  const original = productTitle.trim()
  const series = original
    .replace(/\s*\([^)]*(?:pdf|epub|mobi|cbz)[^)]*\)\s*$/i, '')
    .replace(/\s*[,:-]?\s*(?:vol\.?|volume)\s*#?\s*(?:\d+|[cdilmvx]+)\b.*$/i, '')
    .replace(/\s*[:-]?\s*book\s*\d+\b.*$/i, '')
    .replace(/\s*#\s*\d+\b.*$/i, '')
    .replace(/\s+issues?\s*#?\s*\d+\b.*$/i, '')
    .trim()

  return cleanName(series || original) || cleanName(original) || 'Unknown'
}

export function normalizeFlatProductKey(productTitle: string): string {
  return productTitle
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/['`\u2018\u2019]/g, '')
    .replaceAll('&', ' and ')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

export function normalizeFlatPublisherKey(publisher: string): string {
  return publisher
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/['`\u2018\u2019]/g, '')
    .replaceAll('&', ' and ')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
}

export function buildFlatProductFolder(
  libraryPath: string,
  publisherFolder: string,
  productTitle: string,
  seriesFolder = inferSeriesFolder(productTitle)
): string {
  return path.join(libraryPath, publisherFolder, seriesFolder)
}

export function buildLibraryProductFolder(
  library: { path: string; layout?: 'bundle' | 'flat' },
  bundleTitle: string,
  productTitle: string,
  publisherFolder = inferPublisherFolder(bundleTitle),
  seriesFolder = inferSeriesFolder(productTitle)
): string {
  if (library.layout === 'flat') {
    return buildFlatProductFolder(library.path, publisherFolder, productTitle, seriesFolder)
  }
  return buildProductFolder(library.path, bundleTitle, productTitle)
}

export function buildTroveFolder(libraryPath: string, title: string): string {
  return path.join(libraryPath, 'Humble Trove', cleanName(title))
}
