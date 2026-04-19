import type { Command } from 'commander'

type CommonOptions = {
  includeUpdate?: boolean
  includeProgress?: boolean
  includeOffline?: boolean
  includeFormatPriority?: boolean
  requireLibraryPath?: boolean
}

export function applyCommonOptions(command: Command, options: CommonOptions): void {
  const {
    includeUpdate = false,
    includeProgress = false,
    includeOffline = false,
    includeFormatPriority = false,
    requireLibraryPath = true,
  } = options
  command.option('--config <path>', 'Path to .hbd/config.json')
  command.option('--library <name>', 'Configured library to use as the download destination')
  command.option('-c, --cookie-file <path>', 'Path to cookies.txt')
  command.option(
    '-s, --session-auth <value>',
    'Value of the cookie _simpleauth_sess (wrap in quotes)'
  )
  if (requireLibraryPath) {
    command.requiredOption('-l, --library-path <path>', 'Download directory')
  } else {
    command.option('-l, --library-path <path>', 'Download directory')
  }
  command.option('-t, --trove', 'Only check and download Humble Trove content')
  command.option(
    '--scan-path <path...>',
    'Additional directory roots to scan for existing downloads before downloading'
  )
  command.option('--cache-path <path>', 'Cache file path (defaults to <library-path>/.cache.json)')
  command.option(
    '--metadata-path <path>',
    'Metadata snapshot file path (defaults to <library-path>/.metadata.json)'
  )
  if (includeUpdate) {
    command.option('-u, --update', 'Check for updates (still download new products)')
  }
  command.option('-p, --platform <platform...>', 'Only get content for specific platforms')
  if (includeProgress) {
    command.option('--progress', 'Show per-item progress')
  }
  command.option('-e, --exclude <ext...>', 'File extensions to ignore when downloading')
  command.option('-i, --include <ext...>', 'Only download files with these extensions')
  command.option('-k, --keys <key...>', 'Purchase download keys to include')
  if (includeFormatPriority) {
    command.option(
      '--format-priority <ext...>',
      'Preferred file extensions in priority order; if none are available, download all files for the product'
    )
  }
  if (includeOffline) {
    command.option(
      '--offline',
      'Skip per-file HEAD metadata checks during audit; Humble library auth is still required'
    )
  }
}
