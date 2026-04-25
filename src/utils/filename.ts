export function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

export function normalizeFilenameStem(filename: string): string {
  return stripExtension(filename)
    .toLowerCase()
    .replace(/_\d{8,13}$/, '')
    .replace(/_ebook$/, '')
    .replaceAll(/[^\da-z]+/g, '')
}

function getVolumePrefix(stem: string): string | undefined {
  return stem.match(/^(.*?vol(?:ume)?0*\d+)/)?.[1]
}

function getBookVolumeAlias(stem: string): string | undefined {
  const bookNumbers: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  }
  const match = stem.match(/^(.*)book(one|two|three|four|five|six|seven|eight|nine|ten)$/)
  if (!match) {
    return undefined
  }
  return `${match[1]}vol${bookNumbers[match[2]]}`
}

export function buildFilenameAliases(filename: string): string[] {
  const stem = normalizeFilenameStem(filename)
  const aliases = new Set<string>([filename.toLowerCase(), stem])
  const volumePrefix = getVolumePrefix(stem)
  const bookVolumeAlias = getBookVolumeAlias(stem)

  if (volumePrefix && volumePrefix.length >= 8) {
    aliases.add(`prefix:${volumePrefix}`)
  }
  if (bookVolumeAlias && bookVolumeAlias.length >= 8) {
    aliases.add(bookVolumeAlias)
    aliases.add(`prefix:${bookVolumeAlias}`)
  }

  return [...aliases]
}
