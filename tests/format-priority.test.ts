import { describe, expect, it } from 'bun:test'

import { resolveConfig } from '../src/config'
import {
  buildPublisherMediaScores,
  publisherMediaScoreKey,
  selectPreferredDownloadCandidates,
  selectRoutedDownloadCandidates,
  shouldDownloadExtension,
} from '../src/download/downloader'

function mediaRoutingConfig() {
  return resolveConfig({
    defaultLibrary: 'books',
    routes: [
      {
        id: 'manga-bundles',
        library: 'manga',
        bundleTitlePatterns: [String.raw`\bmanga\s+bundle\b`],
      },
      {
        id: 'comic-bundles',
        library: 'comics',
        bundleTitlePatterns: [String.raw`\bcomics?\s+bundle\b`],
      },
      {
        id: 'comic-formats',
        library: 'comics',
        extensions: ['cbz'],
      },
      {
        id: 'book-bundles',
        library: 'books',
        bundleTitlePatterns: [String.raw`\b(?:book bundle|ebooks?|e-books?|novels?)\b`],
      },
      {
        id: 'manga-products',
        library: 'manga',
        productTitlePatterns: [String.raw`\bmanga\b`],
        filenamePatterns: [String.raw`\bmanga\b`],
      },
      {
        id: 'comic-products',
        library: 'comics',
        productTitlePatterns: [String.raw`\b(?:comic|comics)\b`],
        filenamePatterns: [String.raw`\b(?:comic|comics)\b`],
      },
      {
        id: 'book-products',
        library: 'books',
        productTitlePatterns: [String.raw`\b(?:book|ebook|e-book|novel|guide|author)\b`],
        filenamePatterns: [String.raw`\b(?:book|ebook|e-book|novel|guide)\b`],
      },
      {
        id: 'ebook-formats',
        library: 'books',
        extensions: ['epub', 'mobi'],
      },
    ],
    libraries: {
      books: {
        path: 'Books',
        formatPriority: ['epub', 'pdf', 'mobi'],
        extInclude: ['epub', 'pdf', 'mobi'],
      },
      comics: {
        path: 'Comics',
        formatPriority: ['cbz', 'pdf', 'epub', 'mobi'],
        extInclude: ['cbz', 'pdf', 'epub', 'mobi'],
      },
      manga: {
        path: 'Manga',
        formatPriority: ['cbz', 'pdf', 'epub', 'mobi'],
        extInclude: ['cbz', 'pdf', 'epub', 'mobi'],
      },
    },
  })
}

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

describe('heuristic media routing', () => {
  it('routes comic bundle EPUBs to comics even when filename says ebook', () => {
    const [selected] = selectRoutedDownloadCandidates(
      [
        {
          filename: 'clue_graphicnovel_ebook.epub',
          platform: 'ebook',
          url: 'https://example.invalid/clue_graphicnovel_ebook.epub',
        },
      ],
      mediaRoutingConfig(),
      {
        bundleTitle: "Humble Comics Bundle: Back to the '80s by Example Publisher",
        productTitle: 'Clue: Graphic Novel',
      }
    )

    expect(selected?.library.name).toBe('comics')
    expect(selected?.routing.mediaClassification?.selected).toBe('comics')
  })

  it('routes graphic novel adaptations in book bundles to comics', () => {
    for (const productTitle of [
      'Kindred: A Graphic Novel Adaptation',
      'Kindred: A Graphic Novel Adaption',
    ]) {
      const [selected] = selectRoutedDownloadCandidates(
        [
          {
            filename: 'kindred_agraphicnoveladaptation.epub',
            platform: 'ebook',
            url: 'https://example.invalid/kindred_agraphicnoveladaptation.epub',
          },
        ],
        mediaRoutingConfig(),
        {
          bundleTitle: 'Humble Book Bundle: Be the Change',
          productTitle,
        }
      )

      expect(selected?.library.name).toBe('comics')
      expect(selected?.routing.mediaClassification?.selected).toBe('comics')
      expect(selected?.routing.mediaClassification?.signals).toContain(
        'comics:graphic-novel-adaptation:16'
      )
      expect(selected?.routing.mediaClassification?.signals).not.toContain(
        'books:bookish-product:2'
      )
    }
  })

  it('routes generic graphic novels in book bundles to comics', () => {
    const [selected] = selectRoutedDownloadCandidates(
      [
        {
          filename: 'example_graphicnovel.epub',
          platform: 'ebook',
          url: 'https://example.invalid/example_graphicnovel.epub',
        },
      ],
      mediaRoutingConfig(),
      {
        bundleTitle: 'Humble Book Bundle: Illustrated Stories',
        productTitle: 'Example Graphic Novel',
      }
    )

    expect(selected?.library.name).toBe('comics')
    expect(selected?.routing.mediaClassification?.signals).toContain('comics:graphic-novel:14')
  })

  it('adds a comic signal for one-shot products', () => {
    const [selected] = selectRoutedDownloadCandidates(
      [
        {
          filename: 'humbleexclusive_armyofdarknessoneshot.epub',
          platform: 'ebook',
          url: 'https://example.invalid/humbleexclusive_armyofdarknessoneshot.epub',
        },
      ],
      mediaRoutingConfig(),
      {
        bundleTitle: 'Stand with Ukraine Bundle',
        productTitle: 'Army of Darkness One-Shot Humble Bundle Exclusive',
      }
    )

    expect(selected?.routing.mediaClassification?.signals).toContain('comics:one-shot:8')
  })

  it('routes comic bundle Book One products to comics', () => {
    const [selected] = selectRoutedDownloadCandidates(
      [
        {
          filename: 'prodigybookone.epub',
          platform: 'ebook',
          url: 'https://example.invalid/prodigybookone.epub',
        },
      ],
      mediaRoutingConfig(),
      {
        bundleTitle: 'Humble Comics Bundle: Streaming Comics from Example Publisher',
        productTitle: 'Prodigy. Book One',
      }
    )

    expect(selected?.library.name).toBe('comics')
  })

  it('routes comic bundle art books to comics by default', () => {
    const [selected] = selectRoutedDownloadCandidates(
      [
        {
          filename: 'vampirella50thanniversaryartbook.epub',
          platform: 'ebook',
          url: 'https://example.invalid/vampirella50thanniversaryartbook.epub',
        },
      ],
      mediaRoutingConfig(),
      {
        bundleTitle:
          'Humble Comics Bundle: Best of Humble Bundle: The Art of Alex Ross by Example Publisher',
        productTitle: 'Vampirella 50th Anniversary Art Book',
      }
    )

    expect(selected?.library.name).toBe('comics')
  })

  it('routes instructional comic drawing products in book bundles to books', () => {
    for (const productTitle of [
      'Drawing Comics Lab',
      'You Can Draw Comic Book Characters',
      'The Art of Comic Book Drawing',
    ]) {
      const [selected] = selectRoutedDownloadCandidates(
        [
          {
            filename: `${productTitle.toLowerCase().replaceAll(/\W+/g, '')}.epub`,
            platform: 'ebook',
            url: 'https://example.invalid/book.epub',
          },
        ],
        mediaRoutingConfig(),
        {
          bundleTitle: 'Humble Book Bundle: Creating Comics, Manga, & Animation by Example House',
          productTitle,
        }
      )

      expect(selected?.library.name).toBe('books')
      expect(selected?.routing.mediaClassification?.selected).toBe('books')
    }
  })

  it('routes manga drawing books in book bundles to books', () => {
    const [selected] = selectRoutedDownloadCandidates(
      [
        {
          filename: 'howtodrawmanga.epub',
          platform: 'ebook',
          url: 'https://example.invalid/howtodrawmanga.epub',
        },
      ],
      mediaRoutingConfig(),
      {
        bundleTitle: 'Humble Book Bundle: Creating Comics, Manga, & Animation by Example House',
        productTitle: 'How to Draw Manga Chibis',
      }
    )

    expect(selected?.library.name).toBe('books')
  })

  it('routes actual manga bundle EPUBs to manga', () => {
    const [selected] = selectRoutedDownloadCandidates(
      [
        {
          filename: 'seriesvolume1.epub',
          platform: 'ebook',
          url: 'https://example.invalid/seriesvolume1.epub',
        },
      ],
      mediaRoutingConfig(),
      {
        bundleTitle: 'Humble Manga Bundle: Example Stories',
        productTitle: 'Example Series Volume 1',
      }
    )

    expect(selected?.library.name).toBe('manga')
  })

  it('uses inferred publisher tendency as a weak non-hardcoded tie-breaker', () => {
    const publisherMediaScores = buildPublisherMediaScores([
      {
        bundleTitle: 'Humble Comics Bundle: Long Run by Fictional Press',
        products: [
          {
            productTitle: 'Space Adventure Issue 1',
            downloads: [
              {
                cacheKey: 'order-1:spaceadventureissue1.pdf',
                filename: 'spaceadventureissue1.pdf',
                extension: 'pdf',
                platform: 'ebook',
              },
            ],
          },
        ],
      },
    ])
    const config = mediaRoutingConfig()
    config.routes.push({
      id: 'ebook-comics',
      library: 'comics',
      extensions: ['epub'],
    })
    const [selected] = selectRoutedDownloadCandidates(
      [
        {
          filename: 'ambiguous.epub',
          platform: 'ebook',
          url: 'https://example.invalid/ambiguous.epub',
        },
      ],
      config,
      {
        bundleTitle: 'Reference Bundle by Fictional Press',
        productTitle: 'Ambiguous',
        publisherMediaScores,
      }
    )

    expect(selected?.library.name).toBe('comics')
    expect(selected?.routing.mediaClassification?.publisher?.folder).toBe('Fictional Press')
    expect(selected?.routing.mediaClassification?.signals).toContain('comics:publisher-tendency:2')
    expect(selected?.routing.mediaClassification?.signals).not.toContain(
      'books:publisher-tendency:2'
    )
    expect(selected?.routing.mediaClassification?.signals).not.toContain(
      'manga:publisher-tendency:2'
    )
  })

  it('does not use publisher tendency when publisher scores are tied', () => {
    const config = mediaRoutingConfig()
    config.routes.push({
      id: 'ebook-comics',
      library: 'comics',
      extensions: ['epub'],
    })
    const [selected] = selectRoutedDownloadCandidates(
      [
        {
          filename: 'ambiguous.epub',
          platform: 'ebook',
          url: 'https://example.invalid/ambiguous.epub',
        },
      ],
      config,
      {
        bundleTitle: 'Reference Bundle by Fictional Press',
        productTitle: 'Ambiguous',
        publisherMediaScores: new Map([
          [
            publisherMediaScoreKey('Reference Bundle by Fictional Press'),
            {
              books: 10,
              comics: 10,
              manga: 0,
            },
          ],
        ]),
      }
    )

    expect(selected?.routing.mediaClassification?.signals).not.toContain(
      'books:publisher-tendency:2'
    )
    expect(selected?.routing.mediaClassification?.signals).not.toContain(
      'comics:publisher-tendency:2'
    )
  })
})
