import type { Command } from 'commander'

import { createClient } from '../../api/client'
import { createSession } from '../../auth/session'
import { downloadLibrary } from '../../download/downloader'
import { validateAuth } from '../utils/auth'
import { resolveCommandConfig } from '../utils/config'
import { applyCommonOptions } from '../utils/options'

type DownloadOptions = {
  config?: string
  library?: string
  cookieFile?: string
  sessionAuth?: string
  libraryPath?: string
  scanPath?: string[]
  cachePath?: string
  metadataPath?: string
  trove?: boolean
  update?: boolean
  platform?: string[]
  progress?: boolean
  include?: string[]
  exclude?: string[]
  formatPriority?: string[]
  keys?: string[]
}

export function registerDownloadCommand(program: Command): void {
  program.name('hbd-ts').description('Bun-based TypeScript port of humblebundle-downloader')

  applyCommonOptions(program, {
    includeUpdate: true,
    includeProgress: true,
    includeFormatPriority: true,
    requireLibraryPath: false,
  })
  program.action(async () => {
    const options = program.optsWithGlobals<DownloadOptions>()

    const { config } = await resolveCommandConfig(program, options)
    validateAuth(program, options)

    const session = await createSession(config)
    const client = createClient(session)

    const summary = await downloadLibrary({
      client,
      config,
      onProgress: (message, options) => {
        if (options?.newline === false) {
          process.stdout.write(message)
          return
        }
        console.info(message)
      },
    })
    const summaryParts = [
      'Download complete.',
      `Orders: ${summary.purchaseKeys}.`,
      `Queued: ${summary.queued}.`,
      `Downloaded: ${summary.downloaded}.`,
      `Skipped: ${summary.skipped}.`,
      `Already present: ${summary.locallySatisfied}.`,
      `Failed: ${summary.failed}.`,
      `Cache entries: ${summary.cacheEntries}.`,
      `Metadata orders: ${summary.metadataOrders}.`,
    ]
    if (summary.failed > 0 && summary.failureReportPath) {
      summaryParts.push(`Failure report: ${summary.failureReportPath}.`)
    }
    console.info(summaryParts.join(' '))
  })
}
