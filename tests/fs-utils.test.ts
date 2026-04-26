import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import {
  buildProductFolder,
  buildTroveFolder,
  cleanName,
  comparableTitle,
  ensureDirectory,
  findExistingPublisherFolders,
  hasSimilarTitle,
  inferPublisherFolder,
  inferSeriesFolder,
  normalizePublisherFamilyKey,
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
    expect(inferSeriesFolder('Locke & Key, Vol 6')).toBe('Locke  Key')
  })

  it('infers publisher folders without hardcoded aliases', () => {
    expect(inferPublisherFolder('Humble Comics Bundle: Star Trek 2019 by IDW Publishing')).toBe(
      'IDW Publishing'
    )
    expect(inferPublisherFolder('Humble Manga Bundle: Fantasy by Kodansha Comics')).toBe(
      'Kodansha Comics'
    )
    expect(inferPublisherFolder('Microids: Games & Comics Crossover Collection')).toBe('Microids')
    expect(inferPublisherFolder('No Starch Press: Python and Security')).toBe('No Starch Press')
    expect(inferPublisherFolder('Humble Book Bundle: Python and Security')).toBe('humble')
  })

  it('groups publisher variants by normalized family suffixes', () => {
    expect(normalizePublisherFamilyKey('IDW Publishing')).toBe(normalizePublisherFamilyKey('IDW'))
    expect(normalizePublisherFamilyKey('Kodansha Comics')).toBe(
      normalizePublisherFamilyKey('Kodansha')
    )
    expect(normalizePublisherFamilyKey('Image Comics')).toBe(normalizePublisherFamilyKey('Image'))
    expect(normalizePublisherFamilyKey('IDW 25th Anniversary Megabundle')).toBe(
      normalizePublisherFamilyKey('IDW')
    )
  })

  it('prefers existing publisher family folders without named aliases', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-fs-test-'))

    try {
      await ensureDirectory(path.join(temporaryRoot, 'IDW', 'Series', 'book.cbz'))
      await ensureDirectory(path.join(temporaryRoot, 'IDW Publishing', 'Series', 'book.cbz'))

      await expect(findExistingPublisherFolders(temporaryRoot, 'IDW Publishing')).resolves.toEqual([
        'IDW',
        'IDW Publishing',
      ])
      await expect(findExistingPublisherFolders(temporaryRoot, 'IDW')).resolves.toEqual([
        'IDW',
        'IDW Publishing',
      ])
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
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

  it('normalizes special characters and extra whitespace for title comparison', () => {
    expect(comparableTitle("HIRO MASHIMA'S FAIRY TAIL & MORE BY KODANSHA")).toBe(
      comparableTitle('Humble Manga Bundle - Hiro Mashimas Fairy Tail  More by Kodansha')
    )
    expect(
      hasSimilarTitle(
        "HIRO MASHIMA'S FAIRY TAIL & MORE BY KODANSHA",
        'Humble Manga Bundle - Hiro Mashimas Fairy Tail  More by Kodansha'
      )
    ).toBe(true)
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
