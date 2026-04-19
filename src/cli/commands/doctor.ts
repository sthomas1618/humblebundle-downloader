import type { Command } from 'commander'

import { createClient } from '../../api/client'
import { createSession } from '../../auth/session'
import { formatDoctorReport, runDoctor, summarizeDoctor } from '../../doctor/doctor'
import { validateAuth } from '../utils/auth'
import { resolveCommandConfig } from '../utils/config'
import { applyCommonOptions } from '../utils/options'

type DoctorOptions = {
  config?: string
  library?: string
  cookieFile?: string
  sessionAuth?: string
  libraryPath?: string
  scanPath?: string[]
  cachePath?: string
  trove?: boolean
  platform?: string[]
  include?: string[]
  exclude?: string[]
  formatPriority?: string[]
  keys?: string[]
  auth?: boolean
  deep?: boolean
  hash?: boolean
  json?: boolean
  strict?: boolean
  reportPath?: string
}

export function registerDoctorCommand(program: Command): void {
  const doctorCommand = program
    .command('doctor')
    .description('Check config, libraries, cache, routing, and optional Humble auth')

  applyCommonOptions(doctorCommand, {
    includeFormatPriority: true,
    requireLibraryPath: false,
  })
  doctorCommand
    .option('--auth', 'Validate Humble auth and purchase key discovery')
    .option('--deep', 'Fetch Humble metadata and compare selected downloads against cache and disk')
    .option('--hash', 'Hash local files with Humble MD5 metadata during --deep validation')
    .option('--json', 'Print the full doctor report as JSON')
    .option('--strict', 'Exit non-zero when warnings are found')
    .option('--report-path <path>', 'Write the full doctor report to this path')
    .action(async () => {
      const options = doctorCommand.optsWithGlobals<DoctorOptions>()
      const deep = options.deep || options.hash

      const { config } = await resolveCommandConfig(doctorCommand, options)
      if (options.auth || deep) {
        validateAuth(doctorCommand, options)
      }

      const session = options.auth || deep ? await createSession(config) : undefined
      const client = session ? createClient(session) : undefined

      const report = await runDoctor({
        config,
        client,
        auth: options.auth,
        deep,
        hash: options.hash,
        reportPath: options.reportPath,
        onProgress: options.json ? undefined : (message) => console.info(message),
      })

      const summary = summarizeDoctor(report)
      if (options.json) {
        console.info(JSON.stringify(report, undefined, 2))
      } else {
        console.info(formatDoctorReport(report))
      }

      if (summary.failures > 0 || (options.strict && summary.warnings > 0)) {
        process.exitCode = 1
      }
    })
}
