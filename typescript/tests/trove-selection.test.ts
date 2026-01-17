import { describe, expect, it } from 'bun:test'

import { buildTroveDownloadItems, type DownloadItem } from '../src/download/downloader'
import { resolveConfig } from '../src/config'

describe('buildTroveDownloadItems', () => {
  it('builds signed trove download items with cache metadata', async () => {
    const config = resolveConfig({
      troveOnly: true,
      libraryPath: '/downloads',
    })

    const products = [
      {
        'human-name': 'My Game',
        downloads: {
          windows: {
            machine_name: 'my-game',
            url: { web: 'https://example.com/game.zip' },
            md5: 'abc123',
            uploaded_at: '123',
          },
        },
      },
    ]

    const signDownload = async () => ({ signed_url: 'https://signed' })
    const items = await buildTroveDownloadItems(products, config, {}, signDownload)

    expect(items).toHaveLength(1)
    const item = items[0] as DownloadItem
    expect(item.url).toBe('https://signed')
    expect(item.label).toBe('game.zip')
    expect(item.cacheKey).toBe('trove:game.zip')
    expect(item.cacheUpdate?.md5).toBe('abc123')
  })
})
