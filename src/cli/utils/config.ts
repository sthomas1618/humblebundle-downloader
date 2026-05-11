import type { Command } from 'commander'

import {
  definedConfigOverrides,
  loadConfigFromSources,
  resolveConfig,
  type AppConfig,
  type ConfigOverrides,
  type LoadedConfigFile,
} from '../../config'

export type ConfigurableCommandOptions = {
  config?: string
  library?: string
  cookieFile?: string
  sessionAuth?: string
  libraryPath?: string
  scanPath?: string[]
  cachePath?: string
  metadataPath?: string
  enrichedMetadataPath?: string
  trove?: boolean
  update?: boolean
  platform?: string[]
  progress?: boolean
  include?: string[]
  exclude?: string[]
  formatPriority?: string[]
  keys?: string[]
  offline?: boolean
}

export type ResolvedCommandConfig = {
  config: AppConfig
  loadedConfig?: LoadedConfigFile
}

export async function resolveCommandConfig(
  command: Command,
  options: ConfigurableCommandOptions
): Promise<ResolvedCommandConfig> {
  let loadedConfig: LoadedConfigFile | undefined
  try {
    loadedConfig = await loadConfigFromSources({
      configPath: options.config,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    command.error(message, { exitCode: 1 })
  }

  if (!loadedConfig && !options.libraryPath) {
    command.error("required option '-l, --library-path <path>' not specified", { exitCode: 1 })
  }

  const cliOverrides = definedConfigOverrides({
    cookieFile: options.cookieFile,
    sessionAuth: options.sessionAuth,
    libraryName: options.library,
    libraryPath: options.libraryPath,
    scanPaths: options.scanPath,
    cachePath: options.cachePath,
    metadataPath: options.metadataPath,
    enrichedMetadataPath: options.enrichedMetadataPath,
    troveOnly: options.trove,
    showProgress: options.progress,
    updateOnly: options.update,
    platformInclude: options.platform,
    extInclude: options.include,
    extExclude: options.exclude,
    formatPriority: options.formatPriority,
    purchaseKeys: options.keys,
    offlineAudit: options.offline,
  } satisfies ConfigOverrides)

  try {
    return {
      config: resolveConfig({
        ...loadedConfig?.overrides,
        ...cliOverrides,
      }),
      loadedConfig,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    command.error(message, { exitCode: 1 })
  }
}
