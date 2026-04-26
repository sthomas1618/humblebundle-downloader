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
      flatIndex: {
        version: 1,
        entries: {
          'flat:books:book:file.txt': {
            flatCacheKey: 'flat:books:book:file.txt',
            canonicalPath: path.join(temporaryDirectory, 'Publisher', 'Book', 'file.txt'),
            libraryName: 'books',
            libraryPath: temporaryDirectory,
            publisher: 'Publisher',
            series: 'Book',
            productKey: 'book',
            productTitle: 'Book',
            filename: 'file.txt',
            bundleLocations: [
              {
                cacheKey: 'order:file.txt',
                orderId: 'order',
                bundleTitle: 'Bundle by Publisher',
                productTitle: 'Book',
                bundlePath: path.join(
                  temporaryDirectory,
                  'Bundle by Publisher',
                  'Book',
                  'file.txt'
                ),
              },
            ],
          },
        },
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
