import type { Command } from 'commander'

import { cleanupEmptyDirectories } from '../../cleanup/cleanup'
import { resolveCommandConfig } from '../utils/config'

type CleanupOptions = {
  config?: string
  library?: string
  libraryPath?: string
  scanPath?: string[]
  apply?: boolean
  dedupe?: boolean
  reportPath?: string
  json?: boolean
  verbose?: boolean
}

export function registerCleanupCommand(program: Command): void {
  const cleanupCommand = program
    .command('cleanup')
    .description('Remove empty folders from configured library roots')
    .option('--config <path>', 'Path to .hbd/config.json')
    .option('--library <name>', 'Configured library to use as the active library')
    .option('-l, --library-path <path>', 'Library directory when no config is used')
    .option('--scan-path <path...>', 'Additional directory roots to scan')
    .option('--dedupe', 'Also remove duplicate non-empty top-level folders when safe')
    .option('--apply', 'Remove empty folders; omitted by default for a dry run')
    .option('--report-path <path>', 'Write the full cleanup report to this path')
    .option('--json', 'Print the full cleanup report as JSON')
    .option('--verbose', 'Print each planned or removed directory')
    .action(async () => {
      const options = cleanupCommand.optsWithGlobals<CleanupOptions>()
      const { config } = await resolveCommandConfig(cleanupCommand, options)

      try {
        const report = await cleanupEmptyDirectories({
          config,
          apply: options.apply,
          dedupe: options.dedupe,
          reportPath: options.reportPath,
          onProgress: options.json ? undefined : (message) => console.info(message),
        })

        if (options.json) {
          console.info(JSON.stringify(report, undefined, 2))
          return
        }

        if (options.verbose) {
          for (const action of report.actions) {
            console.info(
              [
                action.status,
                action.kind,
                action.directoryPath,
                action.duplicateOf ? `duplicate of: ${action.duplicateOf}` : undefined,
                action.reason ? `reason: ${action.reason}` : undefined,
              ]
                .filter(Boolean)
                .join(' | ')
            )
          }
        }

        const summaryParts = [
          options.apply ? 'Cleanup complete.' : 'Cleanup dry run complete.',
          `Roots: ${report.rootsScanned}.`,
          `Directories scanned: ${report.directoriesScanned}.`,
          `Would remove: ${report.wouldRemove}.`,
          `Removed: ${report.removed}.`,
          `Skipped: ${report.skipped}.`,
          `Conflicts: ${report.conflicts}.`,
        ]
        if (report.reportPath) {
          summaryParts.push(`Report: ${report.reportPath}.`)
        }
        console.info(summaryParts.join(' '))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        cleanupCommand.error(message, { exitCode: 1 })
      }
    })
}
