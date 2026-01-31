#!/usr/bin/env bun
import { Command } from 'commander'

import { registerAuditCommand } from './commands/audit'
import { registerDownloadCommand } from './commands/download'
import { registerPdf2CbzCommand } from './pdf2cbz'

const program = new Command()

/**
 * Primary CLI entrypoint that wires configuration, session creation, API client setup,
 * and download orchestration. This mirrors the Python CLI flow while providing a
 * Bun-based TypeScript implementation scaffold.
 */
function configureCli(): void {
  registerDownloadCommand(program)
  registerAuditCommand(program)
  registerPdf2CbzCommand(program)
}

configureCli()
program.parse()
