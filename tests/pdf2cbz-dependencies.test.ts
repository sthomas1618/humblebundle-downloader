import { describe, expect, it } from 'bun:test'

import { assertPdf2CbzDependencies } from '../src/cli/pdf2cbz-dependencies'

describe('pdf2cbz dependency checks', () => {
  it('does not require Poppler tools for archive-only mode', async () => {
    const command = {
      error(message: string): never {
        throw new Error(message)
      },
    }

    await expect(
      assertPdf2CbzDependencies({ archiveMode: 'only' }, command as never)
    ).resolves.toBeUndefined()
  })
})
