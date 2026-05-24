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

export function cleanPublisherName(dirtyName: string): string {
  const allowedChars = new Set([' ', '_', '.', '-', '[', ']', '&'])
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

const BUILT_IN_PUBLISHER_FOLDERS = [
  'Dynamite',
  'Titan',
  'Valiant',
  'Humanoids',
  'Image Comics',
  'IDW',
  'Archie',
  'Heavy Metal',
  'Walter Foster',
  'Black Decker',
]

const PUBLISHER_SHOWCASE_PATTERNS = [
  /\b(?:best year of|year of)\s+(.+?)\s*$/i,
  /^humble\s+(?:books?|comics?|manga)\s+bundle:\s+(.+?)\s+\d+(?:st|nd|rd|th)?\s+anniversary\b/i,
  /^humble\s+(?:books?|comics?|manga)\s+bundle:\s+(.+?)\s+(?:mega\s+bundle|anniversary(?:\s+bundle)?|spotlight|showcase)\s*$/i,
  /^(.+?)\s+(?:mega\s+bundle|anniversary(?:\s+bundle)?|spotlight|showcase)\s*$/i,
]

const BUILT_IN_PUBLISHER_TITLE_PATTERNS: Array<{ folder: string; pattern: RegExp }> = [
  { folder: 'Image Comics', pattern: /\b(?:image\s+comics|image\s+expo)\b/i },
  { folder: 'IDW', pattern: /\bidw(?:'s)?\b/i },
  { folder: 'Archie', pattern: /\barchie\b/i },
  { folder: 'Heavy Metal', pattern: /\bheavy\s+metal\b/i },
  { folder: 'Humanoids', pattern: /\bhumanoids\b/i },
  { folder: 'Walter Foster', pattern: /\bwalter\s+foster\b/i },
  { folder: 'Black Decker', pattern: /\bblack\s*(?:\+|and)?\s*decker\b/i },
  { folder: 'Dynamite', pattern: /\bdynamite(?:'s)?\b/i },
  { folder: 'Titan', pattern: /\btitan\s+comics\b/i },
  { folder: 'Valiant', pattern: /\bvaliant\b/i },
]

function inferBuiltInPublisherFolder(bundleTitle: string): string | undefined {
  if (
    !/\bbundle\b/i.test(bundleTitle) &&
    !/^the bleeding heart of heavy metal\b/i.test(bundleTitle)
  ) {
    return undefined
  }
  return BUILT_IN_PUBLISHER_TITLE_PATTERNS.find(({ pattern }) => pattern.test(bundleTitle))?.folder
}

function cleanPublisherCandidateName(value: string): string {
  return cleanPublisherName(value.replace(/\s*(?:'s|\u2019s)\s*$/i, ''))
}

function uniquePublisherCandidates(publisherFolderCandidates: string[]): string[] {
  const candidates = new Map<string, string>()
  for (const candidate of [...publisherFolderCandidates, ...BUILT_IN_PUBLISHER_FOLDERS]) {
    if (!isPublisherFolderCandidate(candidate)) {
      continue
    }
    const familyKey = normalizePublisherFamilyKey(candidate)
    if (!candidates.has(familyKey)) {
      candidates.set(familyKey, cleanPublisherName(candidate))
    }
  }
  return [...candidates.values()]
}

function publisherTitlePhraseMatches(titleKey: string, familyKey: string): boolean {
  return new RegExp(`(?:^| )${escapeRegExp(familyKey)}(?: |$)`).test(titleKey)
}

function singleTokenPublisherTitleMatches(
  title: string,
  titleKey: string,
  familyKey: string
): boolean {
  return (
    new RegExp(`\\b${escapeRegExp(familyKey)}\\s*(?:'s|\u2019s)\\b`, 'i').test(title) ||
    new RegExp(
      `(?:^| )${escapeRegExp(familyKey)} (?:books?|comics?|entertainment|media|press|publishers?|publishing|studios?)(?: |$)`
    ).test(titleKey)
  )
}

function canonicalKnownPublisherCandidate(
  publisherFolder: string,
  publisherFolderCandidates: string[] = []
): string | undefined {
  const familyKey = normalizePublisherFamilyKey(publisherFolder)
  return uniquePublisherCandidates(publisherFolderCandidates).find(
    (candidate) => normalizePublisherFamilyKey(candidate) === familyKey
  )
}

export function inferKnownPublisherFolder(
  bundleTitle: string,
  publisherFolderCandidates: string[] = []
): string | undefined {
  if (!/\bbundle\b/i.test(bundleTitle)) {
    return
  }
  const titleKey = normalizeFlatPublisherKey(bundleTitle)
  const matches = uniquePublisherCandidates(publisherFolderCandidates)
    .map((folder) => {
      const familyKey = normalizePublisherFamilyKey(folder)
      if (!familyKey || familyKey === 'humble') {
        return
      }
      const familyTokens = familyKey.split(' ').filter(Boolean)
      const matchesTitle =
        familyTokens.length === 1
          ? singleTokenPublisherTitleMatches(bundleTitle, titleKey, familyKey)
          : publisherTitlePhraseMatches(titleKey, familyKey)
      return matchesTitle ? { folder, familyKey } : undefined
    })
    .filter((match): match is { folder: string; familyKey: string } => match !== undefined)
    .sort((left, right) => {
      const familyLengthDifference = right.familyKey.length - left.familyKey.length
      if (familyLengthDifference !== 0) {
        return familyLengthDifference
      }
      return right.folder.length - left.folder.length
    })

  return matches[0]?.folder
}

export function inferPublisherFocusedFolder(bundleTitle: string): string | undefined {
  const title = bundleTitle.replace(/\s+encore\b/i, '').trim()
  for (const pattern of PUBLISHER_SHOWCASE_PATTERNS) {
    const publisher = title.match(pattern)?.[1]
    const cleaned = publisher ? cleanPublisherCandidateName(publisher) : undefined
    if (cleaned) {
      return canonicalKnownPublisherCandidate(cleaned) ?? cleaned
    }
  }
  return undefined
}

export function inferPublisherFolder(
  bundleTitle: string,
  publisherFolderCandidates: string[] = []
): string {
  const title = bundleTitle.replace(/\s+encore\b/i, '').trim()
  const byMatches = [...title.matchAll(/\bby\s+(.+?)(?=\s+by\s+|\s*$)/gi)]
  const finalByPublisher = byMatches.at(-1)?.[1]
  const finalFromPublisher = title.match(/\bfrom\s+(.+?)\s*$/i)?.[1]
  const focusedPublisher = inferPublisherFocusedFolder(title)
  const inferredPublisher =
    title.match(/\bpresented by\s+(.+?)\s*$/i)?.[1] ??
    (finalByPublisher?.match(/\bfrom\b/i) ? undefined : finalByPublisher) ??
    finalFromPublisher ??
    (focusedPublisher
      ? (canonicalKnownPublisherCandidate(focusedPublisher, publisherFolderCandidates) ??
        focusedPublisher)
      : undefined) ??
    inferKnownPublisherFolder(title, publisherFolderCandidates) ??
    inferBuiltInPublisherFolder(title) ??
    inferColonPublisher(title) ??
    'humble'

  return cleanPublisherName(inferredPublisher) || 'humble'
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
  'private',
  'publisher',
  'publishers',
  'publishing',
  'pvt',
  'studio',
  'studios',
  'megabundle',
  'anniversary',
  'collection',
  'bundle',
])

const PUBLISHER_LOCATION_SUFFIXES = [
  ['berkeley', 'ca'],
  ['new', 'york'],
]

export function normalizePublisherFamilyKey(publisherFolder: string): string {
  const tokens = normalizeFlatPublisherKey(publisherFolder).split(' ').filter(Boolean)
  if (tokens[0] === 'the' && tokens.length > 1) {
    tokens.shift()
  }
  stripPublisherLocationSuffix(tokens)
  while (tokens.length > 1 && PUBLISHER_SUFFIX_WORDS.has(tokens.at(-1) ?? '')) {
    tokens.pop()
  }
  while (tokens.length > 1 && /^\d+(?:st|nd|rd|th)?$/.test(tokens.at(-1) ?? '')) {
    tokens.pop()
  }
  return tokens.join(' ')
}

function stripPublisherLocationSuffix(tokens: string[]): void {
  const normalizedTokens = tokens.map((token) => normalizeFlatPublisherKey(token))
  for (const suffix of PUBLISHER_LOCATION_SUFFIXES) {
    if (
      tokens.length > suffix.length &&
      suffix.every((token, index) => normalizedTokens.at(index - suffix.length) === token)
    ) {
      tokens.splice(tokens.length - suffix.length, suffix.length)
      return
    }
  }
}

const CANONICAL_PUBLISHER_FOLDER_SUFFIX_WORDS = new Set([
  'book',
  'books',
  'comic',
  'comics',
  'entertainment',
  'publisher',
  'publishers',
  'publishing',
])

const CANONICAL_PUBLISHER_LEGAL_SUFFIX_WORDS = new Set([
  'company',
  'inc',
  'limited',
  'llc',
  'ltd',
  'private',
  'pvt',
])

export function canonicalPublisherFolderName(publisherFolder: string): string {
  const cleaned = cleanPublisherName(publisherFolder)
  const tokens = cleaned.split(/\s+/).filter(Boolean)
  const hadLeadingThe = tokens[0]?.toLowerCase() === 'the'
  if (hadLeadingThe && tokens.length > 1) {
    tokens.shift()
  }
  stripPublisherLocationSuffix(tokens)
  while (
    tokens.length > 1 &&
    CANONICAL_PUBLISHER_LEGAL_SUFFIX_WORDS.has(normalizeFlatPublisherKey(tokens.at(-1) ?? ''))
  ) {
    tokens.pop()
  }
  if (
    tokens.length > 1 &&
    normalizeFlatPublisherKey(tokens.at(-1) ?? '') === 'group' &&
    (hadLeadingThe || tokens.length <= 3)
  ) {
    tokens.pop()
  }
  if (tokens.length > 2 && normalizeFlatPublisherKey(tokens.at(-1) ?? '') === 'press') {
    tokens.pop()
  }
  while (
    tokens.length > 1 &&
    CANONICAL_PUBLISHER_FOLDER_SUFFIX_WORDS.has(normalizeFlatPublisherKey(tokens.at(-1) ?? ''))
  ) {
    if (
      normalizeFlatPublisherKey(tokens.at(-1) ?? '') === 'publishing' &&
      tokens.slice(0, -1).every((token) => normalizeFlatPublisherKey(token).length === 1)
    ) {
      break
    }
    tokens.pop()
  }
  return tokens.join(' ') || cleaned
}

function isLegacyBundleLikePublisherFolder(publisherFolder: string): boolean {
  const key = normalizeFlatPublisherKey(publisherFolder)
  return /\b(?:bundle|megabundle)\b/.test(key)
}

function isPublisherFolderCandidate(publisherFolder: string): boolean {
  const cleaned = cleanPublisherName(publisherFolder)
  const key = normalizeFlatPublisherKey(cleaned)
  const familyKey = normalizePublisherFamilyKey(cleaned)
  if (!cleaned || !familyKey || familyKey === 'humble') {
    return false
  }
  if (isLegacyBundleLikePublisherFolder(cleaned)) {
    return false
  }
  if (/^\d+$/.test(familyKey)) {
    return false
  }
  if (/\b(?:archive|archives|extras?|hot|programming|rails|series|the worlds of)\b/i.test(key)) {
    return false
  }
  return true
}

export async function collectPublisherFolderCandidates(
  libraries: Array<{ path: string; layout?: 'bundle' | 'flat' }>
): Promise<string[]> {
  const candidates = new Map<string, string>()
  for (const library of libraries) {
    if (library.layout !== 'flat') {
      continue
    }
    try {
      const entries = await readdir(library.path, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || !isPublisherFolderCandidate(entry.name)) {
          continue
        }
        const candidatePath = path.join(library.path, entry.name)
        let candidateEntries
        try {
          candidateEntries = await readdir(candidatePath, { withFileTypes: true })
        } catch {
          continue
        }
        if (
          candidateEntries.some((candidateEntry) => candidateEntry.isFile()) &&
          !candidateEntries.some((candidateEntry) => candidateEntry.isDirectory())
        ) {
          continue
        }
        const familyKey = normalizePublisherFamilyKey(entry.name)
        if (!candidates.has(familyKey)) {
          candidates.set(familyKey, entry.name)
        }
      }
    } catch {
      continue
    }
  }
  return [...candidates.values()].sort((left, right) => left.localeCompare(right))
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
          isPublisherFolderCandidate(entryName)
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

function escapeRegExp(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
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
