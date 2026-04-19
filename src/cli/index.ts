#!/usr/bin/env bun
import { Command } from 'commander'

import { registerAuditCommand } from './commands/audit'
import { registerCleanupCommand } from './commands/cleanup'
import { registerConfigCommand } from './commands/config'
import { registerDownloadCommand } from './commands/download'
import { registerDoctorCommand } from './commands/doctor'
import { registerOrganizeCommand } from './commands/organize'
import { registerPdf2CbzCommand } from './commands/pdf2cbz'

const program = new Command()
program.enablePositionalOptions()

/**
 * Primary CLI entrypoint that wires configuration, session creation, API client setup,
 * and download orchestration. This mirrors the Python CLI flow while providing a
 * Bun-based TypeScript implementation scaffold.
 */
function configureCli(): void {
  registerDownloadCommand(program)
  registerAuditCommand(program)
  registerCleanupCommand(program)
  registerConfigCommand(program)
  registerDoctorCommand(program)
  registerOrganizeCommand(program)
  registerPdf2CbzCommand(program)
}

configureCli()
program.parse()
