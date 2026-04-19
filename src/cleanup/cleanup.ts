import { mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { AppConfig } from '../config'
import { loadMetadata } from '../download/metadata'
import { cleanName, hasSimilarTitle } from '../utils/fs'

export type CleanupActionStatus = 'would-remove' | 'removed' | 'skipped' | 'conflict'

export type CleanupAction = {
  kind: 'empty-directory' | 'duplicate-directory'
  rootPath: string
  directoryPath: string
  status: CleanupActionStatus
  duplicateOf?: string
  fileCount?: number
  reason?: string
}

export type CleanupSummary = {
  dryRun: boolean
  rootsScanned: number
  directoriesScanned: number
  wouldRemove: number
  removed: number
  skipped: number
  conflicts: number
  reportPath?: string
}

export type CleanupReport = CleanupSummary & {
  actions: CleanupAction[]
}

export type CleanupOptions = {
  config: AppConfig
  apply?: boolean
  dedupe?: boolean
  reportPath?: string
  onProgress?: (message: string) => void
}

type DirectorySnapshot = {
  directoryPath: string
  depth: number
  entries: Array<{
    path: string
    isDirectory: boolean
  }>
}

type TopLevelDirectorySnapshot = {
  rootPath: string
  directoryPath: string
  directoryName: string
  files: FileSnapshot[]
  manifestKey: string
}

type FileSnapshot = {
  path: string
  name: string
  size: number
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of paths) {
    const resolved = path.resolve(value)
    const key = resolved.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(resolved)
  }
  return unique
}

function cleanupRoots(config: AppConfig): string[] {
  if (config.scanLibraries.length > 0) {
    return uniquePaths(config.scanLibraries.map((library) => library.path))
  }
  return uniquePaths([config.libraryPath, ...config.scanPaths])
}

function isSamePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

async function collectDirectories(
  rootPath: string,
  onProgress?: (message: string) => void
): Promise<DirectorySnapshot[]> {
  const snapshots: DirectorySnapshot[] = []

  async function visit(directoryPath: string): Promise<void> {
    let directoryEntries
    try {
      directoryEntries = await readdir(directoryPath, { withFileTypes: true })
    } catch (error) {
      onProgress?.(
        `Skipping ${directoryPath}: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }

    const entries = directoryEntries.map((entry) => ({
      path: path.join(directoryPath, entry.name),
      isDirectory: entry.isDirectory(),
    }))

    for (const entry of entries) {
      if (entry.isDirectory) {
        await visit(entry.path)
      }
    }

    snapshots.push({
      directoryPath,
      depth: path.relative(rootPath, directoryPath).split(path.sep).filter(Boolean).length,
      entries,
    })
  }

  await visit(rootPath)
  return snapshots
}

function planEmptyDirectoryActions(
  rootPath: string,
  snapshots: DirectorySnapshot[]
): CleanupAction[] {
  const removable = new Set<string>()
  const actions: CleanupAction[] = []
  const sorted = [...snapshots].sort((left, right) => right.depth - left.depth)

  for (const snapshot of sorted) {
    if (isSamePath(snapshot.directoryPath, rootPath)) {
      continue
    }

    const hasRemainingEntry = snapshot.entries.some((entry) => {
      if (!entry.isDirectory) {
        return true
      }
      return !removable.has(path.resolve(entry.path).toLowerCase())
    })

    if (hasRemainingEntry) {
      continue
    }

    removable.add(path.resolve(snapshot.directoryPath).toLowerCase())
    actions.push({
      kind: 'empty-directory',
      rootPath,
      directoryPath: snapshot.directoryPath,
      status: 'would-remove',
    })
  }

  return actions
}

function fileKey(file: Pick<FileSnapshot, 'name' | 'size'>): string {
  return `${file.name.toLowerCase()}|${file.size}`
}

function buildManifestKey(files: FileSnapshot[]): string {
  return files
    .map((file) => fileKey(file))
    .sort()
    .join('\n')
}

async function collectTopLevelDirectories(
  rootPath: string,
  onProgress?: (message: string) => void
): Promise<TopLevelDirectorySnapshot[]> {
  let entries
  try {
    entries = await readdir(rootPath, { withFileTypes: true })
  } catch (error) {
    onProgress?.(`Skipping ${rootPath}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }

  const snapshots: TopLevelDirectorySnapshot[] = []

  async function collectFiles(directoryPath: string): Promise<FileSnapshot[]> {
    const files: FileSnapshot[] = []

    async function visit(currentDirectory: string): Promise<void> {
      let directoryEntries
      try {
        directoryEntries = await readdir(currentDirectory, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of directoryEntries) {
        const entryPath = path.join(currentDirectory, entry.name)
        if (entry.isDirectory()) {
          await visit(entryPath)
          continue
        }
        if (!entry.isFile()) {
          continue
        }
        const fileStats = await stat(entryPath)
        files.push({
          path: entryPath,
          name: entry.name,
          size: fileStats.size,
        })
      }
    }

    await visit(directoryPath)
    return files
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }
    const directoryPath = path.join(rootPath, entry.name)
    const files = await collectFiles(directoryPath)
    snapshots.push({
      rootPath,
      directoryPath,
      directoryName: entry.name,
      files,
      manifestKey: buildManifestKey(files),
    })
  }

  return snapshots
}

function coveredByDirectory(
  candidate: TopLevelDirectorySnapshot,
  keeper: TopLevelDirectorySnapshot
): boolean {
  if (candidate.files.length === 0 || keeper.files.length === 0) {
    return false
  }

  const keeperFiles = new Set(keeper.files.map((file) => fileKey(file)))
  return candidate.files.every((file) => keeperFiles.has(fileKey(file)))
}

function samePathKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase()
}

function chooseDuplicateKeeper(
  directories: TopLevelDirectorySnapshot[],
  canonicalDirectoryNames: Set<string>
): TopLevelDirectorySnapshot {
  return [...directories].sort((left, right) => {
    const leftCanonical = canonicalDirectoryNames.has(left.directoryName.toLowerCase())
    const rightCanonical = canonicalDirectoryNames.has(right.directoryName.toLowerCase())
    if (leftCanonical !== rightCanonical) {
      return leftCanonical ? -1 : 1
    }
    if (left.directoryName.length !== right.directoryName.length) {
      return right.directoryName.length - left.directoryName.length
    }
    return left.directoryName.localeCompare(right.directoryName)
  })[0]!
}

async function planDuplicateDirectoryActions(
  config: AppConfig,
  roots: string[],
  onProgress?: (message: string) => void
): Promise<CleanupAction[]> {
  onProgress?.('Loading metadata for duplicate cleanup...')
  const metadata = await loadMetadata(config.libraryPath, config.metadataPath)
  const canonicalDirectoryNames = new Set(
    Object.values(metadata.orders).map((order) => cleanName(order.bundleTitle).toLowerCase())
  )
  const actions: CleanupAction[] = []
  const plannedDirectories = new Set<string>()

  for (const [index, rootPath] of roots.entries()) {
    onProgress?.(`Scanning duplicate candidates ${index + 1}/${roots.length}: ${rootPath}`)
    const directories = await collectTopLevelDirectories(rootPath, onProgress)
    const directoriesByName = new Map(
      directories.map((directory) => [directory.directoryName.toLowerCase(), directory])
    )

    for (const directory of directories) {
      if (plannedDirectories.has(samePathKey(directory.directoryPath))) {
        continue
      }
      if (canonicalDirectoryNames.has(directory.directoryName.toLowerCase())) {
        continue
      }

      const coveredBy = [...canonicalDirectoryNames]
        .map((name) => directoriesByName.get(name))
        .find(
          (canonicalDirectory) =>
            canonicalDirectory &&
            hasSimilarTitle(directory.directoryName, canonicalDirectory.directoryName) &&
            coveredByDirectory(directory, canonicalDirectory)
        )

      if (!coveredBy) {
        continue
      }

      plannedDirectories.add(samePathKey(directory.directoryPath))
      actions.push({
        kind: 'duplicate-directory',
        rootPath,
        directoryPath: directory.directoryPath,
        duplicateOf: coveredBy.directoryPath,
        fileCount: directory.files.length,
        status: 'would-remove',
        reason: 'All files are present in a canonical Humble bundle folder by filename and size.',
      })
    }

    const groups = new Map<string, TopLevelDirectorySnapshot[]>()
    for (const directory of directories) {
      if (
        directory.files.length === 0 ||
        plannedDirectories.has(samePathKey(directory.directoryPath))
      ) {
        continue
      }
      const matches = groups.get(directory.manifestKey) ?? []
      matches.push(directory)
      groups.set(directory.manifestKey, matches)
    }

    for (const group of groups.values()) {
      if (group.length < 2) {
        continue
      }
      const keeper = chooseDuplicateKeeper(group, canonicalDirectoryNames)
      const keeperIsCanonical = canonicalDirectoryNames.has(keeper.directoryName.toLowerCase())
      for (const duplicate of group) {
        if (duplicate === keeper || plannedDirectories.has(samePathKey(duplicate.directoryPath))) {
          continue
        }
        if (
          (keeperIsCanonical ||
            canonicalDirectoryNames.has(duplicate.directoryName.toLowerCase())) &&
          !hasSimilarTitle(duplicate.directoryName, keeper.directoryName)
        ) {
          continue
        }
        plannedDirectories.add(samePathKey(duplicate.directoryPath))
        actions.push({
          kind: 'duplicate-directory',
          rootPath,
          directoryPath: duplicate.directoryPath,
          duplicateOf: keeper.directoryPath,
          fileCount: duplicate.files.length,
          status: 'would-remove',
          reason: 'Directory has the same filename and size manifest as another top-level folder.',
        })
      }
    }
  }

  return actions
}

async function isDirectoryEmpty(directoryPath: string): Promise<boolean> {
  const entries = await readdir(directoryPath)
  return entries.length === 0
}

async function applyCleanupActions(
  actions: CleanupAction[],
  onProgress?: (message: string) => void
): Promise<void> {
  const removals = actions.filter((action) => action.status === 'would-remove')
  let index = 0

  for (const action of removals) {
    index += 1
    onProgress?.(`Removing ${index}/${removals.length}: ${action.directoryPath}`)
    try {
      if (action.kind === 'duplicate-directory') {
        await rm(action.directoryPath, { recursive: true, force: false })
      } else if (await isDirectoryEmpty(action.directoryPath)) {
        await rmdir(action.directoryPath)
      } else {
        action.status = 'skipped'
        action.reason = 'Directory is no longer empty.'
        continue
      }
      action.status = 'removed'
    } catch (error) {
      action.status = 'conflict'
      action.reason = error instanceof Error ? error.message : String(error)
    }
  }
}

function summarizeActions(
  actions: CleanupAction[],
  options: {
    dryRun: boolean
    rootsScanned: number
    directoriesScanned: number
    reportPath?: string
  }
): CleanupSummary {
  return {
    ...options,
    wouldRemove: actions.filter((action) => action.status === 'would-remove').length,
    removed: actions.filter((action) => action.status === 'removed').length,
    skipped: actions.filter((action) => action.status === 'skipped').length,
    conflicts: actions.filter((action) => action.status === 'conflict').length,
  }
}

export async function cleanupEmptyDirectories({
  config,
  apply = false,
  dedupe = false,
  reportPath,
  onProgress,
}: CleanupOptions): Promise<CleanupReport> {
  const roots = cleanupRoots(config)
  const actions: CleanupAction[] = []
  let directoriesScanned = 0

  for (const [index, rootPath] of roots.entries()) {
    onProgress?.(`Scanning root ${index + 1}/${roots.length}: ${rootPath}`)
    const snapshots = await collectDirectories(rootPath, onProgress)
    directoriesScanned += snapshots.length
    actions.push(...planEmptyDirectoryActions(rootPath, snapshots))
  }

  if (dedupe) {
    actions.push(...(await planDuplicateDirectoryActions(config, roots, onProgress)))
  }

  if (apply) {
    await applyCleanupActions(actions, onProgress)
  }

  const summary = summarizeActions(actions, {
    dryRun: !apply,
    rootsScanned: roots.length,
    directoriesScanned,
    reportPath,
  })
  const report: CleanupReport = {
    ...summary,
    actions,
  }

  if (reportPath) {
    const reportDirectory = path.dirname(reportPath)
    if (reportDirectory && reportDirectory !== '.') {
      await mkdir(reportDirectory, { recursive: true })
    }
    await writeFile(reportPath, `${JSON.stringify(report, undefined, 2)}\n`)
  }

  return report
}
