import { readFile } from 'node:fs/promises'

import type { AppConfig } from '../config'

/**
 * Session state derived from configuration. This will later include
 * parsed cookie data and any derived auth tokens.
 */
export type Session = {
  cookieFile?: string
  cookieHeader?: string
}

async function parseCookieFile(cookieFile: string): Promise<string | undefined> {
  const content = await readFile(cookieFile, 'utf8')
  const lines = content.split(/\r?\n/)
  const cookies: string[] = []

  for (const line of lines) {
    if (!line || line.startsWith('#')) {
      continue
    }

    const parts = line.split('\t')
    if (parts.length < 7) {
      continue
    }

    const domain = parts[0]
    const name = parts[5]
    const value = parts[6]
    if (domain && !domain.includes('humblebundle.com')) {
      continue
    }

    if (name && value) {
      cookies.push(`${name}=${value}`)
    }
  }

  if (cookies.length > 0) {
    return cookies.join('; ')
  }

  const trimmed = content.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Create a session object based on the current configuration.
 *
 * @param config - Normalized application configuration.
 */
export async function createSession(config: AppConfig): Promise<Session> {
  const cookieHeader = config.cookieFile
    ? await parseCookieFile(config.cookieFile)
    : config.sessionAuth
      ? `_simpleauth_sess=${config.sessionAuth}`
      : undefined

  return {
    cookieFile: config.cookieFile,
    cookieHeader,
  }
}
