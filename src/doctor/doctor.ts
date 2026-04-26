import { createReadStream, constants } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

import type { ApiClient } from '../api/client'
import type { AppConfig, ScanLibraryConfig } from '../config'
import {
  inspectDownloadState,
  parsePurchaseKeysFromLibraryPage,
  type DownloadInspectionItem,
} from '../download/downloader'
import { resolveCachePath, type CacheData, type CacheEntry } from '../download/cache'

type DoctorStatus = 'ok' | 'warn' | 'fail' | 'info'

export type DoctorCheck = {
  status: DoctorStatus
  section: string
  message: string
  detail?: string
}

export type DoctorCacheProblem = {
  cacheKey: string
  filename?: string
  orderId?: string
  bundleTitle?: string
  productTitle?: string
  expectedPath?: string
  expectedLibrary?: string
  localPath?: string
  expectedSize?: number
  actualSize?: number
  expectedMd5?: string
  actualMd5?: string
  routingRoutes?: string[]
}

export type DoctorRoutingSummary = {
  libraryCounts: Record<string, number>
  routeCounts: Record<string, number>
  fallbackCount: number
  ambiguous: DoctorCacheProblem[]
}

export type DoctorCacheSummary = {
  cachePath: string
  cacheExists: boolean
  cacheEntries: number
  transformEntries: number
  invalidEntries: string[]
  legacyCachePaths: string[]
  failureReportPath: string
  failureReportExists: boolean
  failureCount?: number
}

export type DoctorDeepCacheValidation = {
  selectedCandidates: number
  routing: DoctorRoutingSummary
  cachedButMissing: DoctorCacheProblem[]
  localButUncached: DoctorCacheProblem[]
  wrongLibrary: DoctorCacheProblem[]
  sizeMismatches: DoctorCacheProblem[]
  hashMismatches: DoctorCacheProblem[]
  notDownloadedYet: DoctorCacheProblem[]
  orphanCacheEntries: DoctorCacheProblem[]
}

export type DoctorReport = {
  generatedAt: string
  configPath?: string
  mediaRoot?: string
  libraryPath: string
  checks: DoctorCheck[]
  cache: DoctorCacheSummary
  deepCache?: DoctorDeepCacheValidation
  reportPath?: string
}

export type DoctorOptions = {
  config: AppConfig
  client?: ApiClient
  auth?: boolean
  deep?: boolean
  hash?: boolean
  reportPath?: string
  writeReport?: boolean
  onProgress?: (message: string) => void
}

const DOWNLOAD_FAILURES_FILE = '.download-failures.json'
const LEGACY_CACHE_FILE = '.cache.json'
const DOCTOR_REPORT_FILE = 'doctor-report.json'

function addCheck(
  report: Pick<DoctorReport, 'checks'>,
  status: DoctorStatus,
  section: string,
  message: string,
  detail?: string
): void {
  report.checks.push({ status, section, message, detail })
}

function cacheEntries(cache: CacheData): Array<[string, CacheEntry]> {
  return Object.entries(cache).filter(
    (entry): entry is [string, CacheEntry] => entry[0] !== 'transforms' && entry[0] !== 'flatIndex'
  )
}

function countTransformEntries(cache: CacheData): number {
  return Object.keys(cache.transforms?.pdf?.cbz?.entries ?? {}).length
}

function validateCacheEntries(cache: CacheData): string[] {
  const invalidEntries: string[] = []
  for (const [key, value] of Object.entries(cache)) {
    if (key === 'transforms' || key === 'flatIndex') {
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      invalidEntries.push(key)
      continue
    }
    const entry = value as CacheEntry
    if (entry.urlLastModified !== undefined && typeof entry.urlLastModified !== 'string') {
      invalidEntries.push(key)
      continue
    }
    if (entry.uploadedAt !== undefined && typeof entry.uploadedAt !== 'string') {
      invalidEntries.push(key)
      continue
    }
    if (entry.md5 !== undefined && typeof entry.md5 !== 'string') {
      invalidEntries.push(key)
    }
  }
  return invalidEntries
}

async function readJsonFile(filePath: string): Promise<{
  exists: boolean
  data?: unknown
  error?: string
}> {
  try {
    return {
      exists: true,
      data: JSON.parse(await readFile(filePath, 'utf8')),
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { exists: false }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { exists: true, error: message }
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function checkReadableDirectory(
  report: DoctorReport,
  section: string,
  label: string,
  directory: string
): Promise<void> {
  try {
    await access(directory, constants.R_OK)
    addCheck(report, 'ok', section, `${label} is readable.`, directory)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    addCheck(report, 'fail', section, `${label} is not readable.`, `${directory}: ${message}`)
  }
}

async function checkWritableDirectory(
  report: DoctorReport,
  section: string,
  label: string,
  directory: string
): Promise<void> {
  try {
    await access(directory, constants.W_OK)
    addCheck(report, 'ok', section, `${label} is writable.`, directory)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    addCheck(report, 'warn', section, `${label} is not writable.`, `${directory}: ${message}`)
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(parent), path.resolve(candidate))
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function describeLibrary(library: ScanLibraryConfig): string {
  return library.name ? `${library.name}: ${library.path}` : library.path
}

function describeRouteMatchers(route: AppConfig['routes'][number]): string {
  const parts = [
    route.extensions ? `extensions=${route.extensions.join(', ')}` : undefined,
    route.platforms ? `platforms=${route.platforms.join(', ')}` : undefined,
    route.productTitlePatterns ? `product=${route.productTitlePatterns.join(' | ')}` : undefined,
    route.filenamePatterns ? `filename=${route.filenamePatterns.join(' | ')}` : undefined,
    route.bundleTitlePatterns ? `bundle=${route.bundleTitlePatterns.join(' | ')}` : undefined,
  ].filter((part): part is string => typeof part === 'string')

  return parts.join('; ')
}

function checkRoutes(report: DoctorReport, config: AppConfig): void {
  if (config.routes.length === 0) {
    addCheck(
      report,
      'info',
      'Routes',
      `No routes configured; fallback is ${config.libraryName ?? config.libraryPath}.`
    )
    return
  }

  const libraries = new Map(
    config.scanLibraries
      .filter((library) => library.name)
      .map((library) => [library.name as string, library])
  )

  for (const route of config.routes) {
    const library = libraries.get(route.library)
    if (!library) {
      addCheck(
        report,
        'fail',
        'Routes',
        `${route.id ?? route.library} routes to missing library ${route.library}.`
      )
      continue
    }

    addCheck(
      report,
      'ok',
      'Routes',
      `${route.id ?? describeRouteMatchers(route)} routes to ${route.library}.`,
      `${library.path}\n${describeRouteMatchers(route)}`
    )

    const extensionInclude = new Set(library.extInclude ?? [])
    const extensionExclude = new Set(library.extExclude ?? [])
    const missingIncludes = (route.extensions ?? []).filter(
      (extension) => extensionInclude.size > 0 && !extensionInclude.has(extension)
    )
    const excluded = (route.extensions ?? []).filter((extension) => extensionExclude.has(extension))

    if (missingIncludes.length > 0) {
      addCheck(
        report,
        'warn',
        'Routes',
        `${route.library} route extensions are not included by extInclude.`,
        missingIncludes.join(', ')
      )
    }
    if (excluded.length > 0) {
      addCheck(
        report,
        'warn',
        'Routes',
        `${route.library} route extensions are excluded by extExclude.`,
        excluded.join(', ')
      )
    }
  }

  addCheck(
    report,
    'info',
    'Routes',
    `Fallback library is ${config.libraryName ?? config.libraryPath}.`
  )
}

function checkFormatPreferences(report: DoctorReport, config: AppConfig): void {
  for (const library of config.scanLibraries) {
    const label = describeLibrary(library)
    const priority = library.formatPriority ?? []
    const include = library.extInclude ?? []
    const exclude = new Set(library.extExclude ?? [])

    if (priority.length > 0) {
      addCheck(report, 'info', 'Formats', `${label} preference: ${priority.join(' > ')}.`)
    }

    if (priority.length > 0 && include.length > 0) {
      const included = new Set(include)
      const selectable = priority.filter((extension) => included.has(extension))
      if (selectable.length === 0) {
        addCheck(
          report,
          'warn',
          'Formats',
          `${label} has no overlap between formatPriority and extInclude.`
        )
      }
    }

    const excludedPreferred = priority.filter((extension) => exclude.has(extension))
    if (excludedPreferred.length > 0) {
      addCheck(
        report,
        'warn',
        'Formats',
        `${label} excludes preferred formats.`,
        excludedPreferred.join(', ')
      )
    }
  }
}

function checkNestedLibraries(report: DoctorReport, config: AppConfig): void {
  for (const [index, left] of config.scanLibraries.entries()) {
    for (const right of config.scanLibraries.slice(index + 1)) {
      if (isPathInside(left.path, right.path) || isPathInside(right.path, left.path)) {
        addCheck(
          report,
          'warn',
          'Libraries',
          'Configured library paths are nested.',
          `${describeLibrary(left)} <-> ${describeLibrary(right)}`
        )
      }
    }
  }
}

async function findLegacyCaches(config: AppConfig, sharedCachePath: string): Promise<string[]> {
  const legacyCaches: string[] = []
  for (const library of config.scanLibraries) {
    const candidate = path.join(library.path, LEGACY_CACHE_FILE)
    if (path.resolve(candidate).toLowerCase() === path.resolve(sharedCachePath).toLowerCase()) {
      continue
    }
    if (await pathExists(candidate)) {
      legacyCaches.push(candidate)
    }
  }
  return legacyCaches
}

function defaultDoctorReportPath(config: AppConfig): string {
  if (config.configPath) {
    return path.join(path.dirname(config.configPath), DOCTOR_REPORT_FILE)
  }
  if (config.failureReportPath) {
    return path.join(path.dirname(config.failureReportPath), DOCTOR_REPORT_FILE)
  }
  return path.join(config.libraryPath, `.${DOCTOR_REPORT_FILE}`)
}

function buildProblem(item: DownloadInspectionItem): DoctorCacheProblem {
  return {
    cacheKey: item.cacheKey,
    filename: item.filename,
    orderId: item.orderId,
    bundleTitle: item.bundleTitle,
    productTitle: item.productTitle,
    expectedPath: item.expectedDestination,
    expectedLibrary: item.expectedLibraryName ?? item.expectedLibraryPath,
    localPath: item.localPath,
    expectedSize: item.expectedSize,
    expectedMd5: item.expectedMd5,
    routingRoutes: item.routing.matchedRoutes.map((route) => route.routeId),
  }
}

function createRoutingSummary(): DoctorRoutingSummary {
  return {
    libraryCounts: {},
    routeCounts: {},
    fallbackCount: 0,
    ambiguous: [],
  }
}

async function md5File(filePath: string): Promise<string> {
  const hash = createHash('md5')
  const stream = createReadStream(filePath)
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function validateDeepCache(options: {
  config: AppConfig
  client: ApiClient
  cache: CacheData
  hash: boolean
  onProgress?: (message: string) => void
}): Promise<DoctorDeepCacheValidation> {
  const inspection = await inspectDownloadState({
    client: options.client,
    config: options.config,
    cache: options.cache,
    onProgress: options.onProgress ? (message) => options.onProgress?.(message) : undefined,
  })
  const manifestKeys = new Set(
    inspection.candidates.flatMap((candidate) =>
      candidate.flatCacheKey ? [candidate.cacheKey, candidate.flatCacheKey] : [candidate.cacheKey]
    )
  )
  const validation: DoctorDeepCacheValidation = {
    selectedCandidates: inspection.candidates.length,
    routing: createRoutingSummary(),
    cachedButMissing: [],
    localButUncached: [],
    wrongLibrary: [],
    sizeMismatches: [],
    hashMismatches: [],
    notDownloadedYet: [],
    orphanCacheEntries: [],
  }

  for (const item of inspection.candidates) {
    const problem = buildProblem(item)
    const library = item.expectedLibraryName ?? item.expectedLibraryPath
    validation.routing.libraryCounts[library] = (validation.routing.libraryCounts[library] ?? 0) + 1
    if (item.routing.fallback) {
      validation.routing.fallbackCount += 1
    }
    if (item.routing.ambiguous) {
      validation.routing.ambiguous.push(problem)
    }
    for (const route of item.routing.matchedRoutes) {
      validation.routing.routeCounts[route.routeId] =
        (validation.routing.routeCounts[route.routeId] ?? 0) + 1
    }

    if (item.cacheEntry && !item.localPath) {
      validation.cachedButMissing.push(problem)
    }
    if (!item.cacheEntry && item.localPath) {
      validation.localButUncached.push(problem)
    }
    if (!item.cacheEntry && !item.localPath) {
      validation.notDownloadedYet.push(problem)
    }
    if (item.localPath && !isPathInside(item.expectedLibraryPath, item.localPath)) {
      validation.wrongLibrary.push(problem)
    }
    if (item.localPath && typeof item.expectedSize === 'number') {
      const stats = await stat(item.localPath)
      if (stats.size !== item.expectedSize) {
        validation.sizeMismatches.push({
          ...problem,
          actualSize: stats.size,
        })
      }
    }
    if (options.hash && item.localPath && item.expectedMd5) {
      const actualMd5 = await md5File(item.localPath)
      if (actualMd5 !== item.expectedMd5) {
        validation.hashMismatches.push({
          ...problem,
          actualMd5,
        })
      }
    }
  }

  for (const [cacheKey] of cacheEntries(options.cache)) {
    if (!manifestKeys.has(cacheKey)) {
      validation.orphanCacheEntries.push({ cacheKey })
    }
  }

  return validation
}

function addDeepCacheChecks(report: DoctorReport, validation: DoctorDeepCacheValidation): void {
  addCheck(
    report,
    'info',
    'Deep Cache',
    `Selected ${validation.selectedCandidates} current download candidate(s).`
  )

  for (const [library, count] of Object.entries(validation.routing.libraryCounts)) {
    addCheck(report, 'info', 'Routing Decisions', `${library}: ${count} selected candidate(s).`)
  }
  for (const [routeId, count] of Object.entries(validation.routing.routeCounts)) {
    addCheck(report, 'info', 'Routing Decisions', `${routeId}: ${count} match(es).`)
  }
  if (validation.routing.fallbackCount > 0) {
    addCheck(
      report,
      'info',
      'Routing Decisions',
      `Fallback routed candidate(s): ${validation.routing.fallbackCount}.`
    )
  }
  if (validation.routing.ambiguous.length > 0) {
    addCheck(
      report,
      'warn',
      'Routing Decisions',
      `Ambiguous routing decisions: ${validation.routing.ambiguous.length}.`
    )
  }

  if (validation.cachedButMissing.length > 0) {
    addCheck(
      report,
      'fail',
      'Deep Cache',
      `Cached but missing files: ${validation.cachedButMissing.length}.`
    )
  } else {
    addCheck(report, 'ok', 'Deep Cache', 'No cached-but-missing files found.')
  }

  if (validation.localButUncached.length > 0) {
    addCheck(
      report,
      'warn',
      'Deep Cache',
      `Local but uncached files: ${validation.localButUncached.length}.`
    )
  }

  if (validation.wrongLibrary.length > 0) {
    addCheck(
      report,
      'warn',
      'Deep Cache',
      `Files in the wrong routed library: ${validation.wrongLibrary.length}.`
    )
  }

  if (validation.sizeMismatches.length > 0) {
    addCheck(report, 'fail', 'Deep Cache', `Size mismatches: ${validation.sizeMismatches.length}.`)
  }

  if (validation.hashMismatches.length > 0) {
    addCheck(report, 'fail', 'Deep Cache', `MD5 mismatches: ${validation.hashMismatches.length}.`)
  }

  if (validation.notDownloadedYet.length > 0) {
    addCheck(
      report,
      'info',
      'Deep Cache',
      `Not downloaded yet: ${validation.notDownloadedYet.length}.`
    )
  }

  if (validation.orphanCacheEntries.length > 0) {
    addCheck(
      report,
      'info',
      'Deep Cache',
      `Cache entries not selected by current config: ${validation.orphanCacheEntries.length}.`
    )
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const config = options.config
  const cachePath = resolveCachePath(config.libraryPath, config.cachePath)
  const failureReportPath =
    config.failureReportPath ?? path.join(config.libraryPath, DOWNLOAD_FAILURES_FILE)
  const report: DoctorReport = {
    generatedAt: new Date().toISOString(),
    configPath: config.configPath,
    mediaRoot: config.mediaRoot,
    libraryPath: config.libraryPath,
    checks: [],
    cache: {
      cachePath,
      cacheExists: false,
      cacheEntries: 0,
      transformEntries: 0,
      invalidEntries: [],
      legacyCachePaths: [],
      failureReportPath,
      failureReportExists: false,
    },
  }

  addCheck(
    report,
    config.configPath ? 'ok' : 'info',
    'Config',
    config.configPath ? 'Loaded config file.' : 'Using CLI-only configuration.',
    config.configPath
  )
  addCheck(report, 'ok', 'Config', `Active library path: ${config.libraryPath}.`)
  if (config.libraryName) {
    addCheck(report, 'ok', 'Config', `Active configured library: ${config.libraryName}.`)
  }

  for (const library of config.scanLibraries) {
    await checkReadableDirectory(report, 'Libraries', describeLibrary(library), library.path)
  }
  await checkWritableDirectory(
    report,
    'Libraries',
    'Active download destination',
    config.libraryPath
  )
  checkNestedLibraries(report, config)
  checkRoutes(report, config)
  checkFormatPreferences(report, config)

  const cacheDirectory = path.dirname(cachePath)
  if (await pathExists(cacheDirectory)) {
    await checkWritableDirectory(report, 'Cache', 'Cache directory', cacheDirectory)
  } else {
    addCheck(report, 'warn', 'Cache', 'Cache directory does not exist yet.', cacheDirectory)
  }

  const cacheRead = await readJsonFile(cachePath)
  report.cache.cacheExists = cacheRead.exists
  let cache: CacheData = {}
  if (!cacheRead.exists) {
    addCheck(report, 'info', 'Cache', 'Shared cache does not exist yet.', cachePath)
  } else if (cacheRead.error) {
    addCheck(report, 'fail', 'Cache', 'Shared cache is not valid JSON.', cacheRead.error)
  } else {
    cache = cacheRead.data as CacheData
    report.cache.cacheEntries = cacheEntries(cache).length
    report.cache.transformEntries = countTransformEntries(cache)
    report.cache.invalidEntries = validateCacheEntries(cache)
    addCheck(
      report,
      'ok',
      'Cache',
      `Shared cache parsed with ${report.cache.cacheEntries} entries.`,
      cachePath
    )
    if (report.cache.transformEntries > 0) {
      addCheck(
        report,
        'info',
        'Cache',
        `Transform cache entries: ${report.cache.transformEntries}.`
      )
    }
    if (report.cache.invalidEntries.length > 0) {
      addCheck(
        report,
        'fail',
        'Cache',
        `Invalid cache entry shapes: ${report.cache.invalidEntries.length}.`
      )
    }
  }

  report.cache.legacyCachePaths = await findLegacyCaches(config, cachePath)
  if (report.cache.legacyCachePaths.length > 0) {
    addCheck(
      report,
      'warn',
      'Cache',
      `Legacy per-library cache files found: ${report.cache.legacyCachePaths.length}.`,
      report.cache.legacyCachePaths.join('\n')
    )
  }

  const failureReportRead = await readJsonFile(failureReportPath)
  report.cache.failureReportExists = failureReportRead.exists
  if (!failureReportRead.exists) {
    addCheck(
      report,
      'info',
      'Failure Report',
      'No download failure report found.',
      failureReportPath
    )
  } else if (failureReportRead.error) {
    addCheck(
      report,
      'fail',
      'Failure Report',
      'Failure report is not valid JSON.',
      failureReportRead.error
    )
  } else {
    const data = failureReportRead.data as {
      failures?: unknown[]
      failed?: number
    }
    report.cache.failureCount =
      typeof data.failed === 'number' ? data.failed : data.failures?.length
    addCheck(
      report,
      report.cache.failureCount && report.cache.failureCount > 0 ? 'warn' : 'ok',
      'Failure Report',
      `Failure report entries: ${report.cache.failureCount ?? 0}.`,
      failureReportPath
    )
  }

  if (options.auth || options.deep) {
    if (options.client) {
      try {
        const libraryPage = await options.client.getLibraryPage()
        const purchaseKeys = parsePurchaseKeysFromLibraryPage(libraryPage)
        addCheck(
          report,
          'ok',
          'Auth',
          `Humble library page loaded; ${purchaseKeys.length} purchase key(s) found.`
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        addCheck(report, 'fail', 'Auth', 'Unable to load Humble library page.', message)
      }
    } else {
      addCheck(report, 'fail', 'Auth', 'Auth check requested but no API client was provided.')
    }
  }

  if (options.deep && options.client && !cacheRead.error) {
    report.deepCache = await validateDeepCache({
      config,
      client: options.client,
      cache,
      hash: options.hash ?? false,
      onProgress: options.onProgress,
    })
    addDeepCacheChecks(report, report.deepCache)
  }

  if (options.writeReport || options.deep || options.reportPath) {
    const reportPath = options.reportPath ?? defaultDoctorReportPath(config)
    report.reportPath = reportPath
    addCheck(report, 'info', 'Report', 'Wrote doctor report.', reportPath)
    await mkdir(path.dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, undefined, 2)}\n`)
  }

  return report
}

export function summarizeDoctor(report: DoctorReport): {
  failures: number
  warnings: number
  infos: number
} {
  return {
    failures: report.checks.filter((check) => check.status === 'fail').length,
    warnings: report.checks.filter((check) => check.status === 'warn').length,
    infos: report.checks.filter((check) => check.status === 'info').length,
  }
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['HBD Doctor', '']
  const sections = [...new Set(report.checks.map((check) => check.section))]
  for (const section of sections) {
    lines.push(section)
    for (const check of report.checks.filter((item) => item.section === section)) {
      lines.push(`  ${check.status.toUpperCase().padEnd(4)}  ${check.message}`)
      if (check.detail) {
        for (const line of check.detail.split(/\r?\n/)) {
          lines.push(`        ${line}`)
        }
      }
    }
    lines.push('')
  }

  const summary = summarizeDoctor(report)
  lines.push('Result')
  if (summary.failures > 0) {
    lines.push(`  FAIL  ${summary.failures} failure(s), ${summary.warnings} warning(s).`)
  } else if (summary.warnings > 0) {
    lines.push(`  WARN  Ready with ${summary.warnings} warning(s).`)
  } else {
    lines.push('  OK    Ready for audit/download.')
  }

  return lines.join('\n')
}
