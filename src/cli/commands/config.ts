import type { Command } from 'commander'

import { createConfigFile, type ConfigInitLibrary } from '../../config'

type ConfigInitOptions = {
  mediaRoot: string
  defaultLibrary: string
  library?: string[]
  cachePath?: string
  failureReportPath?: string
  metadataPath?: string
}

function collectLibrary(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

function parseLibrarySpec(value: string): ConfigInitLibrary {
  const separatorIndex = value.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(`Library must use name:path format: ${value}`)
  }

  return {
    name: value.slice(0, separatorIndex),
    path: value.slice(separatorIndex + 1),
  }
}

export function registerConfigCommand(program: Command): void {
  const configCommand = program.command('config').description('Manage hbd configuration')

  configCommand
    .command('init')
    .description('Create a .hbd/config.json file for a media root')
    .requiredOption('--media-root <path>', 'Media root that will contain .hbd')
    .requiredOption('--default-library <name>', 'Default configured library to download into')
    .option('--library <name:path>', 'Configured library root', collectLibrary)
    .option('--cache-path <path>', 'Cache path written into config')
    .option('--failure-report-path <path>', 'Download failure report path written into config')
    .option('--metadata-path <path>', 'Metadata snapshot path written into config')
    .action(async (options: ConfigInitOptions) => {
      let libraries: ConfigInitLibrary[] = []
      try {
        if (!options.library || options.library.length === 0) {
          configCommand.error("required option '--library <name:path>' not specified", {
            exitCode: 1,
          })
        }
        libraries = (options.library ?? []).map((library) => parseLibrarySpec(library))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        configCommand.error(message, { exitCode: 1 })
      }

      try {
        const result = await createConfigFile({
          mediaRoot: options.mediaRoot,
          defaultLibrary: options.defaultLibrary,
          libraries,
          cachePath: options.cachePath,
          failureReportPath: options.failureReportPath,
          metadataPath: options.metadataPath,
        })

        console.info(`Created config: ${result.configPath}`)
        console.info(`Run hbd from inside ${result.mediaRoot} to auto-discover this config.`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        configCommand.error(message, { exitCode: 1 })
      }
    })
}
