import { describe, expect, it } from 'bun:test'

import { resolveConfig } from '../src/config'
import { shouldDownloadExtension, shouldDownloadPlatform } from '../src/download/downloader'

describe('download filters', () => {
  it('allows all platforms when no filter is set', () => {
    const config = resolveConfig({})
    expect(shouldDownloadPlatform('windows', config)).toBe(true)
  })

  it('treats platform filter as case-insensitive and supports all', () => {
    const config = resolveConfig({ platformInclude: ['All'] })
    expect(shouldDownloadPlatform('linux', config)).toBe(true)
  })

  it('filters extensions by include list', () => {
    const config = resolveConfig({ extInclude: ['pdf'] })
    expect(shouldDownloadExtension('file.pdf', config)).toBe(true)
    expect(shouldDownloadExtension('file.zip', config)).toBe(false)
  })

  it('filters extensions by exclude list', () => {
    const config = resolveConfig({ extExclude: ['zip'] })
    expect(shouldDownloadExtension('file.zip', config)).toBe(false)
    expect(shouldDownloadExtension('file.pdf', config)).toBe(true)
  })
})
