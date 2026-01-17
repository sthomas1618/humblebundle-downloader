import { describe, expect, it } from 'bun:test'

import { resolveConfig } from '../src/config'

describe('resolveConfig', () => {
  it('returns defaults when no overrides are provided', () => {
    const config = resolveConfig({})

    expect(config).toEqual({
      cookieFile: undefined,
      sessionAuth: undefined,
      libraryPath: 'Downloaded Library',
      troveOnly: false,
      showProgress: false,
      updateOnly: false,
      platformInclude: undefined,
      extInclude: undefined,
      extExclude: undefined,
      purchaseKeys: undefined,
      offlineAudit: false,
    })
  })

  it('applies provided overrides', () => {
    const config = resolveConfig({
      cookieFile: 'cookies.txt',
      sessionAuth: 'session-value',
      libraryPath: 'My Library',
      troveOnly: true,
      showProgress: true,
      updateOnly: true,
      platformInclude: ['ebook', 'video'],
      extInclude: ['pdf', 'mobi'],
      extExclude: ['zip'],
      purchaseKeys: ['key1', 'key2'],
      offlineAudit: true,
    })

    expect(config).toEqual({
      cookieFile: 'cookies.txt',
      sessionAuth: 'session-value',
      libraryPath: 'My Library',
      troveOnly: true,
      showProgress: true,
      updateOnly: true,
      platformInclude: ['ebook', 'video'],
      extInclude: ['pdf', 'mobi'],
      extExclude: ['zip'],
      purchaseKeys: ['key1', 'key2'],
      offlineAudit: true,
    })
  })

  it('normalizes filter inputs to lowercase', () => {
    const config = resolveConfig({
      platformInclude: ['Ebook', 'Video'],
      extInclude: ['PDF', 'MOBI'],
      extExclude: ['ZIP'],
    })

    expect(config.platformInclude).toEqual(['ebook', 'video'])
    expect(config.extInclude).toEqual(['pdf', 'mobi'])
    expect(config.extExclude).toEqual(['zip'])
  })
})
