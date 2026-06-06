import { describe, expect, it } from 'bun:test'

import { resolveConfig } from '../src/config'

describe('resolveConfig', () => {
  it('returns defaults when no overrides are provided', () => {
    const config = resolveConfig({})

    expect(config).toMatchObject({
      cookieFile: undefined,
      sessionAuth: undefined,
      libraryPath: 'Downloaded Library',
      scanPaths: ['Downloaded Library'],
      scanLibraries: [
        {
          path: 'Downloaded Library',
          layout: 'bundle',
          formatPriority: ['cbz', 'epub', 'pdf', 'mobi'],
        },
      ],
      cachePath: undefined,
      failureReportPath: undefined,
      metadataPath: undefined,
      enrichedMetadataPath: undefined,
      flatConflictResolution: undefined,
      transform: {
        trackLocalProducts: true,
        archiveLocalProducts: true,
        pdf2cbzConcurrency: 2,
        pdf2cbzArchiveMode: 'after',
      },
      hasConfiguredLibraries: false,
      routes: [],
      troveOnly: false,
      showProgress: false,
      updateOnly: false,
      platformInclude: undefined,
      extInclude: undefined,
      extExclude: undefined,
      formatPriority: ['cbz', 'epub', 'pdf', 'mobi'],
      purchaseKeys: undefined,
      offlineAudit: false,
    })
  })

  it('applies provided overrides', () => {
    const config = resolveConfig({
      cookieFile: 'cookies.txt',
      sessionAuth: 'session-value',
      libraryPath: 'My Library',
      scanPaths: ['My Library', 'Existing Library'],
      cachePath: 'shared-cache.json',
      metadataPath: 'metadata.json',
      enrichedMetadataPath: 'enriched.json',
      archiveRoot: 'Archive',
      layout: 'flat',
      flatConflictResolution: 'prefer-known-md5-then-largest',
      troveOnly: true,
      showProgress: true,
      updateOnly: true,
      platformInclude: ['ebook', 'video'],
      extInclude: ['pdf', 'mobi'],
      extExclude: ['zip'],
      formatPriority: ['cbz', 'epub'],
      archiveFormats: ['PDF', 'EPUB'],
      purchaseKeys: ['key1', 'key2'],
      offlineAudit: true,
      transform: {
        trackLocalProducts: false,
        archiveLocalProducts: true,
        pdf2cbzConcurrency: 4,
        pdf2cbzArchiveMode: 'skip',
      },
    })

    expect(config).toMatchObject({
      cookieFile: 'cookies.txt',
      sessionAuth: 'session-value',
      libraryPath: 'My Library',
      scanPaths: ['My Library', 'Existing Library'],
      scanLibraries: [
        {
          path: 'My Library',
          layout: 'flat',
          formatPriority: ['cbz', 'epub'],
        },
        {
          path: 'Existing Library',
          layout: 'flat',
          formatPriority: ['cbz', 'epub'],
        },
      ],
      cachePath: 'shared-cache.json',
      failureReportPath: undefined,
      metadataPath: 'metadata.json',
      enrichedMetadataPath: 'enriched.json',
      archiveRoot: 'Archive',
      transform: {
        trackLocalProducts: false,
        archiveLocalProducts: true,
        pdf2cbzConcurrency: 4,
        pdf2cbzArchiveMode: 'skip',
      },
      layout: 'flat',
      flatConflictResolution: 'prefer-known-md5-then-largest',
      hasConfiguredLibraries: false,
      routes: [],
      troveOnly: true,
      showProgress: true,
      updateOnly: true,
      platformInclude: ['ebook', 'video'],
      extInclude: ['pdf', 'mobi'],
      extExclude: ['zip'],
      formatPriority: ['cbz', 'epub'],
      archiveFormats: ['pdf', 'epub'],
      purchaseKeys: ['key1', 'key2'],
      offlineAudit: true,
    })
  })

  it('normalizes filter inputs to lowercase', () => {
    const config = resolveConfig({
      platformInclude: ['Ebook', 'Video'],
      extInclude: ['PDF', 'MOBI'],
      extExclude: ['ZIP'],
      formatPriority: ['CBZ', 'EPUB'],
    })

    expect(config.platformInclude).toEqual(['ebook', 'video'])
    expect(config.extInclude).toEqual(['pdf', 'mobi'])
    expect(config.extExclude).toEqual(['zip'])
    expect(config.formatPriority).toEqual(['cbz', 'epub'])
  })

  it('keeps the library path as the first scan path and removes duplicates', () => {
    const config = resolveConfig({
      libraryPath: 'Library',
      scanPaths: ['Books', 'Library', 'Manga'],
    })

    expect(config.scanPaths).toEqual(['Library', 'Books', 'Manga'])
  })

  it('uses a named library as the active destination and scans all configured libraries', () => {
    const config = resolveConfig({
      defaultLibrary: 'comics',
      libraryName: 'books',
      cachePath: 'cache.json',
      failureReportPath: 'failures.json',
      metadataPath: 'metadata.json',
      enrichedMetadataPath: 'enriched.json',
      routes: [{ extensions: ['epub', 'mobi'], library: 'books' }],
      libraries: {
        comics: {
          path: 'Comics',
          layout: 'flat',
          formatPriority: ['cbz', 'pdf'],
          archiveFormats: ['pdf', 'epub'],
          extInclude: ['cbz', 'pdf'],
        },
        books: {
          path: 'Books',
          formatPriority: ['epub', 'pdf', 'mobi'],
          extInclude: ['epub', 'pdf', 'mobi'],
        },
      },
    })

    expect(config).toMatchObject({
      libraryName: 'books',
      libraryPath: 'Books',
      scanPaths: ['Comics', 'Books'],
      cachePath: 'cache.json',
      failureReportPath: 'failures.json',
      metadataPath: 'metadata.json',
      enrichedMetadataPath: 'enriched.json',
      hasConfiguredLibraries: true,
      routes: [{ extensions: ['epub', 'mobi'], library: 'books' }],
      formatPriority: ['epub', 'pdf', 'mobi'],
      extInclude: ['epub', 'pdf', 'mobi'],
    })
    expect(config.scanLibraries.find((library) => library.name === 'comics')?.layout).toBe('flat')
    expect(
      config.scanLibraries.find((library) => library.name === 'comics')?.archiveFormats
    ).toEqual(['pdf', 'epub'])
    expect(config.scanLibraries.find((library) => library.name === 'books')?.layout).toBe('bundle')
  })

  it('uses root layout as a default while allowing library overrides', () => {
    const config = resolveConfig({
      defaultLibrary: 'comics',
      layout: 'flat',
      libraries: {
        comics: {
          path: 'Comics',
        },
        books: {
          path: 'Books',
          layout: 'bundle',
        },
      },
    })

    expect(config.layout).toBe('flat')
    expect(config.scanLibraries.find((library) => library.name === 'comics')?.layout).toBe('flat')
    expect(config.scanLibraries.find((library) => library.name === 'books')?.layout).toBe('bundle')
  })

  it('lets CLI values override configured library values', () => {
    const config = resolveConfig({
      defaultLibrary: 'comics',
      libraryName: 'comics',
      libraries: {
        comics: {
          path: 'Comics',
          formatPriority: ['cbz', 'pdf'],
          extInclude: ['cbz', 'pdf'],
          showProgress: true,
        },
      },
      formatPriority: ['pdf'],
      extInclude: ['pdf'],
    })

    expect(config.formatPriority).toEqual(['pdf'])
    expect(config.extInclude).toEqual(['pdf'])
    expect(config.showProgress).toBe(true)
  })

  it('rejects routes that reference missing configured libraries', () => {
    expect(() =>
      resolveConfig({
        defaultLibrary: 'comics',
        routes: [{ extensions: ['epub'], library: 'books' }],
        libraries: {
          comics: {
            path: 'Comics',
          },
        },
      })
    ).toThrow('unknown library "books"')
  })
})
