import path from 'node:path'

/**
 * Compute the deepest common parent directory for a set of paths.
 */
export function commonParentDirectory(paths: string[]): string {
  if (paths.length === 0) {
    return process.cwd()
  }
  const [first, ...rest] = paths.map((entry) => path.resolve(entry))
  const sharedParts = first.split(path.sep)
  for (const entry of rest) {
    const parts = entry.split(path.sep)
    let index = 0
    while (index < sharedParts.length && sharedParts[index] === parts[index]) {
      index += 1
    }
    sharedParts.length = index
  }
  if (sharedParts.length === 0) {
    return process.cwd()
  }
  return sharedParts.join(path.sep)
}
