import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const APP_HOME_DIR = '.hbd'
const CONFIG_FILE = 'config.json'
const DEFAULT_CACHE_PATH = `${APP_HOME_DIR}/cache.json`
const DEFAULT_FAILURE_REPORT_PATH = `${APP_HOME_DIR}/download-failures.json`
const DEFAULT_METADATA_PATH = `${APP_HOME_DIR}/metadata.json`
const CONFIG_VERSION = 1
const CONFIG_ENV_VAR = 'HBD_CONFIG'

const topLevelConfigKeys = new Set([
  'version',
  'defaultLibrary',
  'cachePath',
  'failureReportPath',
  'metadataPath',
  'routes',
  'libraries',
])
const routeConfigKeys = new Set([
  'id',
  'library',
  'extensions',
  'platforms',
  'bundleTitlePatterns',
  'productTitlePatterns',
  'filenamePatterns',
])
const libraryConfigKeys = new Set([
  'path',
  'layout',
  'formatPriority',
  'extInclude',
  'extExclude',
  'platformInclude',
  'troveOnly',
  'showProgress',
])
const forbiddenConfigKeys = new Set([
  'sessionAuth',
  'cookieFile',
  'purchaseKeys',
  'updateOnly',
  'offlineAudit',
])

export type LibraryLayout = 'bundle' | 'flat'

export type LibraryPreferences = {
  path: string
  layout?: LibraryLayout
  platformInclude?: string[]
  extInclude?: string[]
  extExclude?: string[]
  formatPriority?: string[]
  troveOnly?: boolean
  showProgress?: boolean
}

export type ScanLibraryConfig = LibraryPreferences & {
  name?: string
}

export type LibraryRoute = {
  id?: string
  library: string
  extensions?: string[]
  platforms?: string[]
  bundleTitlePatterns?: string[]
  productTitlePatterns?: string[]
  filenamePatterns?: string[]
}

export type ConfigFileOverrides = {
  configPath: string
  mediaRoot: string
  defaultLibrary: string
  libraries: Record<string, LibraryPreferences>
  routes: LibraryRoute[]
  cachePath?: string
  failureReportPath?: string
  metadataPath?: string
}

export type LoadedConfigFile = {
  path: string
  mediaRoot: string
  overrides: ConfigFileOverrides
}

/**
 * Normalized app configuration used across modules.
 */
export type AppConfig = {
  /** Config file path when loaded from .hbd/config.json, --config, or HBD_CONFIG. */
  configPath?: string
  /** Media root used to resolve config-relative paths. */
  mediaRoot?: string
  /** Active configured library name selected for downloads. */
  libraryName?: string
  /** Whether scan libraries came from a named config file. */
  hasConfiguredLibraries: boolean
  /** Destination routes. Earlier routes take precedence when multiple routes match. */
  routes: LibraryRoute[]
  /** Path to a Netscape-format cookie file used for authentication. */
  cookieFile?: string
  /** Raw value of the `_simpleauth_sess` cookie when provided directly. */
  sessionAuth?: string
  /** Root directory where downloads are stored. */
  libraryPath: string
  /** Additional root directories scanned for existing files before downloading. */
  scanPaths: string[]
  /** Scan roots with per-library format/filter preferences. */
  scanLibraries: ScanLibraryConfig[]
  /** Optional cache file path shared across library roots. */
  cachePath?: string
  /** Optional download failure report path. */
  failureReportPath?: string
  /** Optional Humble catalog metadata snapshot path. */
  metadataPath?: string
  /** Only download Humble Trove content. */
  troveOnly: boolean
  /** Whether to show per-item progress indicators. */
  showProgress: boolean
  /** Whether to only check for updates instead of full download. */
  updateOnly: boolean
  /** Limit downloads to specific platforms. */
  platformInclude?: string[]
  /** Only download files with these extensions. */
  extInclude?: string[]
  /** Exclude files with these extensions. */
  extExclude?: string[]
  /** Preferred download extensions in priority order. */
  formatPriority?: string[]
  /** Only download items from specific purchase keys. */
  purchaseKeys?: string[]
  /** Skip remote metadata lookups during audit. */
  offlineAudit: boolean
}

export type ConfigOverrides = {
  configPath?: string
  mediaRoot?: string
  defaultLibrary?: string
  libraryName?: string
  libraries?: Record<string, LibraryPreferences>
  routes?: LibraryRoute[]
  cookieFile?: string
  sessionAuth?: string
  libraryPath?: string
  scanPaths?: string[]
  cachePath?: string
  failureReportPath?: string
  metadataPath?: string
  troveOnly?: boolean
  showProgress?: boolean
  updateOnly?: boolean
  platformInclude?: string[]
  extInclude?: string[]
  extExclude?: string[]
  formatPriority?: string[]
  purchaseKeys?: string[]
  offlineAudit?: boolean
}

export type ConfigInitLibrary = {
  name: string
  path: string
}

export type ConfigInitOptions = {
  mediaRoot: string
  defaultLibrary: string
  libraries: ConfigInitLibrary[]
  cachePath?: string
  failureReportPath?: string
  metadataPath?: string
}

export type ConfigInitResult = {
  configPath: string
  mediaRoot: string
}

type ConfigFileJson = {
  version: number
  defaultLibrary: string
  cachePath?: string
  failureReportPath?: string
  metadataPath?: string
  routes?: LibraryRoute[]
  libraries: Record<string, LibraryPreferences>
}

function normalizeValues(values?: string[]): string[] | undefined {
  return values?.map((value) => value.toLowerCase())
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Config field "${field}" must be a non-empty string.`)
  }
  return value
}

function assertStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Config field "${field}" must be an array of strings.`)
  }
  return value
}

function assertBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`Config field "${field}" must be a boolean.`)
  }
  return value
}

function assertLibraryLayout(value: unknown, field: string): LibraryLayout | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value !== 'bundle' && value !== 'flat') {
    throw new Error(`Config field "${field}" must be "bundle" or "flat".`)
  }
  return value
}

function assertNoForbiddenKeys(keys: string[], location: string): void {
  const forbiddenKey = keys.find((key) => forbiddenConfigKeys.has(key))
  if (forbiddenKey) {
    throw new Error(`Config ${location} cannot include "${forbiddenKey}".`)
  }
}

function assertKnownKeys(keys: string[], allowedKeys: Set<string>, location: string): void {
  const unknownKey = keys.find((key) => !allowedKeys.has(key))
  if (unknownKey) {
    throw new Error(`Config ${location} contains unknown field "${unknownKey}".`)
  }
}

function resolveConfigPathValue(value: string | undefined, mediaRoot: string): string | undefined {
  if (!value) {
    return undefined
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(mediaRoot, value)
}

function getMediaRootForConfig(configPath: string): string {
  const configDirectory = path.dirname(configPath)
  return path.basename(configDirectory).toLowerCase() === APP_HOME_DIR
    ? path.dirname(configDirectory)
    : configDirectory
}

function normalizeLibraryPreferences(
  name: string,
  value: unknown,
  mediaRoot: string
): LibraryPreferences {
  if (!isObject(value)) {
    throw new Error(`Config library "${name}" must be an object.`)
  }

  const keys = Object.keys(value)
  assertNoForbiddenKeys(keys, `library "${name}"`)
  assertKnownKeys(keys, libraryConfigKeys, `library "${name}"`)

  const libraryPath = assertString(value.path, `libraries.${name}.path`)
  return {
    path: resolveConfigPathValue(libraryPath, mediaRoot) ?? libraryPath,
    layout: assertLibraryLayout(value.layout, `libraries.${name}.layout`) ?? 'bundle',
    platformInclude: normalizeValues(
      assertStringArray(value.platformInclude, `libraries.${name}.platformInclude`)
    ),
    extInclude: normalizeValues(
      assertStringArray(value.extInclude, `libraries.${name}.extInclude`)
    ),
    extExclude: normalizeValues(
      assertStringArray(value.extExclude, `libraries.${name}.extExclude`)
    ),
    formatPriority: normalizeValues(
      assertStringArray(value.formatPriority, `libraries.${name}.formatPriority`)
    ),
    troveOnly: assertBoolean(value.troveOnly, `libraries.${name}.troveOnly`),
    showProgress: assertBoolean(value.showProgress, `libraries.${name}.showProgress`),
  }
}

function normalizeRouteValues(values: string[] | undefined, field: string): string[] | undefined {
  if (!values) {
    return undefined
  }
  if (values.length === 0) {
    throw new Error(`Config field "${field}" must include at least one value.`)
  }
  if (values.some((value) => value.trim().length === 0)) {
    throw new Error(`Config field "${field}" cannot include empty values.`)
  }
  return uniqueValues(values.map((value) => value.toLowerCase()))
}

function normalizePatternValues(values: string[] | undefined, field: string): string[] | undefined {
  if (!values) {
    return undefined
  }
  if (values.length === 0) {
    throw new Error(`Config field "${field}" must include at least one value.`)
  }
  if (values.some((value) => value.trim().length === 0)) {
    throw new Error(`Config field "${field}" cannot include empty values.`)
  }
  for (const value of values) {
    try {
      new RegExp(value, 'i')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Config field "${field}" contains invalid regex "${value}": ${message}`)
    }
  }
  return uniqueValues(values)
}

function normalizeRoutes(
  value: unknown,
  libraries: Record<string, LibraryPreferences>
): LibraryRoute[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new TypeError('Config field "routes" must be an array.')
  }

  return value.map((route, index) => {
    const location = `routes[${index}]`
    if (!isObject(route)) {
      throw new Error(`Config ${location} must be an object.`)
    }

    const keys = Object.keys(route)
    assertNoForbiddenKeys(keys, location)
    assertKnownKeys(keys, routeConfigKeys, location)

    const library = assertString(route.library, `${location}.library`)
    if (!Object.hasOwn(libraries, library)) {
      throw new Error(`Config ${location} references unknown library "${library}".`)
    }
    const id = route.id === undefined ? undefined : assertString(route.id, `${location}.id`)
    const extensions = normalizeRouteValues(
      assertStringArray(route.extensions, `${location}.extensions`),
      `${location}.extensions`
    )
    const platforms = normalizeRouteValues(
      assertStringArray(route.platforms, `${location}.platforms`),
      `${location}.platforms`
    )
    const bundleTitlePatterns = normalizePatternValues(
      assertStringArray(route.bundleTitlePatterns, `${location}.bundleTitlePatterns`),
      `${location}.bundleTitlePatterns`
    )
    const productTitlePatterns = normalizePatternValues(
      assertStringArray(route.productTitlePatterns, `${location}.productTitlePatterns`),
      `${location}.productTitlePatterns`
    )
    const filenamePatterns = normalizePatternValues(
      assertStringArray(route.filenamePatterns, `${location}.filenamePatterns`),
      `${location}.filenamePatterns`
    )
    if (
      !extensions &&
      !platforms &&
      !bundleTitlePatterns &&
      !productTitlePatterns &&
      !filenamePatterns
    ) {
      throw new Error(`Config ${location} must include at least one route matcher.`)
    }

    return {
      id,
      library,
      extensions,
      platforms,
      bundleTitlePatterns,
      productTitlePatterns,
      filenamePatterns,
    }
  })
}

function normalizeConfigFile(data: unknown, configPath: string, mediaRoot: string): ConfigFileJson {
  if (!isObject(data)) {
    throw new Error('Config file must contain a JSON object.')
  }

  const keys = Object.keys(data)
  assertNoForbiddenKeys(keys, 'root')
  assertKnownKeys(keys, topLevelConfigKeys, 'root')

  if (data.version !== CONFIG_VERSION) {
    throw new Error(`Config version must be ${CONFIG_VERSION}.`)
  }

  const defaultLibrary = assertString(data.defaultLibrary, 'defaultLibrary')
  if (!isObject(data.libraries)) {
    throw new Error('Config field "libraries" must be an object.')
  }

  const libraries: Record<string, LibraryPreferences> = {}
  for (const [name, library] of Object.entries(data.libraries)) {
    if (!name) {
      throw new Error('Config library names must be non-empty.')
    }
    libraries[name] = normalizeLibraryPreferences(name, library, mediaRoot)
  }

  if (Object.keys(libraries).length === 0) {
    throw new Error('Config field "libraries" must include at least one library.')
  }

  if (!Object.hasOwn(libraries, defaultLibrary)) {
    throw new Error(`Config defaultLibrary "${defaultLibrary}" does not exist in libraries.`)
  }
  const routes = normalizeRoutes(data.routes, libraries)

  const cachePath =
    resolveConfigPathValue(
      data.cachePath === undefined ? DEFAULT_CACHE_PATH : assertString(data.cachePath, 'cachePath'),
      mediaRoot
    ) ?? path.join(path.dirname(configPath), 'cache.json')
  const failureReportPath =
    resolveConfigPathValue(
      data.failureReportPath === undefined
        ? DEFAULT_FAILURE_REPORT_PATH
        : assertString(data.failureReportPath, 'failureReportPath'),
      mediaRoot
    ) ?? path.join(path.dirname(configPath), 'download-failures.json')
  const metadataPath =
    resolveConfigPathValue(
      data.metadataPath === undefined
        ? DEFAULT_METADATA_PATH
        : assertString(data.metadataPath, 'metadataPath'),
      mediaRoot
    ) ?? path.join(path.dirname(configPath), 'metadata.json')

  return {
    version: CONFIG_VERSION,
    defaultLibrary,
    cachePath,
    failureReportPath,
    metadataPath,
    routes,
    libraries,
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export async function discoverConfigPath(
  startDirectory = process.cwd()
): Promise<string | undefined> {
  let currentDirectory = path.resolve(startDirectory)

  while (currentDirectory) {
    const candidate = path.join(currentDirectory, APP_HOME_DIR, CONFIG_FILE)
    if (await fileExists(candidate)) {
      return candidate
    }

    const parentDirectory = path.dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      return undefined
    }
    currentDirectory = parentDirectory
  }
}

export async function resolveConfigFilePath(options: {
  configPath?: string
  envConfigPath?: string
  cwd?: string
}): Promise<string | undefined> {
  if (options.configPath) {
    return path.resolve(options.configPath)
  }

  if (options.envConfigPath) {
    return path.resolve(options.envConfigPath)
  }

  return discoverConfigPath(options.cwd ?? process.cwd())
}

export async function loadConfigFile(configPath: string): Promise<LoadedConfigFile> {
  const resolvedConfigPath = path.resolve(configPath)
  const mediaRoot = getMediaRootForConfig(resolvedConfigPath)
  let parsed: unknown

  try {
    const configContent = await readFile(resolvedConfigPath, 'utf8')
    parsed = JSON.parse(configContent.replace(/^\uFEFF/, ''))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to load config file "${resolvedConfigPath}": ${message}`)
  }

  const configFile = normalizeConfigFile(parsed, resolvedConfigPath, mediaRoot)
  return {
    path: resolvedConfigPath,
    mediaRoot,
    overrides: {
      configPath: resolvedConfigPath,
      mediaRoot,
      defaultLibrary: configFile.defaultLibrary,
      libraries: configFile.libraries,
      routes: configFile.routes ?? [],
      cachePath: configFile.cachePath,
      failureReportPath: configFile.failureReportPath,
      metadataPath: configFile.metadataPath,
    },
  }
}

export async function loadConfigFromSources(options: {
  configPath?: string
  envConfigPath?: string
  cwd?: string
}): Promise<LoadedConfigFile | undefined> {
  const resolvedConfigPath = await resolveConfigFilePath({
    configPath: options.configPath,
    envConfigPath: options.envConfigPath ?? process.env[CONFIG_ENV_VAR],
    cwd: options.cwd,
  })
  return resolvedConfigPath ? loadConfigFile(resolvedConfigPath) : undefined
}

export function definedConfigOverrides(overrides: ConfigOverrides): ConfigOverrides {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined)
  ) as ConfigOverrides
}

function formatConfigPathForWrite(inputPath: string, mediaRoot: string): string {
  const absolutePath = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(mediaRoot, inputPath)
  const relativePath = path.relative(mediaRoot, absolutePath)
  const isInsideMediaRoot =
    relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))

  if (!isInsideMediaRoot) {
    return path.normalize(inputPath)
  }

  return relativePath.replaceAll(path.sep, '/')
}

function defaultPreferencesForLibrary(name: string): Omit<LibraryPreferences, 'path'> {
  const normalizedName = name.toLowerCase()
  if (normalizedName.includes('book')) {
    return {
      formatPriority: ['epub', 'pdf', 'mobi'],
      extInclude: ['epub', 'pdf', 'mobi'],
    }
  }
  if (normalizedName.includes('comic') || normalizedName.includes('manga')) {
    return {
      formatPriority: ['cbz', 'pdf', 'epub', 'mobi'],
      extInclude: ['cbz', 'pdf', 'epub', 'mobi'],
    }
  }
  return {}
}

function defaultRoutesForLibraries(libraries: Record<string, LibraryPreferences>): LibraryRoute[] {
  const libraryNames = Object.keys(libraries)
  const booksLibrary =
    libraryNames.find((name) => name.toLowerCase() === 'books') ??
    libraryNames.find((name) => name.toLowerCase().includes('book'))
  const comicsLibrary =
    libraryNames.find((name) => name.toLowerCase() === 'comics') ??
    libraryNames.find((name) => name.toLowerCase().includes('comic'))
  const mangaLibrary =
    libraryNames.find((name) => name.toLowerCase() === 'manga') ??
    libraryNames.find((name) => name.toLowerCase().includes('manga'))
  const routes: LibraryRoute[] = []

  if (mangaLibrary) {
    routes.push({
      id: 'manga-bundles',
      library: mangaLibrary,
      bundleTitlePatterns: [String.raw`\bmanga\s+bundle\b`],
    })
  }

  if (comicsLibrary) {
    routes.push({
      id: 'comic-bundles',
      library: comicsLibrary,
      bundleTitlePatterns: [
        String.raw`\bcomics?\s+bundle\b`,
        String.raw`\bgames?\s+(?:&|and)\s+comics?\s+crossover\s+collection\b`,
      ],
    })
  }

  if (comicsLibrary) {
    routes.push({
      id: 'comic-formats',
      library: comicsLibrary,
      extensions: ['cbz'],
    })
  }

  if (booksLibrary) {
    routes.push({
      id: 'book-bundles',
      library: booksLibrary,
      bundleTitlePatterns: [
        String.raw`\b(?:book bundle|ebooks?|e-books?|novels?|writing bundle|nanowrimo)\b`,
      ],
    })
  }

  if (mangaLibrary) {
    routes.push({
      id: 'manga-products',
      library: mangaLibrary,
      productTitlePatterns: [String.raw`\bmanga\b`],
      filenamePatterns: [String.raw`\bmanga\b`],
    })
  }

  if (comicsLibrary) {
    routes.push({
      id: 'comic-products',
      library: comicsLibrary,
      productTitlePatterns: [String.raw`\b(?:comic|comics)\b`],
      filenamePatterns: [String.raw`\b(?:comic|comics)\b`],
    })
  }

  if (booksLibrary) {
    routes.push(
      {
        id: 'book-products',
        library: booksLibrary,
        productTitlePatterns: [String.raw`\b(?:book|ebook|e-book|novel|guide|author)\b`],
        filenamePatterns: [String.raw`\b(?:book|ebook|e-book|novel|guide)\b`],
      },
      {
        id: 'ebook-formats',
        library: booksLibrary,
        extensions: ['epub', 'mobi'],
      }
    )
  }

  return routes
}

export async function createConfigFile(options: ConfigInitOptions): Promise<ConfigInitResult> {
  const mediaRoot = path.resolve(options.mediaRoot)
  const appHome = path.join(mediaRoot, APP_HOME_DIR)
  const configPath = path.join(appHome, CONFIG_FILE)

  if (await fileExists(configPath)) {
    throw new Error(`Config file already exists: ${configPath}`)
  }

  const libraries: Record<string, LibraryPreferences> = {}
  for (const library of options.libraries) {
    if (!library.name || !library.path) {
      throw new Error('Each library must include a name and path.')
    }
    libraries[library.name] = {
      path: formatConfigPathForWrite(library.path, mediaRoot),
      ...defaultPreferencesForLibrary(library.name),
    }
  }

  if (!Object.hasOwn(libraries, options.defaultLibrary)) {
    throw new Error(`Default library "${options.defaultLibrary}" does not exist in libraries.`)
  }

  const config: ConfigFileJson = {
    version: CONFIG_VERSION,
    defaultLibrary: options.defaultLibrary,
    cachePath: formatConfigPathForWrite(options.cachePath ?? DEFAULT_CACHE_PATH, mediaRoot),
    failureReportPath: formatConfigPathForWrite(
      options.failureReportPath ?? DEFAULT_FAILURE_REPORT_PATH,
      mediaRoot
    ),
    metadataPath: formatConfigPathForWrite(
      options.metadataPath ?? DEFAULT_METADATA_PATH,
      mediaRoot
    ),
    routes: defaultRoutesForLibraries(libraries),
    libraries,
  }

  await mkdir(appHome, { recursive: true })
  await writeFile(configPath, `${JSON.stringify(config, undefined, 2)}\n`)

  return {
    configPath,
    mediaRoot,
  }
}

export async function markConfigLibrariesFlat(configPath: string): Promise<void> {
  const data = JSON.parse(await readFile(configPath, 'utf8')) as ConfigFileJson
  if (!isObject(data.libraries)) {
    throw new Error('Config field "libraries" must be an object.')
  }

  for (const library of Object.values(data.libraries)) {
    library.layout = 'flat'
  }

  await writeFile(configPath, `${JSON.stringify(data, undefined, 2)}\n`)
}

function normalizeLibraryMap(
  libraries?: Record<string, LibraryPreferences>
): Record<string, LibraryPreferences> {
  const normalized: Record<string, LibraryPreferences> = {}
  for (const [name, library] of Object.entries(libraries ?? {})) {
    normalized[name] = {
      path: library.path,
      layout: library.layout ?? 'bundle',
      platformInclude: normalizeValues(library.platformInclude),
      extInclude: normalizeValues(library.extInclude),
      extExclude: normalizeValues(library.extExclude),
      formatPriority: normalizeValues(library.formatPriority),
      troveOnly: library.troveOnly,
      showProgress: library.showProgress,
    }
  }
  return normalized
}

function scanLibraryKey(libraryPath: string): string {
  return path.resolve(libraryPath).toLowerCase()
}

function buildScanLibraries(
  libraryPath: string,
  effectiveConfig: Omit<LibraryPreferences, 'path'>,
  configuredLibraries: Record<string, LibraryPreferences>,
  scanPaths?: string[]
): ScanLibraryConfig[] {
  const scanLibraries: ScanLibraryConfig[] = []
  const seen = new Set<string>()

  function addScanLibrary(library: ScanLibraryConfig): void {
    const key = scanLibraryKey(library.path)
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    scanLibraries.push(library)
  }

  for (const [name, library] of Object.entries(configuredLibraries)) {
    addScanLibrary({ name, ...library })
  }

  addScanLibrary({
    path: libraryPath,
    ...effectiveConfig,
  })

  for (const scanPath of scanPaths ?? []) {
    addScanLibrary({
      path: scanPath,
      ...effectiveConfig,
    })
  }

  return scanLibraries
}

/**
 * Resolve CLI and file overrides into a full AppConfig object.
 */
export function resolveConfig(overrides: ConfigOverrides): AppConfig {
  const defaultFormatPriority = ['cbz', 'epub', 'pdf', 'mobi']
  const libraries = normalizeLibraryMap(overrides.libraries)
  const hasConfiguredLibraries = Object.keys(libraries).length > 0
  const activeLibraryName = hasConfiguredLibraries
    ? (overrides.libraryName ?? overrides.defaultLibrary)
    : undefined

  if (overrides.libraryName && !hasConfiguredLibraries) {
    throw new Error('--library requires a loaded config file.')
  }
  if (
    hasConfiguredLibraries &&
    (!activeLibraryName || !Object.hasOwn(libraries, activeLibraryName))
  ) {
    throw new Error(`Configured library "${activeLibraryName ?? ''}" does not exist.`)
  }

  const activeLibrary = activeLibraryName ? libraries[activeLibraryName] : undefined
  const libraryPath = overrides.libraryPath ?? activeLibrary?.path ?? 'Downloaded Library'
  const effectiveConfig = {
    layout: activeLibrary?.layout ?? 'bundle',
    platformInclude: normalizeValues(overrides.platformInclude) ?? activeLibrary?.platformInclude,
    extInclude: normalizeValues(overrides.extInclude) ?? activeLibrary?.extInclude,
    extExclude: normalizeValues(overrides.extExclude) ?? activeLibrary?.extExclude,
    formatPriority:
      normalizeValues(overrides.formatPriority) ??
      activeLibrary?.formatPriority ??
      defaultFormatPriority,
    troveOnly: overrides.troveOnly ?? activeLibrary?.troveOnly ?? false,
    showProgress: overrides.showProgress ?? activeLibrary?.showProgress ?? false,
  }
  const scanLibraries = buildScanLibraries(
    libraryPath,
    effectiveConfig,
    libraries,
    overrides.scanPaths
  )
  const routes = normalizeRoutes(overrides.routes, libraries)

  return {
    configPath: overrides.configPath,
    mediaRoot: overrides.mediaRoot,
    libraryName: activeLibraryName,
    hasConfiguredLibraries,
    routes,
    cookieFile: overrides.cookieFile,
    sessionAuth: overrides.sessionAuth,
    libraryPath,
    scanPaths: uniqueValues(scanLibraries.map((library) => library.path)),
    scanLibraries,
    cachePath: overrides.cachePath,
    failureReportPath: overrides.failureReportPath,
    metadataPath: overrides.metadataPath,
    troveOnly: effectiveConfig.troveOnly,
    showProgress: effectiveConfig.showProgress,
    updateOnly: overrides.updateOnly ?? false,
    platformInclude: effectiveConfig.platformInclude,
    extInclude: effectiveConfig.extInclude,
    extExclude: effectiveConfig.extExclude,
    formatPriority: effectiveConfig.formatPriority,
    purchaseKeys: overrides.purchaseKeys,
    offlineAudit: overrides.offlineAudit ?? false,
  }
}
