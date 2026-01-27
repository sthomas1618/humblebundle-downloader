import { describe, expect, it } from 'bun:test'

import { shouldRegeneratePdfCbz, type PdfCbzCacheEntry } from '../src/download/cache'

describe('pdf2cbz cache invalidation', () => {
  const baseEntry: PdfCbzCacheEntry = {
    pdfMtimeMs: 1234,
    pdfSize: 4567,
    cbzPath: '/tmp/test.cbz',
    lastGeneratedMs: 9999,
  }

  it('regenerates when cache entry is missing', () => {
    const shouldRegen = shouldRegeneratePdfCbz(undefined, { mtimeMs: 1, size: 2 }, false)
    expect(shouldRegen).toBe(true)
  })

  it('regenerates when PDF mtime changes', () => {
    const shouldRegen = shouldRegeneratePdfCbz(baseEntry, { mtimeMs: 9999, size: 4567 }, false)
    expect(shouldRegen).toBe(true)
  })

  it('regenerates when PDF size changes', () => {
    const shouldRegen = shouldRegeneratePdfCbz(baseEntry, { mtimeMs: 1234, size: 999 }, false)
    expect(shouldRegen).toBe(true)
  })

  it('skips when PDF stats match and not forced', () => {
    const shouldRegen = shouldRegeneratePdfCbz(baseEntry, { mtimeMs: 1234, size: 4567 }, false)
    expect(shouldRegen).toBe(false)
  })

  it('regenerates when forced even if stats match', () => {
    const shouldRegen = shouldRegeneratePdfCbz(baseEntry, { mtimeMs: 1234, size: 4567 }, true)
    expect(shouldRegen).toBe(true)
  })
})
