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

  applyCommonOptions(auditCommand, { includeOffline: true })
  auditCommand.action(async (options: AuditOptions) => {
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

    await auditLibrary({
      client,
      config,
    })
  })
}
