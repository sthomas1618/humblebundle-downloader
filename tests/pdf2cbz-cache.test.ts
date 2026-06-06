import { describe, expect, it } from 'bun:test'

import {
  shouldRegeneratePdfCbz,
  shouldSkipFailedPdfCbz,
  type PdfCbzCacheEntry,
} from '../src/download/cache'

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

  it('skips legacy entries when PDF stats match and the CBZ exists', () => {
    const shouldRegen = shouldRegeneratePdfCbz(baseEntry, { mtimeMs: 1234, size: 4567 }, false, {
      mtimeMs: 99,
      size: 100,
    })
    expect(shouldRegen).toBe(false)
  })

  it('regenerates generated entries without page validation metadata', () => {
    const shouldRegen = shouldRegeneratePdfCbz(
      { ...baseEntry, transformStatus: 'generated' },
      { mtimeMs: 1234, size: 4567 },
      false,
      { mtimeMs: 99, size: 100 }
    )
    expect(shouldRegen).toBe(true)
  })

  it('regenerates generated entries with mismatched page and image counts', () => {
    const shouldRegen = shouldRegeneratePdfCbz(
      { ...baseEntry, transformStatus: 'generated', pageCount: 10, imageCount: 20 },
      { mtimeMs: 1234, size: 4567 },
      false,
      { mtimeMs: 99, size: 100 }
    )
    expect(shouldRegen).toBe(true)
  })

  it('regenerates when PDF stats match but the CBZ is missing', () => {
    const shouldRegen = shouldRegeneratePdfCbz(baseEntry, { mtimeMs: 1234, size: 4567 }, false)
    expect(shouldRegen).toBe(true)
  })

  it('regenerates when forced even if stats match', () => {
    const shouldRegen = shouldRegeneratePdfCbz(baseEntry, { mtimeMs: 1234, size: 4567 }, true)
    expect(shouldRegen).toBe(true)
  })

  it('regenerates when a manifest entry has missing or stale CBZ stats', () => {
    const entry: PdfCbzCacheEntry = {
      ...baseEntry,
      cbzMtimeMs: 111,
      cbzSize: 222,
    }

    expect(shouldRegeneratePdfCbz(entry, { mtimeMs: 1234, size: 4567 }, false)).toBe(true)
    expect(
      shouldRegeneratePdfCbz(entry, { mtimeMs: 1234, size: 4567 }, false, {
        mtimeMs: 111,
        size: 999,
      })
    ).toBe(true)
    expect(
      shouldRegeneratePdfCbz(entry, { mtimeMs: 1234, size: 4567 }, false, {
        mtimeMs: 111,
        size: 222,
      })
    ).toBe(false)
  })

  it('skips unchanged failed entries unless forced or retried with render fallback', () => {
    const entry: PdfCbzCacheEntry = {
      ...baseEntry,
      transformStatus: 'failed',
      lastFailedMs: 10,
      lastError: 'No embedded images found',
      renderFallbackRequested: false,
    }

    expect(shouldSkipFailedPdfCbz(entry, { mtimeMs: 1234, size: 4567 }, false)).toBe(true)
    expect(shouldSkipFailedPdfCbz(entry, { mtimeMs: 9999, size: 4567 }, false)).toBe(false)
    expect(shouldSkipFailedPdfCbz(entry, { mtimeMs: 1234, size: 4567 }, true)).toBe(false)
    expect(shouldSkipFailedPdfCbz(entry, { mtimeMs: 1234, size: 4567 }, false, true)).toBe(false)
  })
})
