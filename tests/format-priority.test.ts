import { describe, expect, it } from 'bun:test'

import { resolveConfig } from '../src/config'
import {
  selectPreferredDownloadCandidates,
  shouldDownloadExtension,
} from '../src/download/downloader'

describe('format priority selection', () => {
  it('returns all candidates when no priority is set', () => {
    const config = resolveConfig({ formatPriority: [] })
    const candidates = [{ filename: 'book.pdf' }, { filename: 'book.epub' }]

    expect(selectPreferredDownloadCandidates(candidates, config)).toEqual(candidates)
  })

  it('selects the first available extension in priority order', () => {
    const config = resolveConfig({ formatPriority: ['cbz', 'epub', 'pdf'] })
    const candidates = [
      { filename: 'book.pdf' },
      { filename: 'book.epub' },
      { filename: 'book-2.epub' },
    ]

    expect(selectPreferredDownloadCandidates(candidates, config)).toEqual([
      { filename: 'book.epub' },
      { filename: 'book-2.epub' },
    ])
  })

  it('falls back to all candidates when no preferred formats exist', () => {
    const config = resolveConfig({ formatPriority: ['cbz', 'mobi'] })
    const candidates = [{ filename: 'book.pdf' }, { filename: 'book.epub' }]

    expect(selectPreferredDownloadCandidates(candidates, config)).toEqual(candidates)
  })

  it('treats priority extensions as case-insensitive', () => {
    const config = resolveConfig({ formatPriority: ['PDF'] })
    const candidates = [{ filename: 'book.pdf' }, { filename: 'book.epub' }]

    expect(selectPreferredDownloadCandidates(candidates, config)).toEqual([
      { filename: 'book.pdf' },
    ])
  })

  it('returns an empty list when no candidates are available', () => {
    const config = resolveConfig({ formatPriority: ['cbz'] })

    expect(selectPreferredDownloadCandidates([], config)).toEqual([])
  })

  it('falls back to included candidates when priority formats are filtered out', () => {
    const config = resolveConfig({ formatPriority: ['cbz'], extInclude: ['pdf'] })
    const candidates = [{ filename: 'book.pdf' }]

    expect(selectPreferredDownloadCandidates(candidates, config)).toEqual([
      { filename: 'book.pdf' },
    ])
  })

  it('keeps multiple files for the selected extension', () => {
    const config = resolveConfig({ formatPriority: ['pdf', 'epub'] })
    const candidates = [
      { filename: 'book-1.pdf' },
      { filename: 'book-2.pdf' },
      { filename: 'book-3.epub' },
    ]

    expect(selectPreferredDownloadCandidates(candidates, config)).toEqual([
      { filename: 'book-1.pdf' },
      { filename: 'book-2.pdf' },
    ])
  })

  it('applies include/exclude filters before format priority selection', () => {
    const config = resolveConfig({ formatPriority: ['epub', 'pdf'], extExclude: ['epub'] })
    const candidates = [{ filename: 'book.epub' }, { filename: 'book.pdf' }]
    const filtered = candidates.filter((candidate) =>
      shouldDownloadExtension(candidate.filename, config)
    )

    expect(selectPreferredDownloadCandidates(filtered, config)).toEqual([{ filename: 'book.pdf' }])
  })
})
