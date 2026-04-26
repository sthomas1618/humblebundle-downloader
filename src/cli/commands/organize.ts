import type { Command } from 'commander'

import { organizeLibrary } from '../../organize/organize'
import { resolveCommandConfig } from '../utils/config'
import { applyCommonOptions } from '../utils/options'

type OrganizeOptions = {
  config?: string
  library?: string
  cookieFile?: string
  sessionAuth?: string
  libraryPath?: string
  scanPath?: string[]
  cachePath?: string
  metadataPath?: string
  trove?: boolean
  platform?: string[]
  include?: string[]
  exclude?: string[]
  formatPriority?: string[]
  keys?: string[]
  apply?: boolean
  canonical?: boolean
  flat?: boolean
  reportPath?: string
  json?: boolean
  verbose?: boolean
}

export function registerOrganizeCommand(program: Command): void {
  const organizeCommand = program
    .command('organize')
    .description('Move existing files into the configured library chosen by routing rules')

  applyCommonOptions(organizeCommand, {
    includeFormatPriority: true,
    requireLibraryPath: false,
  })
  organizeCommand
    .option('--apply', 'Move files; omitted by default for a dry run')
    .option('--canonical', 'Also move files already in the right library into canonical folders')
    .option(
      '--flat',
      'Organize products into publisher/series folders and mark applied libraries flat'
    )
    .option('--report-path <path>', 'Write the full organize report to this path')
    .option('--json', 'Print the full organize report as JSON')
    .option('--verbose', 'Print each planned move, missing file, and conflict')
    .action(async () => {
      const options = organizeCommand.optsWithGlobals<OrganizeOptions>()
      const { config } = await resolveCommandConfig(organizeCommand, options)

      try {
        const report = await organizeLibrary({
          config,
          apply: options.apply,
          canonical: options.canonical,
          flat: options.flat,
          reportPath: options.reportPath,
          onProgress: options.json ? undefined : (message) => console.info(message),
        })

        if (options.json) {
          console.info(JSON.stringify(report, undefined, 2))
          return
        }

        if (options.verbose) {
          for (const action of report.actions.filter(
            (action) => action.status !== 'already-correct'
          )) {
            console.info(
              [
                action.status,
                action.filename,
                action.sourcePath ? `from: ${action.sourcePath}` : undefined,
                `to: ${action.destinationPath}`,
                action.reason ? `reason: ${action.reason}` : undefined,
              ]
                .filter(Boolean)
                .join(' | ')
            )
          }
        }

        const summaryParts = [
          options.apply ? 'Organize complete.' : 'Organize dry run complete.',
          `Orders: ${report.ordersProcessed}.`,
          `Products: ${report.productsProcessed}.`,
          `Selected: ${report.selectedCandidates}.`,
          `Already correct: ${report.alreadyCorrect}.`,
          `Would move: ${report.wouldMove}.`,
          `Moved: ${report.moved}.`,
          `Missing: ${report.missing}.`,
          `Conflicts: ${report.conflicts}.`,
        ]
        if (report.reportPath) {
          summaryParts.push(`Report: ${report.reportPath}.`)
        }
        console.info(summaryParts.join(' '))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        organizeCommand.error(message, { exitCode: 1 })
      }
    })
}
