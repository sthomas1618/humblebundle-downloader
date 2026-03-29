import { describe, expect, it } from 'bun:test'

import { commandExists, runCommand } from '../src/utils/command'

describe('command utilities', () => {
  const knownCommand = process.platform === 'win32' ? 'where.exe' : 'sh'

  it('runs commands and resolves on success', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'process.exit(0)'], 'ignore')
    ).resolves.toBeUndefined()
  })

  it('rejects when command exits non-zero', async () => {
    await expect(runCommand(process.execPath, ['-e', 'process.exit(2)'], 'ignore')).rejects.toThrow(
      'exit code 2'
    )
  })

  it('detects existing commands', async () => {
    await expect(commandExists(knownCommand)).resolves.toBe(true)
  })

  it('returns false for missing commands', async () => {
    await expect(commandExists('hbd_missing_command_12345')).resolves.toBe(false)
  })
})
