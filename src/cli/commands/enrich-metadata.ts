import type { Command } from 'commander'

import { enrichMetadata } from '../../download/enriched-metadata'
import { resolveCommandConfig } from '../utils/config'

type EnrichMetadataOptions = {
  config?: string
  library?: string
  libraryPath?: string
  scanPath?: string[]
  metadataPath?: string
  enrichedMetadataPath?: string
  json?: boolean
}

export function registerEnrichMetadataCommand(program: Command): void {
  const enrichMetadataCommand = program
    .command('enrich-metadata')
    .description('Scan local EPUB/PDF metadata into the enriched metadata sidecar')

  enrichMetadataCommand
    .option('--config <path>', 'Path to .hbd/config.json')
    .option('--library <name>', 'Configured library to use as the scan context')
    .option('-l, --library-path <path>', 'Library directory')
    .option('--scan-path <path...>', 'Additional directory roots to scan')
    .option(
      '--metadata-path <path>',
      'Metadata snapshot file path (defaults to <library-path>/.metadata.json)'
    )
    .option(
      '--enriched-metadata-path <path>',
      'Enriched metadata sidecar path (defaults to <library-path>/.enriched-metadata.json)'
    )
    .option('--json', 'Print the full enriched metadata report as JSON')
    .action(async () => {
      const options = enrichMetadataCommand.optsWithGlobals<EnrichMetadataOptions>()
      const { config } = await resolveCommandConfig(enrichMetadataCommand, options)

      try {
        const result = await enrichMetadata({
          config,
          outputPath: options.enrichedMetadataPath,
          onProgress: options.json ? undefined : (message) => console.info(message),
        })

        if (options.json) {
          console.info(JSON.stringify(result.metadata, undefined, 2))
          return
        }

        console.info(
          [
            'Enriched metadata complete.',
            `Scanned: ${result.metadata.summary.scanned}.`,
            `Extracted: ${result.metadata.summary.extracted}.`,
            `Skipped: ${result.metadata.summary.skipped}.`,
            `Errors: ${result.metadata.summary.errors}.`,
            `Matched: ${result.metadata.summary.matchedFiles}.`,
            `Unmatched: ${result.metadata.summary.unmatchedFiles}.`,
            `Output: ${result.outputPath}.`,
          ].join(' ')
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        enrichMetadataCommand.error(message, { exitCode: 1 })
      }
    })
}
