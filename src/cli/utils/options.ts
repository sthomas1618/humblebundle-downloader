import type { Command } from 'commander'

type CommonOptions = {
  includeUpdate?: boolean
  includeProgress?: boolean
  includeOffline?: boolean
}

export function applyCommonOptions(command: Command, options: CommonOptions): void {
  const { includeUpdate = false, includeProgress = false, includeOffline = false } = options
  command.option('-c, --cookie-file <path>', 'Path to cookies.txt')
  command.option(
    '-s, --session-auth <value>',
    'Value of the cookie _simpleauth_sess (wrap in quotes)'
  )
  command.requiredOption('-l, --library-path <path>', 'Download directory')
  command.option('-t, --trove', 'Only check and download Humble Trove content', false)
  if (includeUpdate) {
    command.option('-u, --update', 'Check for updates (still download new products)', false)
  }
  command.option('-p, --platform <platform...>', 'Only get content for specific platforms')
  if (includeProgress) {
    command.option('--progress', 'Show per-item progress', false)
  }
  command.option('-e, --exclude <ext...>', 'File extensions to ignore when downloading')
  command.option('-i, --include <ext...>', 'Only download files with these extensions')
  command.option('-k, --keys <key...>', 'Purchase download keys to include')
  if (includeOffline) {
    command.option('--offline', 'Skip remote metadata lookups when auditing', false)
  }
}
