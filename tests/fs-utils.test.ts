import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import {
  buildProductFolder,
  buildTroveFolder,
  cleanName,
  ensureDirectory,
  hasSimilarTitle,
} from '../src/utils/fs'

describe('fs utils', () => {
  it('cleans names using Python-aligned normalization', () => {
    expect(cleanName('Cool: Game+1.')).toBe('Cool - Game_1')
    expect(cleanName('  Weird@@@Name... ')).toBe('WeirdName')
    expect(cleanName('Hello_World-[2024].')).toBe('Hello_World-[2024]')
    expect(cleanName('..Leading/Trailing...')).toBe('..LeadingTrailing')
  })

  it('builds product folder paths', () => {
    const folder = buildProductFolder('/downloads', 'Bundle:Name', 'Product+1')

    expect(folder).toBe(path.join('/downloads', 'Bundle -Name', 'Product_1'))
  })

  it('matches shortened legacy bundle titles to Humble titles', () => {
    expect(
      hasSimilarTitle(
        'MICROIDS GAMES & COMICS CROSSOVER COLLECTION',
        'Microids: Games & Comics Crossover Collection'
      )
    ).toBe(true)
    expect(
      hasSimilarTitle(
        'FORBIDDEN BOOKS SUPPORTING BANNED BOOKS WEEK 2018',
        'Humble Book Bundle: Forbidden Books supporting Banned Books Week 2018'
      )
    ).toBe(true)
    expect(hasSimilarTitle("BACK TO THE '80S BY IDW", 'Humble Book Bundle: Geek Gals')).toBe(false)
  })

  it('builds trove folder paths', () => {
    const folder = buildTroveFolder('/downloads', 'Trove:Title')

    expect(folder).toBe(path.join('/downloads', 'Humble Trove', 'Trove -Title'))
  })

  it('ensures parent directories exist for file paths', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-fs-test-'))
    const nestedFile = path.join(temporaryRoot, 'nested', 'deeper', 'file.txt')

    try {
      await ensureDirectory(nestedFile)
      const stats = await stat(path.dirname(nestedFile))
      expect(stats.isDirectory()).toBe(true)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})
