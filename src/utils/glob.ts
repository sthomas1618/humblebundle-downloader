import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/**
 * Options for resolving input paths into matched files.
 */
export type FileMatchOptions = {
  matches: (filePath: string) => boolean
}

/**
 * Result of resolving an input path to matched files.
 */
type ResolveResult = {
  files: string[]
  root: string
}

/**
 * Detect whether an input contains glob wildcards.
 */
function isGlobPattern(input: string): boolean {
  return /[*?]/.test(input)
}

/**
 * Convert a glob pattern into a RegExp for matching normalized absolute paths.
 */
function globToRegExp(pattern: string): RegExp {
  const normalized = path.resolve(pattern).split(path.sep).join('/')
  let regex = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*') {
      const next = normalized[index + 1]
      if (next === '*') {
        const nextNext = normalized[index + 2]
        if (nextNext === '/') {
          regex += '(?:.*/)?'
          index += 2
        } else {
          regex += '.*'
          index += 1
        }
      } else {
        regex += '[^/]*'
      }
    } else if (char === '?') {
      regex += '[^/]'
    } else if (String.raw`\\.^$+{}()|[]`.includes(char)) {
      regex += `\\${char}`
    } else {
      regex += char
    }
  }
  return new RegExp(`^${regex}$`)
}

/**
 * Get the non-glob directory root from a glob pattern.
 */
function getGlobRoot(pattern: string): string {
  const normalized = path.resolve(pattern)
  const parts = normalized.split(path.sep)
  const wildcardIndex = parts.findIndex((segment) => /[*?]/.test(segment))
  if (wildcardIndex === -1) {
    return path.dirname(normalized)
  }
  if (wildcardIndex === 0) {
    return process.cwd()
  }
  return parts.slice(0, wildcardIndex).join(path.sep)
}

/**
 * Recursively collect files that match the provided filter.
 */
async function collectFiles(directory: string, options: FileMatchOptions): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(entryPath, options)))
    } else if (entry.isFile() && options.matches(entryPath)) {
      results.push(entryPath)
    }
  }
  return results
}

/**
 * Public glob detection helper for CLI input routing.
 */
export function isGlobInput(input: string): boolean {
  return isGlobPattern(input)
}

/**
 * Resolve an input path/glob into matching files and the root directory used.
 */
export async function resolveInputFiles(
  input: string,
  options: FileMatchOptions
): Promise<ResolveResult> {
  if (isGlobPattern(input)) {
    const globRoot = getGlobRoot(input)
    const matcher = globToRegExp(input)
    const allFiles = await collectFiles(globRoot, options)
    const matched = allFiles.filter((file) => {
      return matcher.test(path.resolve(file).split(path.sep).join('/'))
    })
    return { files: matched, root: globRoot }
  }

  const resolved = path.resolve(input)
  const stats = await stat(resolved)
  if (stats.isDirectory()) {
    return { files: await collectFiles(resolved, options), root: resolved }
  }
  if (stats.isFile() && options.matches(resolved)) {
    return { files: [resolved], root: path.dirname(resolved) }
  }
  return { files: [], root: resolved }
}
