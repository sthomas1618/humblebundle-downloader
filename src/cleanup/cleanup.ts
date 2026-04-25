import { mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { AppConfig, ScanLibraryConfig } from '../config'
import { selectRoutedDownloadCandidates } from '../download/downloader'
import { loadMetadata, type MetadataDownload, type MetadataOrder } from '../download/metadata'
import { buildFilenameAliases, normalizeFilenameStem } from '../utils/filename'
import { buildProductFolder, cleanName, hasSimilarTitle } from '../utils/fs'

export type CleanupActionStatus =
  | 'would-remove'
  | 'removed'
  | 'would-move'
  | 'moved'
  | 'review'
  | 'skipped'
  | 'conflict'

export type CleanupAction = {
  kind: 'empty-directory' | 'duplicate-directory' | 'legacy-file' | 'legacy-directory'
  rootPath: string
  directoryPath: string
  status: CleanupActionStatus
  duplicateOf?: string
  sourcePath?: string
  destinationPath?: string
  bundleTitle?: string
  productTitle?: string
  classification?: string
  fileCount?: number
  reason?: string
}

export type CleanupSummary = {
  dryRun: boolean
  rootsScanned: number
  directoriesScanned: number
  wouldRemove: number
  removed: number
  wouldMove: number
  moved: number
  review: number
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
  legacyFolders?: boolean
  resolveConflicts?: 'prefer-canonical'
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

type LegacyDownloadMatch = {
  order: MetadataOrder
  productTitle: string
  download: MetadataDownload
  library: ScanLibraryConfig
  exact: boolean
  alias: boolean
  sizeMatched: boolean
  preserveLocalName: boolean
}

type LegacyOrderMatch = {
  order: MetadataOrder
  matchedFiles: number
  exactMatches: number
  aliasMatches: number
  sizeMatches: number
  legacyCoverage: number
  titleMatch: boolean
  score: number
  fileMatches: Map<string, LegacyDownloadMatch>
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

function libraryForRoot(config: AppConfig, rootPath: string): ScanLibraryConfig {
  return (
    config.scanLibraries.find((library) => isSamePath(library.path, rootPath)) ?? {
      name: 'library',
      path: rootPath,
      scanPaths: [rootPath],
      formatPriority: config.formatPriority,
      platformInclude: config.platformInclude,
      extInclude: config.extInclude,
      extExclude: config.extExclude,
    }
  )
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

function fileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? ''
}

function isAllCapsFolderName(name: string): boolean {
  const letters = [...name].filter((char) => /\p{Letter}/u.test(char))
  return letters.length > 0 && letters.every((char) => char === char.toUpperCase())
}

function aliasesOverlap(left: string[], right: string[]): boolean {
  const leftAliases = new Set(left)
  return right.some((alias) => leftAliases.has(alias))
}

function formatRank(filename: string, config: Pick<ScanLibraryConfig, 'formatPriority'>): number {
  const priority = config.formatPriority ?? []
  const index = priority.indexOf(fileExtension(filename))
  return index === -1 ? priority.length : index
}

function canLegacyFormatSatisfyMetadata(
  file: FileSnapshot,
  download: MetadataDownload,
  library: ScanLibraryConfig
): boolean {
  const localExtension = fileExtension(file.name)
  const metadataExtension = fileExtension(download.filename)
  if (localExtension === metadataExtension) {
    return true
  }

  const priority = library.formatPriority ?? []
  if (!priority.includes(localExtension) || !priority.includes(metadataExtension)) {
    return false
  }

  return formatRank(file.name, library) <= formatRank(download.filename, library)
}

function productTitleMatchesFile(productTitle: string, file: FileSnapshot): boolean {
  const productStem = normalizeFilenameStem(productTitle)
  const fileStem = normalizeFilenameStem(file.name)
  if (
    productStem.length >= 8 &&
    fileStem.length >= 8 &&
    (productStem.includes(fileStem) || fileStem.includes(productStem))
  ) {
    return true
  }

  const stopWords = new Set(['a', 'an', 'and', 'book', 'the', 'vol', 'volume'])
  const productTokens = productTitle
    .toLowerCase()
    .split(/[^\da-z]+/)
    .filter((token) => token.length >= 2 && !stopWords.has(token))
  const fileTokens = new Set(
    file.name
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .split(/[^\da-z]+/)
      .filter((token) => token.length >= 2 && !stopWords.has(token))
  )

  return (
    productTokens.length >= 2 &&
    productTokens.every((token) => fileTokens.has(token) || fileStem.includes(token))
  )
}

function metadataDownloadMatchesFile(
  file: FileSnapshot,
  productTitle: string,
  download: MetadataDownload,
  library: ScanLibraryConfig
):
  | {
      exact: boolean
      alias: boolean
      sizeMatched: boolean
      preserveLocalName: boolean
    }
  | undefined {
  const exact = file.name.toLowerCase() === download.filename.toLowerCase()
  const filenameAlias = aliasesOverlap(
    buildFilenameAliases(file.name),
    buildFilenameAliases(download.filename)
  )
  const productTitleAlias = productTitleMatchesFile(productTitle, file)
  const alias = exact || filenameAlias || productTitleAlias
  if (!alias) {
    return undefined
  }

  if (!canLegacyFormatSatisfyMetadata(file, download, library)) {
    return undefined
  }

  return {
    exact,
    alias: !exact,
    sizeMatched: typeof download.fileSize === 'number' && download.fileSize === file.size,
    preserveLocalName: !exact && !filenameAlias && productTitleAlias,
  }
}

function routedLibraryForDownload(
  config: AppConfig,
  rootPath: string,
  order: MetadataOrder,
  productTitle: string,
  download: MetadataDownload
): ScanLibraryConfig {
  return (
    selectRoutedDownloadCandidates(
      [
        {
          filename: download.filename,
          platform: download.platform,
          url: '',
          fileSize: download.fileSize,
          md5: download.md5,
        },
      ],
      config,
      {
        bundleTitle: order.bundleTitle,
        productTitle,
      }
    )[0]?.library ?? libraryForRoot(config, rootPath)
  )
}

function findBestFileMatch(
  config: AppConfig,
  rootPath: string,
  order: MetadataOrder,
  file: FileSnapshot
): LegacyDownloadMatch | undefined {
  const matches: LegacyDownloadMatch[] = []

  for (const product of order.products) {
    for (const download of product.downloads) {
      const library = routedLibraryForDownload(
        config,
        rootPath,
        order,
        product.productTitle,
        download
      )
      const match = metadataDownloadMatchesFile(file, product.productTitle, download, library)
      if (!match) {
        continue
      }
      matches.push({
        order,
        productTitle: product.productTitle,
        download,
        library,
        ...match,
      })
    }
  }

  return matches.sort((left, right) => {
    if (left.sizeMatched !== right.sizeMatched) {
      return left.sizeMatched ? -1 : 1
    }
    if (left.exact !== right.exact) {
      return left.exact ? -1 : 1
    }
    return left.download.filename.localeCompare(right.download.filename)
  })[0]
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

function scoreLegacyOrder(
  config: AppConfig,
  rootPath: string,
  order: MetadataOrder,
  legacyFolder: TopLevelDirectorySnapshot
): LegacyOrderMatch {
  const fileMatches = new Map<string, LegacyDownloadMatch>()
  let exactMatches = 0
  let aliasMatches = 0
  let sizeMatches = 0

  for (const file of legacyFolder.files) {
    const match = findBestFileMatch(config, rootPath, order, file)
    if (!match) {
      continue
    }
    fileMatches.set(file.path, match)
    if (match.exact) {
      exactMatches += 1
    }
    if (match.alias) {
      aliasMatches += 1
    }
    if (match.sizeMatched) {
      sizeMatches += 1
    }
  }

  const matchedFiles = fileMatches.size
  const legacyCoverage =
    legacyFolder.files.length === 0 ? 0 : matchedFiles / legacyFolder.files.length
  const titleMatch = hasSimilarTitle(legacyFolder.directoryName, order.bundleTitle)
  const score =
    matchedFiles * 100 +
    sizeMatches * 25 +
    exactMatches * 10 +
    aliasMatches * 5 +
    (titleMatch ? 3 : 0)

  return {
    order,
    matchedFiles,
    exactMatches,
    aliasMatches,
    sizeMatches,
    legacyCoverage,
    titleMatch,
    score,
    fileMatches,
  }
}

function chooseLegacyOrderMatch(
  config: AppConfig,
  rootPath: string,
  orders: MetadataOrder[],
  legacyFolder: TopLevelDirectorySnapshot
): LegacyOrderMatch | undefined | 'ambiguous' {
  const matches = orders
    .map((order) => scoreLegacyOrder(config, rootPath, order, legacyFolder))
    .filter((match) => match.matchedFiles > 0)
    .sort((left, right) => right.score - left.score)

  const best = matches[0]
  if (!best) {
    return undefined
  }

  const minimumMatches = legacyFolder.files.length === 1 ? 1 : 2
  if (best.matchedFiles < minimumMatches) {
    return undefined
  }

  if (legacyFolder.files.length === 1 && !best.sizeMatches && !best.titleMatch) {
    return undefined
  }

  const second = matches[1]
  if (
    second &&
    second.matchedFiles === best.matchedFiles &&
    second.sizeMatches === best.sizeMatches &&
    second.exactMatches === best.exactMatches
  ) {
    if (best.titleMatch && !second.titleMatch) {
      return best
    }
    return 'ambiguous'
  }

  return best
}

async function planLegacyFolderActions(
  config: AppConfig,
  roots: string[],
  resolveConflicts?: CleanupOptions['resolveConflicts'],
  onProgress?: (message: string) => void
): Promise<CleanupAction[]> {
  onProgress?.('Loading metadata for legacy folder cleanup...')
  const metadata = await loadMetadata(config.libraryPath, config.metadataPath)
  const orders = Object.values(metadata.orders)
  const actions: CleanupAction[] = []

  if (orders.length === 0) {
    return actions
  }

  for (const [index, rootPath] of roots.entries()) {
    onProgress?.(`Scanning legacy folders ${index + 1}/${roots.length}: ${rootPath}`)
    const topLevelDirectories = await collectTopLevelDirectories(rootPath, onProgress)
    const folders = topLevelDirectories.filter((folder) =>
      isAllCapsFolderName(folder.directoryName)
    )

    for (const folder of folders) {
      const match = chooseLegacyOrderMatch(config, rootPath, orders, folder)
      if (!match || match === 'ambiguous') {
        actions.push({
          kind: 'legacy-directory',
          rootPath,
          directoryPath: folder.directoryPath,
          status: 'review',
          fileCount: folder.files.length,
          classification: match === 'ambiguous' ? 'ambiguous-content-match' : 'unmatched',
          reason:
            match === 'ambiguous'
              ? 'Folder contents matched multiple metadata orders equally.'
              : 'Folder contents did not match a metadata order strongly enough.',
        })
        continue
      }

      for (const file of folder.files) {
        const fileMatch = match.fileMatches.get(file.path)
        if (!fileMatch) {
          actions.push({
            kind: 'legacy-file',
            rootPath,
            directoryPath: folder.directoryPath,
            sourcePath: file.path,
            status: 'review',
            bundleTitle: match.order.bundleTitle,
            classification: 'unmatched-file',
            reason: 'File did not match the selected metadata order by filename or alias.',
          })
          continue
        }

        const destinationPath = path.join(
          buildProductFolder(
            fileMatch.library.path,
            match.order.bundleTitle,
            fileMatch.productTitle
          ),
          fileMatch.preserveLocalName ||
            fileExtension(file.name) !== fileExtension(fileMatch.download.filename)
            ? file.name
            : fileMatch.download.filename
        )
        const action: CleanupAction = {
          kind: 'legacy-file',
          rootPath,
          directoryPath: folder.directoryPath,
          sourcePath: file.path,
          destinationPath,
          bundleTitle: match.order.bundleTitle,
          productTitle: fileMatch.productTitle,
          fileCount: 1,
          status: 'would-move',
          classification: fileMatch.exact ? 'metadata-filename' : 'metadata-alias',
        }

        if (isSamePath(file.path, destinationPath)) {
          action.status = 'skipped'
          action.reason = 'File is already in its canonical destination.'
        } else {
          try {
            const destinationStats = await stat(destinationPath)
            if (destinationStats.size === file.size) {
              action.status = 'would-remove'
              action.duplicateOf = destinationPath
              action.classification = 'covered-by-canonical-file'
              action.reason = 'Canonical destination already exists with the same file size.'
            } else if (resolveConflicts === 'prefer-canonical') {
              action.status = 'would-remove'
              action.duplicateOf = destinationPath
              action.classification = 'conflict-prefer-canonical'
              action.reason =
                'Canonical destination exists with a different file size; prefer-canonical keeps it and removes the legacy file.'
            } else {
              action.status = 'conflict'
              action.reason = 'Canonical destination exists with a different file size.'
            }
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
              action.status = 'conflict'
              action.reason = error instanceof Error ? error.message : String(error)
            }
          }
        }

        actions.push(action)
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
  const moves = actions.filter((action) => action.status === 'would-move')
  let moveIndex = 0

  for (const action of moves) {
    moveIndex += 1
    onProgress?.(`Moving ${moveIndex}/${moves.length}: ${action.sourcePath}`)
    if (!action.sourcePath || !action.destinationPath) {
      action.status = 'conflict'
      action.reason = 'Move action is missing a source or destination path.'
      continue
    }
    try {
      await mkdir(path.dirname(action.destinationPath), { recursive: true })
      await rename(action.sourcePath, action.destinationPath)
      action.status = 'moved'
    } catch (error) {
      action.status = 'conflict'
      action.reason = error instanceof Error ? error.message : String(error)
    }
  }

  const removals = actions.filter((action) => action.status === 'would-remove')
  let index = 0

  for (const action of removals) {
    index += 1
    onProgress?.(`Removing ${index}/${removals.length}: ${action.directoryPath}`)
    try {
      if (action.kind === 'legacy-file') {
        if (!action.sourcePath) {
          action.status = 'conflict'
          action.reason = 'Remove action is missing a source path.'
          continue
        }
        await rm(action.sourcePath, { force: false })
      } else if (action.kind === 'duplicate-directory') {
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
    wouldMove: actions.filter((action) => action.status === 'would-move').length,
    moved: actions.filter((action) => action.status === 'moved').length,
    review: actions.filter((action) => action.status === 'review').length,
    skipped: actions.filter((action) => action.status === 'skipped').length,
    conflicts: actions.filter((action) => action.status === 'conflict').length,
  }
}

export async function cleanupEmptyDirectories({
  config,
  apply = false,
  dedupe = false,
  legacyFolders = false,
  resolveConflicts,
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

  if (legacyFolders) {
    actions.push(...(await planLegacyFolderActions(config, roots, resolveConflicts, onProgress)))
  }

  if (apply) {
    await applyCleanupActions(actions, onProgress)

    if (legacyFolders) {
      for (const [index, rootPath] of roots.entries()) {
        onProgress?.(`Scanning post-legacy empty folders ${index + 1}/${roots.length}: ${rootPath}`)
        const snapshots = await collectDirectories(rootPath, onProgress)
        const emptyActions = planEmptyDirectoryActions(rootPath, snapshots)
        await applyCleanupActions(emptyActions, onProgress)
        actions.push(...emptyActions)
      }
    }
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
