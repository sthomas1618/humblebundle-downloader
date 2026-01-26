import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { downloadQueue } from '../src/download/downloader'

describe('downloadQueue', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('retries failed downloads and writes the file', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-download-'))
    const destination = path.join(temporaryDirectory, 'file.txt')
    let callCount = 0

    globalThis.fetch = async () => {
      callCount += 1
      if (callCount === 1) {
        return new Response('nope', { status: 500 })
      }
      return new Response('hello')
    }

    try {
      const results = await downloadQueue(
        [
          {
            url: 'https://example.com/file.txt',
            destination,
            label: 'file.txt',
          },
        ],
        false
      )

      expect(results).toHaveLength(1)
      expect(results[0]?.attempts).toBe(2)
      expect(results[0]?.bytesWritten).toBe(5)

      const contents = await readFile(destination, 'utf8')
      expect(contents).toBe('hello')
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })
})
