import type { Command } from 'commander'

import { createClient } from '../../api/client'
import { createSession } from '../../auth/session'
import { resolveConfig } from '../../config'
import { downloadLibrary } from '../../download/downloader'
import { validateAuth } from '../utils/auth'
import { applyCommonOptions } from '../utils/options'

type DownloadOptions = {
  cookieFile?: string
  sessionAuth?: string
  libraryPath: string
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

  applyCommonOptions(program, { includeUpdate: true, includeProgress: true })
  program.option(
    '--format-priority <ext...>',
    'Preferred file extensions in priority order; if none are available, download all files for the product'
  )
  program.action(async (options: DownloadOptions) => {
    validateAuth(program, options)

    const config = resolveConfig({
      cookieFile: options.cookieFile,
      sessionAuth: options.sessionAuth,
      libraryPath: options.libraryPath,
      troveOnly: options.trove,
      showProgress: options.progress,
      updateOnly: options.update,
      platformInclude: options.platform,
      extInclude: options.include,
      extExclude: options.exclude,
      formatPriority: options.formatPriority,
      purchaseKeys: options.keys,
    })

    const session = await createSession(config)
    const client = createClient(session)

    await downloadLibrary({
      client,
      config,
    })
  })
}
