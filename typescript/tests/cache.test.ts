import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadCache, saveCache } from '../src/download/cache'

describe('cache helpers', () => {
  it('saves and loads cache data', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'hbd-cache-'))
    const cacheData = {
      'order:file.txt': {
        urlLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
        md5: 'abc123',
      },
    }

    try {
      await saveCache(tempDir, cacheData)
      const loaded = await loadCache(tempDir)
      expect(loaded).toEqual(cacheData)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('returns empty cache when file is missing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'hbd-cache-missing-'))

    try {
      const loaded = await loadCache(tempDir)
      expect(loaded).toEqual({})
      const cacheFile = await readFile(join(tempDir, '.cache.json')).catch(() => null)
      expect(cacheFile).toBeNull()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
