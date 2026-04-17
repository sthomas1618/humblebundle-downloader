import type { Command } from 'commander'

import { createClient } from '../../api/client'
import { createSession } from '../../auth/session'
import { resolveConfig } from '../../config'
import { auditLibrary } from '../../download/downloader'
import { validateAuth } from '../utils/auth'
import { applyCommonOptions } from '../utils/options'

type AuditOptions = {
  cookieFile?: string
  sessionAuth?: string
  libraryPath: string
  trove?: boolean
  platform?: string[]
  include?: string[]
  exclude?: string[]
  keys?: string[]
  offline?: boolean
}

export function registerAuditCommand(program: Command): void {
  const auditCommand = program
    .command('audit')
    .description('Rebuild the cache from existing files without downloading')

  applyCommonOptions(auditCommand, { includeOffline: true, requireLibraryPath: false })
  auditCommand.action(async () => {
    const options = auditCommand.optsWithGlobals<AuditOptions>()

    if (!options.libraryPath) {
      auditCommand.error("required option '-l, --library-path <path>' not specified")
    }

    validateAuth(program, options)

    const config = resolveConfig({
      cookieFile: options.cookieFile,
      sessionAuth: options.sessionAuth,
      libraryPath: options.libraryPath,
      troveOnly: options.trove,
      platformInclude: options.platform,
      extInclude: options.include,
      extExclude: options.exclude,
      purchaseKeys: options.keys,
      offlineAudit: options.offline,
    })

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
      ].join(' ')
    )
  })
}
