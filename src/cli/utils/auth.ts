import type { Command } from 'commander'

type AuthOptions = {
  cookieFile?: string
  sessionAuth?: string
}

export function validateAuth(program: Command, options: AuthOptions): void {
  if (options.cookieFile && options.sessionAuth) {
    program.error('Provide either --cookie-file or --session-auth, not both.')
  }
  if (!options.cookieFile && !options.sessionAuth) {
    program.error('Either --cookie-file or --session-auth is required.')
  }
}
