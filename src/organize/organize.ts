import {
  access,
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'

import type { AppConfig, ConflictResolutionMode, ScanLibraryConfig } from '../config'
import { FLAT_CONFLICT_RESOLUTION_DEFAULT, markConfigLibrariesFlat } from '../config'
import {
  buildAuditCandidatePaths,
  buildLocalDirectoryIndex,
  buildFlatCacheKey,
  findAuditFile,
  getScanPaths,
  inferBundleFolder,
  selectRoutedDownloadCandidates,
  type LocalDirectoryIndex,
  type RoutedDownloadCandidate,
  type WebDownloadCandidate,
} from '../download/downloader'
import { loadCache, saveCache, upsertFlatIndexEntry, type FlatIndexEntry } from '../download/cache'
import { loadMetadata } from '../download/metadata'
import {
  buildProductFolder,
  buildLibraryProductFolder,
  cleanName,
  hasSimilarTitle,
  inferPublisherFolder,
  inferSeriesFolder,
  normalizeFlatProductKey,
  normalizePublisherFamilyKey,
  normalizeFlatPublisherKey,
} from '../utils/fs'

export type OrganizeActionStatus =
  | 'already-correct'
  | 'would-move'
  | 'moved'
  | 'would-move-supplement'
  | 'moved-supplement'
  | 'would-remove-duplicate'
  | 'removed-duplicate'
  | 'would-remove-empty-folder'
  | 'removed-empty-folder'
  | 'would-resolve-conflict'
  | 'resolved-conflict'
  | 'would-quarantine-conflict'
  | 'quarantined-conflict'
  | 'missing'
  | 'untracked'
  | 'ambiguous'
  | 'conflict'

type ConflictResolutionAction = 'remove-source' | 'replace-destination' | 'quarantine-source'

type PlannedDestinationRegistry = Map<string, OrganizeAction>

export type OrganizeAction = {
  cacheKey: string
  filename: string
  bundleTitle: string
  productTitle: string
  expectedLibraryName?: string
  expectedLibraryPath?: string
  selected: boolean
  sourcePath?: string
  destinationPath: string
  status: OrganizeActionStatus
  reason?: string
  expectedMd5?: string
  conflict?: {
    mode: ConflictResolutionMode
    action?: ConflictResolutionAction
    sourceSize?: number
    destinationSize?: number
    sourceMd5?: string
    destinationMd5?: string
    quarantinePath?: string
  }
}

export type OrganizeSummary = {
  dryRun: boolean
  ordersProcessed: number
  productsProcessed: number
  selectedCandidates: number
  alreadyCorrect: number
  wouldMove: number
  moved: number
  wouldMoveSupplement: number
  movedSupplement: number
  wouldRemoveDuplicate: number
  removedDuplicate: number
  wouldRemoveEmptyFolder: number
  removedEmptyFolder: number
  wouldResolveConflict: number
  resolvedConflict: number
  wouldQuarantineConflict: number
  quarantinedConflict: number
  missing: number
  untracked: number
  ambiguous: number
  conflicts: number
  reportPath?: string
}

export type OrganizeReport = OrganizeSummary & {
  actions: OrganizeAction[]
}

export type OrganizeOptions = {
  config: AppConfig
  apply?: boolean
  canonical?: boolean
  flat?: boolean
  resolveConflicts?: ConflictResolutionMode
  conflictDir?: string
  reportPath?: string
  onProgress?: (message: string) => void
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function samePathExact(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

function getExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? ''
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = path.relative(parent, candidate)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function topLevelDirectoryName(rootPath: string, candidatePath: string): string | undefined {
  const relativePath = path.relative(rootPath, candidatePath)
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined
  }
  return relativePath.split(path.sep)[0]
}

function isHumbleBundleFolder(folderName: string | undefined): boolean {
  return folderName?.toLowerCase().startsWith('humble ') ?? false
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function renamePathCasing(sourcePath: string, destinationPath: string): Promise<void> {
  const source = path.resolve(sourcePath)
  const destination = path.resolve(destinationPath)
  const sourceParsed = path.parse(source)
  const destinationParsed = path.parse(destination)
  const sourceParts = path.relative(sourceParsed.root, source).split(path.sep)
  const destinationParts = path.relative(destinationParsed.root, destination).split(path.sep)
  let currentPath = sourceParsed.root

  for (const [index, sourcePart] of sourceParts.entries()) {
    const destinationPart = destinationParts[index]
    if (!destinationPart) {
      return
    }

    if (sourcePart.toLowerCase() !== destinationPart.toLowerCase()) {
      return
    }

    if (sourcePart !== destinationPart) {
      const oldPath = path.join(currentPath, sourcePart)
      const temporaryPath = path.join(
        currentPath,
        `.hbd-case-rename-${process.pid}-${Date.now()}-${index}-${sourcePart}`
      )
      const newPath = path.join(currentPath, destinationPart)
      await rename(oldPath, temporaryPath)
      await rename(temporaryPath, newPath)
    }

    currentPath = path.join(currentPath, destinationPart)
  }
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  if (samePath(sourcePath, destinationPath) && !samePathExact(sourcePath, destinationPath)) {
    await renamePathCasing(sourcePath, destinationPath)
    return
  }
  await mkdir(path.dirname(destinationPath), { recursive: true })
  try {
    await rename(sourcePath, destinationPath)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      await copyFile(sourcePath, destinationPath)
      await rm(sourcePath, { force: true })
      return
    }
    throw error
  }
}

async function sameFileSize(left: string, right: string): Promise<boolean> {
  const [leftStats, rightStats] = await Promise.all([stat(left), stat(right)])
  return leftStats.size === rightStats.size
}

async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    const stats = await stat(filePath)
    return stats.size
  } catch {
    return undefined
  }
}

async function fileMd5(filePath: string): Promise<string | undefined> {
  try {
    const hash = createHash('md5')
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', resolve)
    })
    return hash.digest('hex')
  } catch {
    return undefined
  }
}

function isMetadataBundleFolder(
  folderName: string | undefined,
  bundleTitle: string,
  allBundleTitles: string[]
): boolean {
  if (!folderName) {
    return false
  }
  if (cleanName(folderName).toLowerCase() === cleanName(bundleTitle).toLowerCase()) {
    return true
  }
  const matches = allBundleTitles.filter((title) => hasSimilarTitle(folderName, title))
  return matches.length === 1 && matches[0] === bundleTitle
}

function isLegacyBundleSource(
  libraryPath: string,
  sourcePath: string,
  bundleTitle: string,
  allBundleTitles: string[]
): boolean {
  return isMetadataBundleFolder(
    topLevelDirectoryName(libraryPath, sourcePath),
    bundleTitle,
    allBundleTitles
  )
}

function getConflictQuarantinePath({
  conflictDir,
  action,
}: {
  conflictDir?: string
  action: OrganizeAction
}): string | undefined {
  if (!conflictDir || !action.sourcePath) {
    return undefined
  }
  const libraryName = cleanName(action.expectedLibraryName ?? 'library') || 'library'
  const sourceRoot = action.expectedLibraryPath ?? path.parse(action.sourcePath).root
  const relativeSource = isPathInside(sourceRoot, action.sourcePath)
    ? path.relative(sourceRoot, action.sourcePath)
    : path.basename(action.sourcePath)
  return path.join(conflictDir, libraryName, relativeSource)
}

async function resolveConflictByMd5s(
  action: OrganizeAction,
  mode: ConflictResolutionMode,
  md5s: Set<string>
): Promise<boolean> {
  if (!action.sourcePath || md5s.size === 0) {
    return false
  }
  const [sourceMd5, destinationMd5] = await Promise.all([
    fileMd5(action.sourcePath),
    fileMd5(action.destinationPath),
  ])
  action.conflict ??= { mode }
  action.conflict.sourceMd5 = sourceMd5
  action.conflict.destinationMd5 = destinationMd5
  const sourceMatches = sourceMd5 ? md5s.has(sourceMd5) : false
  const destinationMatches = destinationMd5 ? md5s.has(destinationMd5) : false
  if (sourceMatches === destinationMatches) {
    return false
  }
  action.conflict.action = sourceMatches ? 'replace-destination' : 'remove-source'
  return true
}

async function applyConflictResolution({
  action,
  mode,
  conflictDir,
  orders,
}: {
  action: OrganizeAction
  mode: ConflictResolutionMode
  conflictDir?: string
  orders?: MetadataOrder[]
}): Promise<void> {
  action.conflict = {
    mode,
    sourceSize: action.sourcePath ? await fileSize(action.sourcePath) : undefined,
    destinationSize: await fileSize(action.destinationPath),
  }

  if (mode === 'report' || !action.sourcePath) {
    action.status = 'conflict'
    action.reason ??= 'Conflict resolution is report-only.'
    return
  }

  if (mode === 'prefer-md5-match') {
    if (!action.expectedMd5) {
      action.status = 'conflict'
      action.reason = 'Conflict cannot be resolved because metadata md5 is unavailable.'
      return
    }
    if (!(await resolveConflictByMd5s(action, mode, new Set([action.expectedMd5])))) {
      action.status = 'conflict'
      action.reason = 'Conflict md5 resolution was ambiguous.'
      return
    }
  }

  if (mode === 'prefer-known-md5' || mode === 'prefer-known-md5-then-largest') {
    const knownMd5s = collectKnownConflictMd5s(action, orders ?? [])
    if (!(await resolveConflictByMd5s(action, mode, knownMd5s)) && mode === 'prefer-known-md5') {
      action.status = 'conflict'
      action.reason =
        knownMd5s.size === 0
          ? 'Conflict cannot be resolved because no matching metadata md5 is available.'
          : 'Conflict known-md5 resolution was ambiguous.'
      return
    }
  }

  if (
    mode === 'prefer-largest' ||
    (mode === 'prefer-known-md5-then-largest' && !action.conflict.action)
  ) {
    const sourceSize = action.conflict.sourceSize
    const destinationSize = action.conflict.destinationSize
    if (sourceSize === undefined || destinationSize === undefined) {
      action.status = 'conflict'
      action.reason = 'Conflict cannot be resolved because file size is unavailable.'
      return
    }
    action.conflict.action = sourceSize > destinationSize ? 'replace-destination' : 'remove-source'
  }

  if (mode === 'prefer-flat') {
    action.conflict.action = 'remove-source'
  }

  if (conflictDir && action.conflict.action === 'remove-source') {
    action.conflict.action = 'quarantine-source'
    action.conflict.quarantinePath = getConflictQuarantinePath({ conflictDir, action })
    action.status = 'would-quarantine-conflict'
    action.reason = 'Conflict source will be moved to the conflict directory.'
    return
  }

  action.status = 'would-resolve-conflict'
  action.reason =
    action.conflict.action === 'replace-destination'
      ? 'Conflict will be resolved by replacing the flat destination.'
      : 'Conflict will be resolved by removing the legacy source.'
}

async function markPlannedCollisionLoser({
  loser,
  loserSize,
  winnerSize,
  loserMd5,
  winnerMd5,
  mode,
  conflictDir,
  reason,
}: {
  loser: OrganizeAction
  loserSize?: number
  winnerSize?: number
  loserMd5?: string
  winnerMd5?: string
  mode: ConflictResolutionMode
  conflictDir?: string
  reason: string
}): Promise<void> {
  loser.conflict = {
    mode,
    action: 'remove-source',
    sourceSize: loserSize,
    destinationSize: winnerSize,
    sourceMd5: loserMd5,
    destinationMd5: winnerMd5,
  }
  loser.reason = reason
  if (conflictDir) {
    loser.conflict.action = 'quarantine-source'
    loser.conflict.quarantinePath = getConflictQuarantinePath({ conflictDir, action: loser })
    loser.status = 'would-quarantine-conflict'
    return
  }
  loser.status = 'would-resolve-conflict'
}

async function resolvePlannedDestinationCollision({
  action,
  existingAction,
  plannedDestinations,
  plannedDestinationRegistry,
  mode,
  conflictDir,
  orders,
}: {
  action: OrganizeAction
  existingAction: OrganizeAction
  plannedDestinations: Set<string>
  plannedDestinationRegistry: PlannedDestinationRegistry
  mode: ConflictResolutionMode
  conflictDir?: string
  orders: MetadataOrder[]
}): Promise<void> {
  const normalizedDestination = path.resolve(action.destinationPath).toLowerCase()
  const [sourceSize, existingSize] = await Promise.all([
    action.sourcePath ? fileSize(action.sourcePath) : undefined,
    existingAction.sourcePath ? fileSize(existingAction.sourcePath) : undefined,
  ])

  if (sourceSize !== undefined && existingSize !== undefined && sourceSize === existingSize) {
    action.status = 'would-remove-duplicate'
    action.reason = 'Flat destination is already planned by an equivalent same-size source.'
    return
  }

  action.conflict = {
    mode,
    sourceSize,
    destinationSize: existingSize,
  }
  if (mode === 'report') {
    action.status = 'conflict'
    action.reason = 'Multiple leftover files map to the same flat destination with different sizes.'
    return
  }

  const [sourceMd5, existingMd5] = await Promise.all([
    action.sourcePath ? fileMd5(action.sourcePath) : undefined,
    existingAction.sourcePath ? fileMd5(existingAction.sourcePath) : undefined,
  ])
  action.conflict.sourceMd5 = sourceMd5
  action.conflict.destinationMd5 = existingMd5

  let winner: OrganizeAction | undefined
  let reason = 'Planned flat destination collision will be resolved by the configured mode.'

  if (mode === 'prefer-md5-match') {
    const expectedMd5s = new Set(
      [action.expectedMd5, existingAction.expectedMd5].filter(
        (md5): md5 is string => md5 !== undefined
      )
    )
    const sourceMatches = sourceMd5 ? expectedMd5s.has(sourceMd5) : false
    const existingMatches = existingMd5 ? expectedMd5s.has(existingMd5) : false
    if (sourceMatches === existingMatches) {
      action.status = 'conflict'
      action.reason =
        expectedMd5s.size === 0
          ? 'Planned destination collision cannot be resolved because metadata md5 is unavailable.'
          : 'Planned destination collision md5 resolution was ambiguous.'
      return
    }
    winner = sourceMatches ? action : existingAction
    reason = 'Planned flat destination collision will keep the exact metadata md5 match.'
  }

  if (mode === 'prefer-known-md5' || mode === 'prefer-known-md5-then-largest') {
    const knownMd5s = new Set([
      ...collectKnownConflictMd5s(action, orders),
      ...collectKnownConflictMd5s(existingAction, orders),
    ])
    const sourceMatches = sourceMd5 ? knownMd5s.has(sourceMd5) : false
    const existingMatches = existingMd5 ? knownMd5s.has(existingMd5) : false
    if (sourceMatches !== existingMatches) {
      winner = sourceMatches ? action : existingAction
      reason = 'Planned flat destination collision will keep the known metadata md5 match.'
    } else if (mode === 'prefer-known-md5') {
      action.status = 'conflict'
      action.reason =
        knownMd5s.size === 0
          ? 'Planned destination collision cannot be resolved because no matching metadata md5 is available.'
          : 'Planned destination collision known-md5 resolution was ambiguous.'
      return
    }
  }

  if (!winner && (mode === 'prefer-largest' || mode === 'prefer-known-md5-then-largest')) {
    if (sourceSize === undefined || existingSize === undefined) {
      action.status = 'conflict'
      action.reason =
        'Planned destination collision cannot be resolved because file size is unavailable.'
      return
    }
    winner = sourceSize > existingSize ? action : existingAction
    reason = 'Planned flat destination collision will keep the largest source file.'
  }

  if (!winner && mode === 'prefer-flat') {
    winner = existingAction
    reason = 'Planned flat destination collision will keep the first planned flat source.'
  }

  if (!winner) {
    action.status = 'conflict'
    action.reason = 'Planned destination collision could not be resolved by the configured mode.'
    return
  }

  const loser = winner === action ? existingAction : action
  await markPlannedCollisionLoser({
    loser,
    loserSize: loser === action ? sourceSize : existingSize,
    winnerSize: winner === action ? sourceSize : existingSize,
    loserMd5: loser === action ? sourceMd5 : existingMd5,
    winnerMd5: winner === action ? sourceMd5 : existingMd5,
    mode,
    conflictDir,
    reason,
  })

  if (winner === action) {
    action.status = 'would-move-supplement'
    action.reason = 'Single-level flat leftover file won a planned destination collision.'
    plannedDestinations.add(normalizedDestination)
    plannedDestinationRegistry.set(normalizedDestination, action)
  }
}

async function findLegacyBundleDuplicateSource(
  candidatePaths: string[],
  destinationPath: string,
  libraryPath: string,
  bundleTitle: string,
  allBundleTitles: string[]
): Promise<string | undefined> {
  if (!(await pathExists(destinationPath))) {
    return undefined
  }
  const normalizedDestination = path.resolve(destinationPath).toLowerCase()
  for (const candidatePath of candidatePaths) {
    if (path.resolve(candidatePath).toLowerCase() === normalizedDestination) {
      continue
    }
    if (
      !isLegacyBundleSource(libraryPath, candidatePath, bundleTitle, allBundleTitles) ||
      !(await pathExists(candidatePath))
    ) {
      continue
    }
    if (await sameFileSize(candidatePath, destinationPath)) {
      return candidatePath
    }
  }
  return undefined
}

async function findFlatPublisherAliasDuplicateSource(
  candidatePaths: string[],
  destinationPath: string,
  config: AppConfig
): Promise<string | undefined> {
  if (!(await pathExists(destinationPath))) {
    return undefined
  }
  const normalizedDestination = path.resolve(destinationPath).toLowerCase()
  for (const candidatePath of candidatePaths) {
    if (path.resolve(candidatePath).toLowerCase() === normalizedDestination) {
      continue
    }
    if (
      !isFlatPublisherFamilyAliasSource(config, candidatePath, destinationPath) ||
      !(await pathExists(candidatePath))
    ) {
      continue
    }
    if (await sameFileSize(candidatePath, destinationPath)) {
      return candidatePath
    }
  }
  return undefined
}

async function pruneEmptyParents(startPath: string, stopPath: string): Promise<void> {
  let currentPath = path.dirname(startPath)
  const stop = path.resolve(stopPath).toLowerCase()

  while (path.resolve(currentPath).toLowerCase().startsWith(stop)) {
    if (path.resolve(currentPath).toLowerCase() === stop) {
      return
    }
    try {
      await rmdir(currentPath)
    } catch {
      return
    }
    currentPath = path.dirname(currentPath)
  }
}

function summarizeActions(
  actions: OrganizeAction[],
  options: {
    dryRun: boolean
    ordersProcessed: number
    productsProcessed: number
    selectedCandidates: number
    reportPath?: string
  }
): OrganizeSummary {
  return {
    ...options,
    alreadyCorrect: actions.filter((action) => action.status === 'already-correct').length,
    wouldMove: actions.filter((action) => action.status === 'would-move').length,
    moved: actions.filter((action) => action.status === 'moved').length,
    wouldMoveSupplement: actions.filter((action) => action.status === 'would-move-supplement')
      .length,
    movedSupplement: actions.filter((action) => action.status === 'moved-supplement').length,
    wouldRemoveDuplicate: actions.filter((action) => action.status === 'would-remove-duplicate')
      .length,
    removedDuplicate: actions.filter((action) => action.status === 'removed-duplicate').length,
    wouldRemoveEmptyFolder: actions.filter(
      (action) => action.status === 'would-remove-empty-folder'
    ).length,
    removedEmptyFolder: actions.filter((action) => action.status === 'removed-empty-folder').length,
    wouldResolveConflict: actions.filter((action) => action.status === 'would-resolve-conflict')
      .length,
    resolvedConflict: actions.filter((action) => action.status === 'resolved-conflict').length,
    wouldQuarantineConflict: actions.filter(
      (action) => action.status === 'would-quarantine-conflict'
    ).length,
    quarantinedConflict: actions.filter((action) => action.status === 'quarantined-conflict')
      .length,
    missing: actions.filter((action) => action.status === 'missing').length,
    untracked: actions.filter((action) => action.status === 'untracked').length,
    ambiguous: actions.filter((action) => action.status === 'ambiguous').length,
    conflicts: actions.filter((action) => action.status === 'conflict').length,
  }
}

function metadataCandidate(download: {
  filename: string
  platform: string
  fileSize?: number
  md5?: string
}): WebDownloadCandidate {
  return {
    filename: download.filename,
    platform: download.platform,
    url: '',
    fileSize: download.fileSize,
    md5: download.md5,
  }
}

function buildPublisherFoldersByProduct(
  orders: Array<{ bundleTitle: string; products: Array<{ productTitle: string }> }>
): Map<string, string> {
  const publisherVariantsByFamily = new Map<
    string,
    Map<string, { folder: string; count: number }>
  >()
  const inferredPublishersByOrder = new Map<string, { familyKey: string; folder: string }>()

  for (const order of orders) {
    const publisherFolder = inferPublisherFolder(order.bundleTitle)
    const familyKey = normalizePublisherFamilyKey(publisherFolder)
    const variants = publisherVariantsByFamily.get(familyKey) ?? new Map()
    const variantKey = normalizeFlatPublisherKey(publisherFolder)
    const current = variants.get(variantKey) ?? { folder: publisherFolder, count: 0 }
    current.count += 1
    variants.set(variantKey, current)
    publisherVariantsByFamily.set(familyKey, variants)
    inferredPublishersByOrder.set(order.bundleTitle, { familyKey, folder: publisherFolder })
  }

  const canonicalPublisherByFamily = new Map<string, string>()
  for (const [familyKey, variants] of publisherVariantsByFamily) {
    const ranked = [...variants.values()].sort((left, right) => {
      if (variants.size > 1) {
        const lengthDifference = left.folder.length - right.folder.length
        if (lengthDifference !== 0) {
          return lengthDifference
        }
      }
      const countDifference = right.count - left.count
      if (countDifference !== 0) {
        return countDifference
      }
      return left.folder.localeCompare(right.folder)
    })
    canonicalPublisherByFamily.set(familyKey, ranked[0]?.folder ?? 'humble')
  }

  const publishersByProduct = new Map<string, Map<string, { folder: string; count: number }>>()

  for (const order of orders) {
    const inferredPublisher = inferredPublishersByOrder.get(order.bundleTitle)
    const publisherKey = inferredPublisher?.familyKey ?? normalizeFlatPublisherKey('humble')
    const publisherFolder =
      (inferredPublisher && canonicalPublisherByFamily.get(inferredPublisher.familyKey)) ?? 'humble'
    for (const product of order.products) {
      const productKey = normalizeFlatProductKey(product.productTitle)
      if (!productKey) {
        continue
      }
      const publishers = publishersByProduct.get(productKey) ?? new Map()
      const current = publishers.get(publisherKey) ?? { folder: publisherFolder, count: 0 }
      current.count += 1
      publishers.set(publisherKey, current)
      publishersByProduct.set(productKey, publishers)
    }
  }

  const selectedPublishers = new Map<string, string>()
  for (const [productKey, publishers] of publishersByProduct) {
    const ranked = [...publishers.entries()]
      .filter(([publisherKey]) => publisherKey !== 'humble')
      .sort((left, right) => right[1].count - left[1].count)
    selectedPublishers.set(productKey, ranked[0]?.[1].folder ?? 'humble')
  }

  return selectedPublishers
}

function flatPlannedFileKey(
  routedCandidate: RoutedDownloadCandidate,
  productTitle: string,
  filename: string
): string {
  return [
    routedCandidate.library.name ?? path.resolve(routedCandidate.library.path).toLowerCase(),
    normalizeFlatProductKey(productTitle),
    filename.toLowerCase(),
  ].join('\0')
}

function shouldReserveFlatPlannedFile(action: OrganizeAction): boolean {
  return action.status !== 'missing' && action.status !== 'conflict'
}

async function findExistingFlatSeriesFolder(
  libraryPath: string,
  publisherFolder: string,
  productTitle: string
): Promise<string | undefined> {
  const publisherPath = path.join(libraryPath, publisherFolder)
  const seriesKey = normalizeFlatPublisherKey(inferSeriesFolder(productTitle))
  try {
    const entries = await readdir(publisherPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .find((entryName) => normalizeFlatPublisherKey(entryName) === seriesKey)
  } catch {
    return undefined
  }
}

function getFlatSeriesFolderFromSource(
  libraryPath: string,
  publisherFolder: string,
  productTitle: string,
  sourcePath: string
): string | undefined {
  const publisherPath = path.join(libraryPath, publisherFolder)
  const relativePath = path.relative(publisherPath, sourcePath)
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined
  }
  const [seriesFolder] = relativePath.split(path.sep)
  if (!seriesFolder) {
    return undefined
  }
  return normalizeFlatPublisherKey(seriesFolder) ===
    normalizeFlatPublisherKey(inferSeriesFolder(productTitle))
    ? seriesFolder
    : undefined
}

async function planOrganizeAction({
  cacheKey,
  routedCandidate,
  bundleTitle,
  productTitle,
  selected,
  trackMissing,
  requireSameExtension,
  scanPaths,
  inferredBundleFolder,
  config,
  localDirectoryIndex,
  canonical,
  flat,
  publisherFolder,
  orders,
  allBundleTitles,
  resolveConflicts,
  conflictDir,
  plannedMovesBySource,
  plannedDestinations,
}: {
  cacheKey: string
  routedCandidate: RoutedDownloadCandidate
  bundleTitle: string
  productTitle: string
  selected: boolean
  trackMissing: boolean
  requireSameExtension: boolean
  scanPaths: string[]
  inferredBundleFolder?: LocalDirectoryIndex['topLevelDirectories'][number]
  config: AppConfig
  localDirectoryIndex: LocalDirectoryIndex
  canonical: boolean
  flat: boolean
  publisherFolder?: string
  orders: MetadataOrder[]
  allBundleTitles: string[]
  resolveConflicts: ConflictResolutionMode
  conflictDir?: string
  plannedMovesBySource: Map<string, string>
  plannedDestinations: Set<string>
}): Promise<OrganizeAction | undefined> {
  const { candidate, library } = routedCandidate
  const destinationLibrary = flat ? { ...library, layout: 'flat' as const } : library
  const auditCandidatePaths = await buildAuditCandidatePaths(
    scanPaths,
    bundleTitle,
    productTitle,
    inferredBundleFolder?.path,
    candidate.filename
  )
  const sourcePath = await findAuditFile(
    auditCandidatePaths,
    candidate.filename,
    config,
    localDirectoryIndex,
    inferredBundleFolder,
    routedCandidate.routing.fallback ? undefined : library,
    { allowEquivalentFormats: !requireSameExtension, allowGlobalAliasMatches: canonical }
  )

  if (
    requireSameExtension &&
    sourcePath &&
    getExtension(path.basename(sourcePath)) !== getExtension(candidate.filename)
  ) {
    return undefined
  }

  const sourceFilename = sourcePath ? path.basename(sourcePath) : undefined
  const stableSeriesFolder =
    flat && publisherFolder
      ? (sourcePath &&
          getFlatSeriesFolderFromSource(library.path, publisherFolder, productTitle, sourcePath)) ||
        (await findExistingFlatSeriesFolder(library.path, publisherFolder, productTitle))
      : undefined
  const productFolder = buildLibraryProductFolder(
    destinationLibrary,
    bundleTitle,
    productTitle,
    publisherFolder,
    stableSeriesFolder
  )
  const destinationFilename =
    (canonical || flat) &&
    sourceFilename &&
    !requireSameExtension &&
    sourceFilename.toLowerCase() !== candidate.filename.toLowerCase()
      ? sourceFilename
      : candidate.filename
  const destinationPath = path.join(productFolder, destinationFilename)

  const action: OrganizeAction = {
    cacheKey,
    filename: destinationFilename,
    bundleTitle,
    productTitle,
    expectedLibraryName: library.name,
    expectedLibraryPath: library.path,
    selected,
    sourcePath,
    destinationPath,
    expectedMd5: candidate.md5,
    status: 'missing',
  }

  if (!sourcePath) {
    if (!trackMissing) {
      return undefined
    }
    action.reason = 'Selected file was not found in configured scan roots.'
    return action
  }

  const normalizedSource = path.resolve(sourcePath).toLowerCase()
  const normalizedDestination = path.resolve(destinationPath).toLowerCase()
  const legacyDuplicateSource =
    flat && (await pathExists(destinationPath))
      ? await findLegacyBundleDuplicateSource(
          auditCandidatePaths,
          destinationPath,
          library.path,
          bundleTitle,
          allBundleTitles
        )
      : undefined
  const publisherAliasDuplicateSource =
    flat && !legacyDuplicateSource && (await pathExists(destinationPath))
      ? await findFlatPublisherAliasDuplicateSource(auditCandidatePaths, destinationPath, config)
      : undefined
  const duplicateSource = legacyDuplicateSource ?? publisherAliasDuplicateSource
  if (duplicateSource) {
    action.sourcePath = duplicateSource
    if (!(await sameFileSize(duplicateSource, destinationPath))) {
      action.reason = 'Flat destination exists but differs in file size.'
      await applyConflictResolution({ action, mode: resolveConflicts, conflictDir, orders })
      return action
    }
    action.status = 'would-remove-duplicate'
    action.reason = 'Flat destination already satisfies this duplicate source.'
    plannedDestinations.add(normalizedDestination)
    return action
  }
  if (flat && normalizedSource !== normalizedDestination && (await pathExists(destinationPath))) {
    if (
      isLegacyBundleSource(library.path, sourcePath, bundleTitle, allBundleTitles) ||
      isFlatPublisherFamilyAliasSource(config, sourcePath, destinationPath)
    ) {
      if (!(await sameFileSize(sourcePath, destinationPath))) {
        action.reason = 'Flat destination exists but differs in file size.'
        await applyConflictResolution({ action, mode: resolveConflicts, conflictDir, orders })
        return action
      }
      action.status = 'would-remove-duplicate'
      action.reason = 'Flat destination already satisfies this duplicate source.'
    } else {
      action.status = 'already-correct'
      action.reason = 'Flat destination already satisfies this file.'
    }
    plannedDestinations.add(normalizedDestination)
    return action
  }
  const plannedDestinationForSource = plannedMovesBySource.get(normalizedSource)
  if (plannedDestinationForSource === normalizedDestination) {
    return undefined
  }
  if (plannedDestinationForSource) {
    if (flat) {
      action.destinationPath = sourcePath
      action.status = 'already-correct'
      action.reason = 'Flat source already satisfies another duplicate candidate.'
      return action
    }
    action.status = 'conflict'
    action.reason = 'Source file is already planned for another candidate.'
    return action
  }
  if (normalizedSource === normalizedDestination && samePathExact(sourcePath, destinationPath)) {
    action.status = 'already-correct'
    plannedMovesBySource.set(normalizedSource, normalizedDestination)
    plannedDestinations.add(normalizedDestination)
    return action
  }
  if (canonical) {
    const sourceTopLevel = topLevelDirectoryName(library.path, sourcePath)
    const destinationTopLevel = topLevelDirectoryName(library.path, destinationPath)
    if (
      sourceTopLevel &&
      destinationTopLevel &&
      sourceTopLevel.toLowerCase() !== destinationTopLevel.toLowerCase() &&
      isHumbleBundleFolder(sourceTopLevel) &&
      isHumbleBundleFolder(destinationTopLevel)
    ) {
      action.status = 'conflict'
      action.reason = 'Source file is already inside another canonical Humble bundle folder.'
      return action
    }
  }
  if (!canonical && !flat && isPathInside(path.resolve(library.path), path.resolve(sourcePath))) {
    action.status = 'already-correct'
    action.reason = 'File is already inside the routed library.'
    return action
  }
  if (getExtension(path.basename(sourcePath)) !== getExtension(destinationFilename)) {
    action.status = 'conflict'
    action.reason =
      'Matched local file uses a different extension; organize will not rename formats.'
    return action
  }
  if (plannedDestinations.has(normalizedDestination)) {
    if (flat) {
      action.status = 'already-correct'
      action.reason = 'Flat destination is already planned by another duplicate candidate.'
      return action
    }
    action.status = 'conflict'
    action.reason = 'Destination file is already planned for another candidate.'
    return action
  }
  if (normalizedSource !== normalizedDestination && (await pathExists(destinationPath))) {
    action.status = 'conflict'
    action.reason = 'Destination file already exists.'
    return action
  }

  action.status = 'would-move'
  plannedMovesBySource.set(normalizedSource, normalizedDestination)
  plannedDestinations.add(normalizedDestination)
  return action
}

async function applyOrganizeActions(
  actions: OrganizeAction[],
  onProgress?: (message: string) => void
): Promise<void> {
  const moves = actions.filter(
    (action) => action.status === 'would-move' || action.status === 'would-move-supplement'
  )
  const duplicateRemovals = actions.filter((action) => action.status === 'would-remove-duplicate')
  const emptyFolderRemovals = actions.filter(
    (action) => action.status === 'would-remove-empty-folder'
  )
  const conflictResolutions = actions.filter(
    (action) =>
      action.status === 'would-resolve-conflict' || action.status === 'would-quarantine-conflict'
  )
  let index = 0
  for (const action of moves) {
    const finalStatus = action.status === 'would-move-supplement' ? 'moved-supplement' : 'moved'
    index += 1
    if (!action.sourcePath) {
      action.status = 'conflict'
      action.reason = 'Move action is missing a source path.'
      continue
    }
    onProgress?.(`Moving ${index}/${moves.length}: ${action.filename}`)
    if (!(await pathExists(action.sourcePath))) {
      action.status = 'conflict'
      action.reason = 'Source file is missing.'
      continue
    }
    if (
      (await pathExists(action.destinationPath)) &&
      !samePath(action.sourcePath, action.destinationPath)
    ) {
      action.status = 'conflict'
      action.reason = 'Destination file already exists.'
      continue
    }
    try {
      await moveFile(action.sourcePath, action.destinationPath)
      await pruneEmptyParents(
        action.sourcePath,
        action.expectedLibraryPath ?? path.dirname(action.sourcePath)
      )
      action.status = finalStatus
    } catch (error) {
      action.status = 'conflict'
      action.reason = error instanceof Error ? error.message : String(error)
    }
  }

  index = 0
  for (const action of duplicateRemovals) {
    index += 1
    if (!action.sourcePath) {
      action.status = 'conflict'
      action.reason = 'Duplicate removal is missing a source path.'
      continue
    }
    onProgress?.(`Removing duplicate ${index}/${duplicateRemovals.length}: ${action.filename}`)
    if (!(await pathExists(action.sourcePath))) {
      action.status = 'removed-duplicate'
      continue
    }
    if (!(await pathExists(action.destinationPath))) {
      action.status = 'conflict'
      action.reason = 'Flat destination is missing.'
      continue
    }
    try {
      if (!(await sameFileSize(action.sourcePath, action.destinationPath))) {
        action.status = 'conflict'
        action.reason = 'Flat destination exists but differs in file size.'
        continue
      }
      await rm(action.sourcePath, { force: true })
      await pruneEmptyParents(
        action.sourcePath,
        action.expectedLibraryPath ?? path.dirname(action.sourcePath)
      )
      action.status = 'removed-duplicate'
    } catch (error) {
      action.status = 'conflict'
      action.reason = error instanceof Error ? error.message : String(error)
    }
  }

  index = 0
  for (const action of conflictResolutions) {
    index += 1
    if (!action.sourcePath || !action.conflict?.action) {
      action.status = 'conflict'
      action.reason = 'Conflict resolution action is incomplete.'
      continue
    }
    onProgress?.(`Resolving conflict ${index}/${conflictResolutions.length}: ${action.filename}`)
    try {
      if (action.conflict.action === 'quarantine-source') {
        if (!action.conflict.quarantinePath) {
          action.status = 'conflict'
          action.reason = 'Conflict quarantine path is missing.'
          continue
        }
        if (await pathExists(action.conflict.quarantinePath)) {
          action.status = 'conflict'
          action.reason = 'Conflict quarantine destination already exists.'
          continue
        }
        await moveFile(action.sourcePath, action.conflict.quarantinePath)
        await pruneEmptyParents(
          action.sourcePath,
          action.expectedLibraryPath ?? path.dirname(action.sourcePath)
        )
        action.status = 'quarantined-conflict'
        continue
      }

      if (action.conflict.action === 'replace-destination') {
        await rm(action.destinationPath, { force: true })
        await moveFile(action.sourcePath, action.destinationPath)
      } else {
        await rm(action.sourcePath, { force: true })
      }
      await pruneEmptyParents(
        action.sourcePath,
        action.expectedLibraryPath ?? path.dirname(action.sourcePath)
      )
      action.status = 'resolved-conflict'
    } catch (error) {
      action.status = 'conflict'
      action.reason = error instanceof Error ? error.message : String(error)
    }
  }

  index = 0
  for (const action of emptyFolderRemovals) {
    index += 1
    if (!action.sourcePath) {
      action.status = 'conflict'
      action.reason = 'Empty folder removal is missing a path.'
      continue
    }
    onProgress?.(`Removing empty folder ${index}/${emptyFolderRemovals.length}: ${action.filename}`)
    try {
      await rmdir(action.sourcePath)
      action.status = 'removed-empty-folder'
    } catch (error) {
      action.status = 'conflict'
      action.reason = error instanceof Error ? error.message : String(error)
    }
  }
}

function getOrderIdFromCacheKey(cacheKey: string): string | undefined {
  const separatorIndex = cacheKey.indexOf(':')
  return separatorIndex === -1 ? undefined : cacheKey.slice(0, separatorIndex)
}

function getFlatPathParts(
  libraryPath: string,
  canonicalPath: string,
  bundleTitle: string,
  productTitle: string
): { publisher: string; series: string } {
  const relativePath = path.relative(libraryPath, canonicalPath)
  if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    const [publisher, series] = relativePath.split(path.sep)
    if (publisher && series) {
      return { publisher, series }
    }
  }
  return {
    publisher: inferPublisherFolder(bundleTitle),
    series: inferSeriesFolder(productTitle),
  }
}

function getConfiguredFlatPublisherForPath(
  config: AppConfig,
  filePath: string
): { library: ScanLibraryConfig; publisherFolder: string } | undefined {
  for (const library of config.scanLibraries) {
    const publisherFolder = topLevelDirectoryName(library.path, filePath)
    if (!publisherFolder || publisherFolder.toLowerCase() === 'humble') {
      continue
    }
    if (isHumbleBundleFolder(publisherFolder)) {
      continue
    }
    return { library, publisherFolder }
  }
  return undefined
}

function isFlatPublisherFamilyAliasSource(
  config: AppConfig,
  sourcePath: string,
  destinationPath: string
): boolean {
  const source = getConfiguredFlatPublisherForPath(config, sourcePath)
  const destination = getConfiguredFlatPublisherForPath(config, destinationPath)
  if (!source || !destination) {
    return false
  }
  if (
    samePath(source.library.path, destination.library.path) &&
    source.publisherFolder.toLowerCase() === destination.publisherFolder.toLowerCase()
  ) {
    return false
  }
  return (
    normalizePublisherFamilyKey(source.publisherFolder) ===
    normalizePublisherFamilyKey(destination.publisherFolder)
  )
}

type MetadataOrder = Awaited<ReturnType<typeof loadMetadata>>['orders'][string]
type MetadataProduct = MetadataOrder['products'][number]

function filenameStem(filename: string): string {
  return path.basename(filename, path.extname(filename)).toLowerCase()
}

function collectKnownConflictMd5s(action: OrganizeAction, orders: MetadataOrder[]): Set<string> {
  const md5s = new Set<string>()
  if (action.expectedMd5) {
    md5s.add(action.expectedMd5)
  }
  const productKey = normalizeFlatProductKey(action.productTitle)
  const actionFilename = action.filename.toLowerCase()
  const actionStem = filenameStem(action.filename)
  if (!productKey || (!actionFilename && !actionStem)) {
    return md5s
  }

  for (const order of orders) {
    for (const product of order.products) {
      if (normalizeFlatProductKey(product.productTitle) !== productKey) {
        continue
      }
      for (const download of product.downloads) {
        if (!download.md5) {
          continue
        }
        const downloadFilename = download.filename.toLowerCase()
        if (downloadFilename === actionFilename || filenameStem(download.filename) === actionStem) {
          md5s.add(download.md5)
        }
      }
    }
  }
  return md5s
}

function findMetadataProductTitleForFilename(
  filename: string,
  orders: MetadataOrder[]
): string | undefined {
  const sourceStem = filenameStem(filename)
  if (!sourceStem) {
    return undefined
  }
  const matches = new Set<string>()
  for (const order of orders) {
    for (const product of order.products) {
      if (product.downloads.some((download) => filenameStem(download.filename) === sourceStem)) {
        matches.add(product.productTitle)
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined
}

type MetadataDownloadMatch = {
  order: MetadataOrder
  product: MetadataProduct
  download: MetadataProduct['downloads'][number]
}

type FlatLeftoverMatchResult =
  | { type: 'matched'; match: MetadataDownloadMatch; exact: boolean }
  | { type: 'untracked' }
  | { type: 'ambiguous'; productTitles: string[] }

const suspiciousAllCapsFolderPattern = /^[\d !#&'()+,.:;A-Z[\]_-]+$/

function normalizedFilenameStem(filename: string): string {
  return filenameStem(filename).replace(/\s+\(\d+\)$/, '')
}

function shouldScanSingleLevelFlatLeftoverFolder({
  folderName,
  directFileCount,
  childDirectoryCount,
}: {
  folderName: string
  directFileCount: number
  childDirectoryCount: number
}): boolean {
  if (/bundle/i.test(folderName)) {
    return true
  }
  if (!suspiciousAllCapsFolderPattern.test(folderName)) {
    return false
  }
  if (childDirectoryCount > 0) {
    return false
  }
  return directFileCount > 0
}

function findMetadataDownloadForFlatLeftover(
  filename: string,
  orders: MetadataOrder[]
): FlatLeftoverMatchResult {
  const localFilename = filename.toLowerCase()
  const localStem = normalizedFilenameStem(filename)
  const exactMatches: MetadataDownloadMatch[] = []
  const stemMatches: MetadataDownloadMatch[] = []

  for (const order of orders) {
    for (const product of order.products) {
      for (const download of product.downloads) {
        const downloadFilename = download.filename.toLowerCase()
        const match = { order, product, download }
        if (downloadFilename === localFilename) {
          exactMatches.push(match)
        }
        if (normalizedFilenameStem(download.filename) === localStem) {
          stemMatches.push(match)
        }
      }
    }
  }

  return exactMatches.length > 0
    ? selectMetadataDownloadMatch(exactMatches, true)
    : selectMetadataDownloadMatch(stemMatches, false)
}

function selectMetadataDownloadMatch(
  matches: MetadataDownloadMatch[],
  exact: boolean
): FlatLeftoverMatchResult {
  if (matches.length === 0) {
    return { type: 'untracked' }
  }
  const matchesByProduct = new Map<string, MetadataDownloadMatch[]>()
  for (const match of matches) {
    const key = normalizeFlatProductKey(match.product.productTitle)
    const productMatches = matchesByProduct.get(key) ?? []
    productMatches.push(match)
    matchesByProduct.set(key, productMatches)
  }
  if (matchesByProduct.size !== 1) {
    return {
      type: 'ambiguous',
      productTitles: [...matchesByProduct.values()]
        .map((productMatches) => productMatches[0]?.product.productTitle)
        .filter((productTitle): productTitle is string => productTitle !== undefined)
        .sort(),
    }
  }
  const productMatches = [...matchesByProduct.values()][0] ?? []
  return {
    type: 'matched',
    match: productMatches[0] as MetadataDownloadMatch,
    exact,
  }
}

function metadataFolderKey(title: string): string {
  return cleanName(title).toLowerCase()
}

function findMetadataOrderForFolder(
  folderName: string,
  orders: MetadataOrder[],
  allBundleTitles: string[]
): MetadataOrder | undefined {
  const exactMatches = orders.filter(
    (order) => metadataFolderKey(order.bundleTitle) === metadataFolderKey(folderName)
  )
  if (exactMatches.length === 1) {
    return exactMatches[0]
  }
  const similarMatches = orders.filter((order) => hasSimilarTitle(folderName, order.bundleTitle))
  return similarMatches.length === 1 &&
    isMetadataBundleFolder(folderName, similarMatches[0].bundleTitle, allBundleTitles)
    ? similarMatches[0]
    : undefined
}

function findMetadataProductForFolder(
  folderName: string,
  products: MetadataProduct[]
): MetadataProduct | undefined {
  const exactMatches = products.filter(
    (product) => metadataFolderKey(product.productTitle) === metadataFolderKey(folderName)
  )
  if (exactMatches.length === 1) {
    return exactMatches[0]
  }
  const similarMatches = products.filter((product) =>
    hasSimilarTitle(folderName, product.productTitle)
  )
  return similarMatches.length === 1 ? similarMatches[0] : undefined
}

async function collectFiles(directoryPath: string): Promise<string[]> {
  const files: string[] = []
  let entries
  try {
    entries = await readdir(directoryPath, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)))
      continue
    }
    if (entry.isFile()) {
      files.push(entryPath)
    }
  }
  return files
}

async function collectEmptyDirectories(directoryPath: string): Promise<string[]> {
  const emptyDirectories: string[] = []
  let entries
  try {
    entries = await readdir(directoryPath, { withFileTypes: true })
  } catch {
    return emptyDirectories
  }

  let hasFiles = false
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      emptyDirectories.push(...(await collectEmptyDirectories(entryPath)))
      continue
    }
    if (entry.isFile()) {
      hasFiles = true
    }
  }

  const childDirectories = entries.filter((entry) => entry.isDirectory())
  const childEmptySet = new Set(emptyDirectories.map((entryPath) => path.resolve(entryPath)))
  const allChildDirectoriesEmpty = childDirectories.every((entry) =>
    childEmptySet.has(path.resolve(path.join(directoryPath, entry.name)))
  )
  if (!hasFiles && allChildDirectoriesEmpty) {
    emptyDirectories.push(directoryPath)
  }
  return emptyDirectories
}

function firstRoutedLibraryForProduct({
  config,
  order,
  product,
  fallbackLibrary,
}: {
  config: AppConfig
  order: MetadataOrder
  product: MetadataProduct
  fallbackLibrary: ScanLibraryConfig
}): ScanLibraryConfig {
  const selected = selectRoutedDownloadCandidates(
    product.downloads.map((download) => metadataCandidate(download)),
    config,
    {
      bundleTitle: order.bundleTitle,
      productTitle: product.productTitle,
    }
  )
  return selected[0]?.library ?? fallbackLibrary
}

async function planSingleLevelFlatLeftovers({
  orders,
  config,
  actions,
  flatPublisherFoldersByProduct,
  plannedSources,
  plannedMovesBySource,
  plannedDestinations,
  plannedDestinationRegistry,
  resolveConflicts,
  conflictDir,
}: {
  orders: MetadataOrder[]
  config: AppConfig
  actions: OrganizeAction[]
  flatPublisherFoldersByProduct: Map<string, string>
  plannedSources: Set<string>
  plannedMovesBySource: Map<string, string>
  plannedDestinations: Set<string>
  plannedDestinationRegistry: PlannedDestinationRegistry
  resolveConflicts: ConflictResolutionMode
  conflictDir?: string
}): Promise<void> {
  for (const library of config.scanLibraries) {
    let topLevelEntries
    try {
      topLevelEntries = await readdir(library.path, { withFileTypes: true })
    } catch {
      continue
    }
    const canonicalPublisherByFamily = new Map<string, string>()
    for (const entry of topLevelEntries.filter((topLevelEntry) => topLevelEntry.isDirectory())) {
      if (entry.name.toLowerCase() === 'humble' || isHumbleBundleFolder(entry.name)) {
        continue
      }
      const familyKey = normalizePublisherFamilyKey(entry.name)
      if (!familyKey || familyKey === 'humble') {
        continue
      }
      const current = canonicalPublisherByFamily.get(familyKey)
      if (
        !current ||
        entry.name.length < current.length ||
        (entry.name.length === current.length && entry.name.localeCompare(current) < 0)
      ) {
        canonicalPublisherByFamily.set(familyKey, entry.name)
      }
    }

    for (const topLevelEntry of topLevelEntries.filter((entry) => entry.isDirectory())) {
      if (topLevelEntry.name.toLowerCase() === 'humble') {
        continue
      }
      const publisherFamilyKey = normalizePublisherFamilyKey(topLevelEntry.name)
      const canonicalPublisher = canonicalPublisherByFamily.get(publisherFamilyKey)
      if (canonicalPublisher && canonicalPublisher !== topLevelEntry.name) {
        continue
      }
      const topLevelPath = path.join(library.path, topLevelEntry.name)
      let childEntries
      try {
        childEntries = await readdir(topLevelPath, { withFileTypes: true })
      } catch {
        continue
      }
      if (
        !shouldScanSingleLevelFlatLeftoverFolder({
          folderName: topLevelEntry.name,
          directFileCount: childEntries.filter((entry) => entry.isFile()).length,
          childDirectoryCount: childEntries.filter((entry) => entry.isDirectory()).length,
        })
      ) {
        continue
      }

      for (const sourcePath of await collectFiles(topLevelPath)) {
        const normalizedSource = path.resolve(sourcePath).toLowerCase()
        if (plannedSources.has(normalizedSource)) {
          continue
        }
        const filename = path.basename(sourcePath)
        const matchResult = findMetadataDownloadForFlatLeftover(filename, orders)
        if (matchResult.type !== 'matched') {
          actions.push({
            cacheKey: `flat-leftover:${normalizedSource}`,
            filename,
            bundleTitle: topLevelEntry.name,
            productTitle:
              matchResult.type === 'ambiguous'
                ? 'Ambiguous flat leftover'
                : 'Untracked flat leftover',
            expectedLibraryName: library.name,
            expectedLibraryPath: library.path,
            selected: false,
            sourcePath,
            destinationPath: sourcePath,
            status: matchResult.type,
            reason:
              matchResult.type === 'ambiguous'
                ? `Flat leftover filename matches multiple products: ${matchResult.productTitles.join(', ')}.`
                : 'No metadata match for flat leftover file.',
          })
          plannedSources.add(normalizedSource)
          continue
        }

        const { order, product, download } = matchResult.match
        const localCandidate = metadataCandidate({
          ...download,
          filename,
          md5: matchResult.exact ? download.md5 : undefined,
        })
        const routedLibrary =
          selectRoutedDownloadCandidates([localCandidate], config, {
            bundleTitle: order.bundleTitle,
            productTitle: product.productTitle,
          })[0]?.library ??
          firstRoutedLibraryForProduct({ config, order, product, fallbackLibrary: library })
        const productKey = normalizeFlatProductKey(product.productTitle)
        const publisherFolder =
          flatPublisherFoldersByProduct.get(productKey) ?? inferPublisherFolder(order.bundleTitle)
        const stableSeriesFolder = await findExistingFlatSeriesFolder(
          routedLibrary.path,
          publisherFolder,
          product.productTitle
        )
        const destinationPath = path.join(
          buildLibraryProductFolder(
            { ...routedLibrary, layout: 'flat' as const },
            order.bundleTitle,
            product.productTitle,
            publisherFolder,
            stableSeriesFolder
          ),
          filename
        )
        const normalizedDestination = path.resolve(destinationPath).toLowerCase()
        if (normalizedSource === normalizedDestination) {
          plannedSources.add(normalizedSource)
          plannedMovesBySource.set(normalizedSource, normalizedDestination)
          plannedDestinations.add(normalizedDestination)
          continue
        }

        const action: OrganizeAction = {
          cacheKey: `flat-leftover:${normalizedSource}`,
          filename,
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
          expectedLibraryName: routedLibrary.name,
          expectedLibraryPath: library.path,
          selected: false,
          sourcePath,
          destinationPath,
          expectedMd5: matchResult.exact ? download.md5 : undefined,
          status: 'would-move-supplement',
          reason: matchResult.exact
            ? 'Single-level flat leftover file will be moved by metadata filename match.'
            : 'Single-level flat leftover file will be moved by unique metadata stem match.',
        }

        if (await pathExists(destinationPath)) {
          if (await sameFileSize(sourcePath, destinationPath)) {
            action.status = 'would-remove-duplicate'
            action.reason = 'Flat destination already satisfies this single-level leftover.'
          } else {
            action.reason = 'Flat destination exists but differs in file size.'
            await applyConflictResolution({ action, mode: resolveConflicts, conflictDir, orders })
          }
        } else if (plannedDestinations.has(normalizedDestination)) {
          const existingAction = plannedDestinationRegistry.get(normalizedDestination)
          if (existingAction) {
            await resolvePlannedDestinationCollision({
              action,
              existingAction,
              plannedDestinations,
              plannedDestinationRegistry,
              mode: resolveConflicts,
              conflictDir,
              orders,
            })
          } else {
            action.status = 'conflict'
            action.reason = 'Destination file is already planned for another candidate.'
          }
        } else {
          plannedDestinations.add(normalizedDestination)
          plannedDestinationRegistry.set(normalizedDestination, action)
        }
        plannedSources.add(normalizedSource)
        plannedMovesBySource.set(normalizedSource, normalizedDestination)
        actions.push(action)
      }
    }
  }
}

async function planFlatLeftovers({
  orders,
  config,
  actions,
  allBundleTitles,
  flatPublisherFoldersByProduct,
  plannedMovesBySource,
  plannedDestinations,
  resolveConflicts,
  conflictDir,
}: {
  orders: MetadataOrder[]
  config: AppConfig
  actions: OrganizeAction[]
  allBundleTitles: string[]
  flatPublisherFoldersByProduct: Map<string, string>
  plannedMovesBySource: Map<string, string>
  plannedDestinations: Set<string>
  resolveConflicts: ConflictResolutionMode
  conflictDir?: string
}): Promise<void> {
  const plannedSources = new Set(
    actions
      .map((action) => action.sourcePath)
      .filter((sourcePath): sourcePath is string => sourcePath !== undefined)
      .map((sourcePath) => path.resolve(sourcePath).toLowerCase())
  )
  const plannedDestinationRegistry: PlannedDestinationRegistry = new Map()
  for (const action of actions) {
    if (action.sourcePath && shouldReserveFlatPlannedFile(action)) {
      plannedDestinationRegistry.set(path.resolve(action.destinationPath).toLowerCase(), action)
    }
  }

  for (const library of config.scanLibraries) {
    let topLevelEntries
    try {
      topLevelEntries = await readdir(library.path, { withFileTypes: true })
    } catch {
      continue
    }

    for (const topLevelEntry of topLevelEntries.filter((entry) => entry.isDirectory())) {
      if (topLevelEntry.name.toLowerCase() === 'humble') {
        continue
      }
      const order = findMetadataOrderForFolder(topLevelEntry.name, orders, allBundleTitles)
      if (!order) {
        continue
      }
      const bundleFolder = path.join(library.path, topLevelEntry.name)
      let productEntries
      try {
        productEntries = await readdir(bundleFolder, { withFileTypes: true })
      } catch {
        continue
      }

      for (const productEntry of productEntries.filter((entry) => entry.isDirectory())) {
        const productFolder = path.join(bundleFolder, productEntry.name)
        const product = findMetadataProductForFolder(productEntry.name, order.products)
        const productTitle = product?.productTitle ?? 'Extras'
        const routedLibrary = product
          ? firstRoutedLibraryForProduct({ config, order, product, fallbackLibrary: library })
          : library
        if (routedLibrary.path !== library.path) {
          continue
        }
        const publisherFolder =
          flatPublisherFoldersByProduct.get(normalizeFlatProductKey(productTitle)) ??
          inferPublisherFolder(order.bundleTitle)
        const productDestinationFolder = buildLibraryProductFolder(
          { ...library, layout: 'flat' as const },
          order.bundleTitle,
          productTitle,
          publisherFolder,
          product ? undefined : 'Extras'
        )
        for (const sourcePath of await collectFiles(productFolder)) {
          const normalizedSource = path.resolve(sourcePath).toLowerCase()
          if (plannedSources.has(normalizedSource)) {
            continue
          }
          const relativeSource = path.relative(productFolder, sourcePath)
          const destinationPath = path.join(productDestinationFolder, relativeSource)
          const normalizedDestination = path.resolve(destinationPath).toLowerCase()
          if (normalizedSource === normalizedDestination) {
            continue
          }
          const action: OrganizeAction = {
            cacheKey: `local:${normalizedSource}`,
            filename: path.basename(sourcePath),
            bundleTitle: order.bundleTitle,
            productTitle,
            expectedLibraryName: library.name,
            expectedLibraryPath: library.path,
            selected: false,
            sourcePath,
            destinationPath,
            expectedMd5: product?.downloads.find(
              (download) =>
                download.filename.toLowerCase() === path.basename(sourcePath).toLowerCase()
            )?.md5,
            status: 'would-move-supplement',
            reason: product
              ? 'Supplementary local file will be moved during flat organize.'
              : 'Unmatched local file will be moved to flat Extras.',
          }
          if (await pathExists(destinationPath)) {
            if (await sameFileSize(sourcePath, destinationPath)) {
              action.status = 'would-remove-duplicate'
              action.reason = 'Flat destination already satisfies this supplementary duplicate.'
            } else {
              action.reason = 'Flat destination exists but differs in file size.'
              await applyConflictResolution({ action, mode: resolveConflicts, conflictDir, orders })
            }
          } else if (plannedDestinations.has(normalizedDestination)) {
            const existingAction = plannedDestinationRegistry.get(normalizedDestination)
            if (existingAction) {
              await resolvePlannedDestinationCollision({
                action,
                existingAction,
                plannedDestinations,
                plannedDestinationRegistry,
                mode: resolveConflicts,
                conflictDir,
                orders,
              })
            } else {
              action.status = 'conflict'
              action.reason = 'Destination file is already planned for another candidate.'
            }
          } else {
            plannedDestinations.add(normalizedDestination)
            plannedDestinationRegistry.set(normalizedDestination, action)
          }
          plannedSources.add(normalizedSource)
          plannedMovesBySource.set(normalizedSource, normalizedDestination)
          actions.push(action)
        }
      }
    }
  }

  await planSingleLevelFlatLeftovers({
    orders,
    config,
    actions,
    flatPublisherFoldersByProduct,
    plannedSources,
    plannedMovesBySource,
    plannedDestinations,
    plannedDestinationRegistry,
    resolveConflicts,
    conflictDir,
  })

  await planFlatPublisherAliasFolders({
    orders,
    config,
    actions,
    plannedMovesBySource,
    plannedDestinations,
    plannedDestinationRegistry,
    resolveConflicts,
    conflictDir,
  })
  await planFlatEmptyLegacyFolders({ orders, config, actions, allBundleTitles })
}

async function planFlatPublisherAliasFolders({
  orders,
  config,
  actions,
  plannedMovesBySource,
  plannedDestinations,
  plannedDestinationRegistry,
  resolveConflicts,
  conflictDir,
}: {
  orders: MetadataOrder[]
  config: AppConfig
  actions: OrganizeAction[]
  plannedMovesBySource: Map<string, string>
  plannedDestinations: Set<string>
  plannedDestinationRegistry: PlannedDestinationRegistry
  resolveConflicts: ConflictResolutionMode
  conflictDir?: string
}): Promise<void> {
  const plannedSources = new Set(
    actions
      .map((action) => action.sourcePath)
      .filter((sourcePath): sourcePath is string => sourcePath !== undefined)
      .map((sourcePath) => path.resolve(sourcePath).toLowerCase())
  )

  for (const library of config.scanLibraries) {
    let topLevelEntries
    try {
      topLevelEntries = await readdir(library.path, { withFileTypes: true })
    } catch {
      continue
    }

    const publisherFoldersByFamily = new Map<string, string[]>()
    for (const entry of topLevelEntries.filter((topLevelEntry) => topLevelEntry.isDirectory())) {
      if (entry.name.toLowerCase() === 'humble' || isHumbleBundleFolder(entry.name)) {
        continue
      }
      const familyKey = normalizePublisherFamilyKey(entry.name)
      if (!familyKey || familyKey === 'humble') {
        continue
      }
      const folders = publisherFoldersByFamily.get(familyKey) ?? []
      folders.push(entry.name)
      publisherFoldersByFamily.set(familyKey, folders)
    }

    for (const folders of publisherFoldersByFamily.values()) {
      if (folders.length < 2) {
        continue
      }
      const [canonicalFolder, ...aliasFolders] = folders.sort((left, right) => {
        const lengthDifference = left.length - right.length
        if (lengthDifference !== 0) {
          return lengthDifference
        }
        return left.localeCompare(right)
      })
      if (!canonicalFolder) {
        continue
      }
      const canonicalPath = path.join(library.path, canonicalFolder)
      for (const aliasFolder of aliasFolders) {
        const aliasPath = path.join(library.path, aliasFolder)
        for (const sourcePath of await collectFiles(aliasPath)) {
          const normalizedSource = path.resolve(sourcePath).toLowerCase()
          if (plannedSources.has(normalizedSource)) {
            continue
          }
          const relativeSource = path.relative(aliasPath, sourcePath)
          const relativeDirectory = path.dirname(relativeSource)
          const matchedProductTitle =
            relativeDirectory === '.'
              ? findMetadataProductTitleForFilename(path.basename(sourcePath), orders)
              : undefined
          const destinationPath = matchedProductTitle
            ? path.join(
                canonicalPath,
                inferSeriesFolder(matchedProductTitle),
                path.basename(sourcePath)
              )
            : path.join(canonicalPath, relativeSource)
          const normalizedDestination = path.resolve(destinationPath).toLowerCase()
          if (normalizedSource === normalizedDestination) {
            continue
          }
          const action: OrganizeAction = {
            cacheKey: `publisher-alias:${normalizedSource}`,
            filename: path.basename(sourcePath),
            bundleTitle: aliasFolder,
            productTitle: path.dirname(relativeSource) === '.' ? 'Publisher alias' : relativeSource,
            expectedLibraryName: library.name,
            expectedLibraryPath: library.path,
            selected: false,
            sourcePath,
            destinationPath,
            status: 'would-move-supplement',
            reason: `Publisher alias folder will be merged into ${canonicalFolder}.`,
          }
          if (await pathExists(destinationPath)) {
            if (await sameFileSize(sourcePath, destinationPath)) {
              action.status = 'would-remove-duplicate'
              action.reason = 'Canonical publisher folder already has this same-size file.'
            } else {
              action.reason = 'Canonical publisher folder already has a different file.'
              await applyConflictResolution({ action, mode: resolveConflicts, conflictDir, orders })
            }
          } else if (plannedDestinations.has(normalizedDestination)) {
            const existingAction = plannedDestinationRegistry.get(normalizedDestination)
            if (existingAction) {
              await resolvePlannedDestinationCollision({
                action,
                existingAction,
                plannedDestinations,
                plannedDestinationRegistry,
                mode: resolveConflicts,
                conflictDir,
                orders,
              })
            } else {
              action.status = 'conflict'
              action.reason = 'Destination file is already planned for another candidate.'
            }
          } else {
            plannedDestinations.add(normalizedDestination)
            plannedDestinationRegistry.set(normalizedDestination, action)
          }
          plannedSources.add(normalizedSource)
          plannedMovesBySource.set(normalizedSource, normalizedDestination)
          actions.push(action)
        }
      }
    }
  }
}

async function planFlatEmptyLegacyFolders({
  orders,
  config,
  actions,
  allBundleTitles,
}: {
  orders: MetadataOrder[]
  config: AppConfig
  actions: OrganizeAction[]
  allBundleTitles: string[]
}): Promise<void> {
  const plannedEmptyFolders = new Set(
    actions
      .filter(
        (action) =>
          action.status === 'would-remove-empty-folder' || action.status === 'removed-empty-folder'
      )
      .map((action) => action.sourcePath)
      .filter((sourcePath): sourcePath is string => sourcePath !== undefined)
      .map((sourcePath) => path.resolve(sourcePath).toLowerCase())
  )

  for (const library of config.scanLibraries) {
    let topLevelEntries
    try {
      topLevelEntries = await readdir(library.path, { withFileTypes: true })
    } catch {
      continue
    }

    for (const topLevelEntry of topLevelEntries.filter((entry) => entry.isDirectory())) {
      if (topLevelEntry.name.toLowerCase() === 'humble') {
        continue
      }
      const order = findMetadataOrderForFolder(topLevelEntry.name, orders, allBundleTitles)
      if (!order && !isHumbleBundleFolder(topLevelEntry.name)) {
        continue
      }

      const bundleFolder = path.join(library.path, topLevelEntry.name)
      const bundleTitle = order?.bundleTitle ?? topLevelEntry.name
      const emptyDirectories = await collectEmptyDirectories(bundleFolder)
      emptyDirectories.sort((left, right) => right.length - left.length)
      for (const emptyDirectory of emptyDirectories) {
        const normalizedEmptyDirectory = path.resolve(emptyDirectory).toLowerCase()
        if (
          normalizedEmptyDirectory === path.resolve(library.path).toLowerCase() ||
          plannedEmptyFolders.has(normalizedEmptyDirectory)
        ) {
          continue
        }
        plannedEmptyFolders.add(normalizedEmptyDirectory)
        actions.push({
          cacheKey: `empty:${normalizedEmptyDirectory}`,
          filename: path.basename(emptyDirectory),
          bundleTitle,
          productTitle: 'Empty folder',
          expectedLibraryName: library.name,
          expectedLibraryPath: library.path,
          selected: false,
          sourcePath: emptyDirectory,
          destinationPath: emptyDirectory,
          status: 'would-remove-empty-folder',
          reason: 'Empty legacy bundle folder will be removed.',
        })
      }
    }
  }
}

async function recordFlatOrganizeCache({
  config,
  actions,
}: {
  config: AppConfig
  actions: OrganizeAction[]
}): Promise<void> {
  const cache = await loadCache(config.libraryPath, config.cachePath)
  const now = new Date().toUTCString()

  for (const action of actions) {
    if (action.cacheKey.startsWith('publisher-alias:')) {
      continue
    }
    if (
      action.status !== 'moved' &&
      action.status !== 'moved-supplement' &&
      action.status !== 'already-correct' &&
      action.status !== 'removed-duplicate' &&
      action.status !== 'resolved-conflict' &&
      action.status !== 'quarantined-conflict'
    ) {
      continue
    }
    const library = config.scanLibraries.find(
      (scanLibrary) => scanLibrary.name === action.expectedLibraryName
    )
    if (!library) {
      continue
    }
    const flatLibrary = { ...library, layout: 'flat' as const }
    const flatCacheKey = buildFlatCacheKey(flatLibrary, action.productTitle, action.filename)
    if (!flatCacheKey) {
      continue
    }

    const cacheEntry = cache[action.cacheKey] ?? { urlLastModified: now }
    cache[action.cacheKey] = cacheEntry
    cache[flatCacheKey] = cacheEntry
    const flatPathParts = getFlatPathParts(
      library.path,
      action.destinationPath,
      action.bundleTitle,
      action.productTitle
    )
    const flatIndexEntry: Omit<FlatIndexEntry, 'bundleLocations'> & {
      bundleLocation: FlatIndexEntry['bundleLocations'][number]
    } = {
      flatCacheKey,
      canonicalPath: action.destinationPath,
      libraryName: library.name,
      libraryPath: library.path,
      publisher: flatPathParts.publisher,
      series: flatPathParts.series,
      productKey: normalizeFlatProductKey(action.productTitle),
      productTitle: action.productTitle,
      filename: action.filename,
      bundleLocation: {
        cacheKey: action.cacheKey,
        orderId: getOrderIdFromCacheKey(action.cacheKey),
        bundleTitle: action.bundleTitle,
        productTitle: action.productTitle,
        bundlePath: path.join(
          buildProductFolder(library.path, action.bundleTitle, action.productTitle),
          action.filename
        ),
      },
    }
    upsertFlatIndexEntry(cache, flatIndexEntry)
  }

  await saveCache(config.libraryPath, cache, config.cachePath)
}

export async function organizeLibrary({
  config,
  apply = false,
  canonical = false,
  flat = false,
  resolveConflicts,
  conflictDir,
  reportPath,
  onProgress,
}: OrganizeOptions): Promise<OrganizeReport> {
  if (flat && apply && !config.configPath) {
    throw new Error(
      'organize --flat --apply requires a loaded config file so libraries can be marked as flat.'
    )
  }

  onProgress?.('Loading metadata...')
  const metadata = await loadMetadata(config.libraryPath, config.metadataPath)
  const orders = Object.values(metadata.orders)
  if (orders.length === 0) {
    throw new Error('No metadata orders found. Run audit or download first.')
  }
  const conflictModes: ConflictResolutionMode[] = [
    'report',
    'prefer-flat',
    'prefer-largest',
    'prefer-md5-match',
    'prefer-known-md5',
    'prefer-known-md5-then-largest',
  ]
  if (resolveConflicts && !conflictModes.includes(resolveConflicts)) {
    throw new Error(`--resolve-conflicts must be one of: ${conflictModes.join(', ')}.`)
  }
  const effectiveResolveConflicts: ConflictResolutionMode = flat
    ? (resolveConflicts ??
      config.flatConflictResolution ??
      (config.scanLibraries.some((library) => library.layout === 'flat')
        ? FLAT_CONFLICT_RESOLUTION_DEFAULT
        : 'report'))
    : (resolveConflicts ?? 'report')
  if (!flat && effectiveResolveConflicts !== 'report') {
    throw new Error('--resolve-conflicts is only supported with organize --flat.')
  }
  const flatPublisherFoldersByProduct = flat ? buildPublisherFoldersByProduct(orders) : new Map()
  const allBundleTitles = orders.map((order) => order.bundleTitle)

  const scanPaths = getScanPaths(config)
  onProgress?.('Indexing local files...')
  const localDirectoryIndex = await buildLocalDirectoryIndex(scanPaths)
  const actions: OrganizeAction[] = []
  const plannedMovesBySource = new Map<string, string>()
  const plannedDestinations = new Set<string>()
  const plannedFlatFiles = new Set<string>()
  let productsProcessed = 0
  let selectedCandidates = 0

  let orderIndex = 0
  for (const order of orders) {
    orderIndex += 1
    onProgress?.(`Planning order ${orderIndex}/${orders.length}...`)
    const expectedFilenames = new Set(
      order.products
        .flatMap((product) => product.downloads)
        .map((download) => download.filename.toLowerCase())
    )
    const inferredBundleFolder = inferBundleFolder(localDirectoryIndex, expectedFilenames)

    for (const product of order.products) {
      productsProcessed += 1
      const selected = selectRoutedDownloadCandidates(
        product.downloads.map((download) => metadataCandidate(download)),
        config,
        {
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
        }
      )
      selectedCandidates += selected.length

      for (const routedCandidate of selected) {
        const { candidate } = routedCandidate
        const flatKey = flatPlannedFileKey(
          routedCandidate,
          product.productTitle,
          candidate.filename
        )
        if (flat && plannedFlatFiles.has(flatKey)) {
          continue
        }
        const action = await planOrganizeAction({
          cacheKey: `${order.orderId}:${candidate.filename}`,
          routedCandidate,
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
          selected: true,
          trackMissing: true,
          requireSameExtension: false,
          scanPaths,
          inferredBundleFolder,
          config,
          localDirectoryIndex,
          canonical,
          flat,
          publisherFolder: flatPublisherFoldersByProduct.get(
            normalizeFlatProductKey(product.productTitle)
          ),
          orders,
          allBundleTitles,
          resolveConflicts: effectiveResolveConflicts,
          conflictDir,
          plannedMovesBySource,
          plannedDestinations,
        })
        if (action) {
          actions.push(action)
          if (flat && shouldReserveFlatPlannedFile(action)) {
            plannedFlatFiles.add(flatKey)
          }
        }
      }

      const selectedCacheKeys = new Set(
        selected.map(({ candidate }) => `${order.orderId}:${candidate.filename.toLowerCase()}`)
      )
      for (const download of product.downloads) {
        const candidate = metadataCandidate(download)
        const cacheKey = `${order.orderId}:${candidate.filename.toLowerCase()}`
        if (selectedCacheKeys.has(cacheKey)) {
          continue
        }
        const [routedCandidate] = selectRoutedDownloadCandidates([candidate], config, {
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
        })
        if (!routedCandidate) {
          continue
        }
        const flatKey = flatPlannedFileKey(
          routedCandidate,
          product.productTitle,
          candidate.filename
        )
        if (flat && plannedFlatFiles.has(flatKey)) {
          continue
        }
        const action = await planOrganizeAction({
          cacheKey: `${order.orderId}:${candidate.filename}`,
          routedCandidate,
          bundleTitle: order.bundleTitle,
          productTitle: product.productTitle,
          selected: false,
          trackMissing: false,
          requireSameExtension: true,
          scanPaths,
          inferredBundleFolder,
          config,
          localDirectoryIndex,
          canonical,
          flat,
          publisherFolder: flatPublisherFoldersByProduct.get(
            normalizeFlatProductKey(product.productTitle)
          ),
          orders,
          allBundleTitles,
          resolveConflicts: effectiveResolveConflicts,
          conflictDir,
          plannedMovesBySource,
          plannedDestinations,
        })
        if (action) {
          actions.push(action)
          if (flat && shouldReserveFlatPlannedFile(action)) {
            plannedFlatFiles.add(flatKey)
          }
        }
      }
    }
  }

  if (flat) {
    onProgress?.('Planning flat leftovers...')
    await planFlatLeftovers({
      orders,
      config,
      actions,
      allBundleTitles,
      flatPublisherFoldersByProduct,
      plannedMovesBySource,
      plannedDestinations,
      resolveConflicts: effectiveResolveConflicts,
      conflictDir,
    })
  }

  if (apply) {
    await applyOrganizeActions(actions, onProgress)
    if (flat) {
      onProgress?.('Cleaning empty legacy bundle folders...')
      const postApplyEmptyStart = actions.length
      await planFlatEmptyLegacyFolders({
        orders,
        config,
        actions,
        allBundleTitles,
      })
      await applyOrganizeActions(actions.slice(postApplyEmptyStart), onProgress)
    }
    if (flat && config.configPath) {
      await recordFlatOrganizeCache({ config, actions })
      await markConfigLibrariesFlat(config.configPath)
    }
  }

  const summary = summarizeActions(actions, {
    dryRun: !apply,
    ordersProcessed: orders.length,
    productsProcessed,
    selectedCandidates,
    reportPath,
  })
  const report: OrganizeReport = {
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
