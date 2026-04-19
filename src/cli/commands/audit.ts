import type { Command } from 'commander'

import { createClient } from '../../api/client'
import { createSession } from '../../auth/session'
import { auditLibrary } from '../../download/downloader'
import { validateAuth } from '../utils/auth'
import { resolveCommandConfig } from '../utils/config'
import { applyCommonOptions } from '../utils/options'

type AuditOptions = {
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
  offline?: boolean
}

export function registerAuditCommand(program: Command): void {
  const auditCommand = program
    .command('audit')
    .description('Rebuild the cache from existing files without downloading')

  applyCommonOptions(auditCommand, {
    includeFormatPriority: true,
    includeOffline: true,
    requireLibraryPath: false,
  })
  auditCommand.action(async () => {
    const options = auditCommand.optsWithGlobals<AuditOptions>()

    const { config } = await resolveCommandConfig(auditCommand, options)
    validateAuth(program, options)

    const session = await createSession(config)
    const client = createClient(session)

    const summary = await auditLibrary({
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
    console.info(
      [
        'Audit complete.',
        `Orders: ${summary.ordersProcessed}/${summary.purchaseKeys}.`,
        `Products: ${summary.productsProcessed}.`,
        `Candidates: ${summary.candidatesConsidered}.`,
        `Selected: ${summary.selectedCandidates}.`,
        `Matched: ${summary.matchedFiles}.`,
        `Cache entries: ${summary.cacheEntries}.`,
        `Metadata orders: ${summary.metadataOrders}.`,
      ].join(' ')
    )
  })
}
