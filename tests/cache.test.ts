import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadCache, saveCache } from '../src/download/cache'

describe('cache helpers', () => {
  it('saves and loads cache data', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cache-'))
    const cacheData = {
      'order:file.txt': {
        urlLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
        md5: 'abc123',
      },
    }

    try {
      await saveCache(temporaryDirectory, cacheData)
      const loaded = await loadCache(temporaryDirectory)
      expect(loaded).toEqual(cacheData)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('returns empty cache when file is missing', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-cache-missing-'))

    try {
      const loaded = await loadCache(temporaryDirectory)
      expect(loaded).toEqual({})
      let cacheFile: Buffer | undefined
      try {
        cacheFile = await readFile(path.join(temporaryDirectory, '.cache.json'))
      } catch {
        // Ignore missing cache file.
      }
      expect(cacheFile).toBeUndefined()
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
