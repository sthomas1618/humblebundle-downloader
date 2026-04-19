import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  createConfigFile,
  discoverConfigPath,
  loadConfigFile,
  loadConfigFromSources,
} from '../src/config'

async function withTemporaryDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'hbd-config-'))
  try {
    return await callback(temporaryDirectory)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

async function writeConfig(directory: string, data: unknown): Promise<string> {
  const appHome = path.join(directory, '.hbd')
  await mkdir(appHome, { recursive: true })
  const configPath = path.join(appHome, 'config.json')
  await writeFile(configPath, JSON.stringify(data, undefined, 2))
  return configPath
}

describe('config file loading', () => {
  it('loads valid v1 config and resolves paths against the media root', async () => {
    await withTemporaryDirectory(async (mediaRoot) => {
      const configPath = await writeConfig(mediaRoot, {
        version: 1,
        defaultLibrary: 'comics',
        cachePath: '.hbd/cache.json',
        failureReportPath: '.hbd/download-failures.json',
        metadataPath: '.hbd/metadata.json',
        routes: [{ extensions: ['EPUB', 'MOBI'], library: 'books' }],
        libraries: {
          comics: {
            path: 'Comics/comics',
            formatPriority: ['CBZ', 'PDF'],
            extInclude: ['CBZ', 'PDF'],
          },
          books: {
            path: 'Books',
            formatPriority: ['EPUB', 'PDF', 'MOBI'],
            extInclude: ['EPUB', 'PDF', 'MOBI'],
          },
        },
      })

      const loaded = await loadConfigFile(configPath)

      expect(loaded.path).toBe(configPath)
      expect(loaded.mediaRoot).toBe(mediaRoot)
      expect(loaded.overrides).toMatchObject({
        defaultLibrary: 'comics',
        cachePath: path.join(mediaRoot, '.hbd', 'cache.json'),
        failureReportPath: path.join(mediaRoot, '.hbd', 'download-failures.json'),
        metadataPath: path.join(mediaRoot, '.hbd', 'metadata.json'),
        routes: [{ extensions: ['epub', 'mobi'], library: 'books' }],
        libraries: {
          comics: {
            path: path.join(mediaRoot, 'Comics', 'comics'),
            formatPriority: ['cbz', 'pdf'],
            extInclude: ['cbz', 'pdf'],
          },
          books: {
            path: path.join(mediaRoot, 'Books'),
            formatPriority: ['epub', 'pdf', 'mobi'],
            extInclude: ['epub', 'pdf', 'mobi'],
          },
        },
      })
    })
  })

  it('defaults cache and failure report paths into .hbd when omitted', async () => {
    await withTemporaryDirectory(async (mediaRoot) => {
      const configPath = await writeConfig(mediaRoot, {
        version: 1,
        defaultLibrary: 'comics',
        libraries: {
          comics: {
            path: 'Comics',
          },
        },
      })

      const loaded = await loadConfigFile(configPath)

      expect(loaded.overrides.cachePath).toBe(path.join(mediaRoot, '.hbd', 'cache.json'))
      expect(loaded.overrides.failureReportPath).toBe(
        path.join(mediaRoot, '.hbd', 'download-failures.json')
      )
      expect(loaded.overrides.metadataPath).toBe(path.join(mediaRoot, '.hbd', 'metadata.json'))
    })
  })

  it('rejects invalid or unsafe config shapes', async () => {
    await withTemporaryDirectory(async (mediaRoot) => {
      const cases = [
        { version: 2, defaultLibrary: 'comics', libraries: { comics: { path: 'Comics' } } },
        { version: 1, libraries: { comics: { path: 'Comics' } } },
        { version: 1, defaultLibrary: 'comics', libraries: {} },
        {
          version: 1,
          defaultLibrary: 'comics',
          cookieFile: 'cookies.txt',
          libraries: { comics: { path: 'Comics' } },
        },
        {
          version: 1,
          defaultLibrary: 'comics',
          unknown: true,
          libraries: { comics: { path: 'Comics' } },
        },
        {
          version: 1,
          defaultLibrary: 'comics',
          libraries: { comics: { path: 'Comics', sessionAuth: 'secret' } },
        },
        {
          version: 1,
          defaultLibrary: 'comics',
          routes: [{ extensions: ['epub'], library: 'books' }],
          libraries: { comics: { path: 'Comics' } },
        },
        {
          version: 1,
          defaultLibrary: 'comics',
          routes: [{ extensions: [], library: 'comics' }],
          libraries: { comics: { path: 'Comics' } },
        },
        {
          version: 1,
          defaultLibrary: 'comics',
          routes: [{ extensions: ['epub'], library: 'comics', unknown: true }],
          libraries: { comics: { path: 'Comics' } },
        },
      ]

      for (const [index, config] of cases.entries()) {
        const configPath = path.join(mediaRoot, `.hbd-${index}.json`)
        await writeFile(configPath, JSON.stringify(config))
        await expect(loadConfigFile(configPath)).rejects.toThrow()
      }
    })
  })

  it('discovers config by precedence', async () => {
    await withTemporaryDirectory(async (mediaRoot) => {
      const discoveredPath = await writeConfig(mediaRoot, {
        version: 1,
        defaultLibrary: 'auto',
        libraries: { auto: { path: 'Auto' } },
      })
      const environmentDirectory = path.join(mediaRoot, 'EnvRoot')
      const cliDirectory = path.join(mediaRoot, 'CliRoot')
      const nestedDirectory = path.join(mediaRoot, 'Comics', 'Deep')
      await mkdir(nestedDirectory, { recursive: true })
      const environmentPath = await writeConfig(environmentDirectory, {
        version: 1,
        defaultLibrary: 'env',
        libraries: { env: { path: 'Env' } },
      })
      const cliPath = await writeConfig(cliDirectory, {
        version: 1,
        defaultLibrary: 'cli',
        libraries: { cli: { path: 'Cli' } },
      })

      await expect(discoverConfigPath(nestedDirectory)).resolves.toBe(discoveredPath)
      await expect(
        loadConfigFromSources({ envConfigPath: environmentPath, cwd: nestedDirectory })
      ).resolves.toMatchObject({
        path: environmentPath,
      })
      await expect(
        loadConfigFromSources({
          configPath: cliPath,
          envConfigPath: environmentPath,
          cwd: nestedDirectory,
        })
      ).resolves.toMatchObject({
        path: cliPath,
      })
    })
  })
})

describe('config init', () => {
  it('creates .hbd/config.json with portable paths and default library preferences', async () => {
    await withTemporaryDirectory(async (mediaRoot) => {
      const result = await createConfigFile({
        mediaRoot,
        defaultLibrary: 'comics',
        libraries: [
          { name: 'comics', path: path.join(mediaRoot, 'Comics', 'comics') },
          { name: 'books', path: path.join(mediaRoot, 'Books') },
          { name: 'manga', path: 'Manga' },
        ],
      })

      const config = JSON.parse(await readFile(result.configPath, 'utf8')) as Record<
        string,
        unknown
      >

      expect(result.configPath).toBe(path.join(mediaRoot, '.hbd', 'config.json'))
      expect(config).toEqual({
        version: 1,
        defaultLibrary: 'comics',
        cachePath: '.hbd/cache.json',
        failureReportPath: '.hbd/download-failures.json',
        metadataPath: '.hbd/metadata.json',
        routes: [
          {
            id: 'manga-bundles',
            library: 'manga',
            bundleTitlePatterns: [String.raw`\bmanga\s+bundle\b`],
          },
          {
            id: 'comic-bundles',
            library: 'comics',
            bundleTitlePatterns: [
              String.raw`\bcomics?\s+bundle\b`,
              String.raw`\bgames?\s+(?:&|and)\s+comics?\s+crossover\s+collection\b`,
            ],
          },
          {
            id: 'comic-formats',
            library: 'comics',
            extensions: ['cbz'],
          },
          {
            id: 'book-bundles',
            library: 'books',
            bundleTitlePatterns: [
              String.raw`\b(?:book bundle|ebooks?|e-books?|novels?|writing bundle|nanowrimo)\b`,
            ],
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
          comics: {
            path: 'Comics/comics',
            formatPriority: ['cbz', 'pdf', 'epub', 'mobi'],
            extInclude: ['cbz', 'pdf', 'epub', 'mobi'],
          },
          books: {
            path: 'Books',
            formatPriority: ['epub', 'pdf', 'mobi'],
            extInclude: ['epub', 'pdf', 'mobi'],
          },
          manga: {
            path: 'Manga',
            formatPriority: ['cbz', 'pdf', 'epub', 'mobi'],
            extInclude: ['cbz', 'pdf', 'epub', 'mobi'],
          },
        },
      })
    })
  })

  it('refuses to overwrite an existing config', async () => {
    await withTemporaryDirectory(async (mediaRoot) => {
      const options = {
        mediaRoot,
        defaultLibrary: 'comics',
        libraries: [{ name: 'comics', path: 'Comics' }],
      }

      await createConfigFile(options)
      await expect(createConfigFile(options)).rejects.toThrow('already exists')
    })
  })
})
