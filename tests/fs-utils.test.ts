import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import {
  buildProductFolder,
  buildTroveFolder,
  canonicalPublisherFolderName,
  cleanName,
  cleanPublisherName,
  collectPublisherFolderCandidates,
  comparableTitle,
  ensureDirectory,
  findExistingPublisherFolders,
  hasSimilarTitle,
  inferPublisherFocusedFolder,
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
    expect(cleanName('Taylor & Francis')).toBe('Taylor Francis')
  })

  it('cleans publisher names while preserving meaningful ampersands', () => {
    expect(cleanPublisherName('Simon & Schuster')).toBe('Simon & Schuster')
    expect(cleanPublisherName('CRC Press: Taylor & Francis Group LLC')).toBe(
      'CRC Press - Taylor & Francis Group LLC'
    )
    expect(cleanName('Simon & Schuster')).toBe('Simon Schuster')
  })

  it('builds product folder paths', () => {
    const folder = buildProductFolder('/downloads', 'Bundle:Name', 'Product+1')

    expect(folder).toBe(path.join('/downloads', 'Bundle -Name', 'Product_1'))
    expect(inferSeriesFolder('Locke & Key, Vol 6')).toBe('Locke Key')
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
    expect(
      inferPublisherFolder(
        'Humble Book Bundle: MONOGATARI - Supernatural Light Novels by NISIOISIN from Kodansha'
      )
    ).toBe('Kodansha')
    expect(inferPublisherFolder('Humble Book Bundle: Survival From the Margins by Microcosm')).toBe(
      'Microcosm'
    )
    expect(inferPublisherFolder('Koike by Dark Horse')).toBe('Dark Horse')
    expect(inferPublisherFolder('Bushcraft & Homestead Handbook Series by Adams Media')).toBe(
      'Adams Media'
    )
    expect(inferPublisherFolder('Game Programming by Taylor & Francis')).toBe('Taylor & Francis')
    expect(inferPublisherFolder('Book Bundle by Simon & Schuster')).toBe('Simon & Schuster')
    expect(inferPublisherFolder('Humble Book Bundle: Python and Security')).toBe('humble')
    expect(inferPublisherFolder('Humble Comic Bundle: The Best Year of BOOM! Studios')).toBe(
      'BOOM Studios'
    )
  })

  it('infers conservative curated publisher families from bundle titles', () => {
    expect(inferPublisherFolder("Humble Comic Bundle: Image Comics in the '10s")).toBe(
      'Image Comics'
    )
    expect(inferPublisherFolder('Humble Comics Bundle: Image Expo 2018')).toBe('Image Comics')
    expect(inferPublisherFolder("Humble Comics Bundle: Fresh Ink: IDW's Latest and Greatest")).toBe(
      'IDW'
    )
    expect(inferPublisherFolder('Humble Comics Bundle: Horror With Archie')).toBe('Archie')
    expect(inferPublisherFolder('The Bleeding Heart of Heavy Metal, Vol. 1')).toBe('Heavy Metal')
    expect(inferPublisherFolder("Humble Comic Bundle: HEAVY METAL's Heaviest Metal")).toBe(
      'Heavy Metal'
    )
    expect(
      inferPublisherFolder('Humble Comics Bundle: Humanoids Megabundle Featuring The Incal')
    ).toBe('Humanoids')
    expect(inferPublisherFolder('Humble Book Bundle: Learn to Draw with Walter Foster')).toBe(
      'Walter Foster'
    )
    expect(inferPublisherFolder('Humble Book Bundle: Black+Decker Home How-To Guides')).toBe(
      'Black Decker'
    )
    expect(inferPublisherFolder("Humble Comics Bundle: Dynamite's 15th Anniversary Party")).toBe(
      'Dynamite'
    )
    expect(inferPublisherFolder('Humble Comics Bundle: Titan Comics Showcase')).toBe('Titan')
    expect(inferPublisherFolder('Humble Comics Bundle: Valiant Hero Universe Origins')).toBe(
      'Valiant'
    )
  })

  it('infers publisher names from existing flat publisher folder candidates', () => {
    const candidates = ['Top Cow', 'BOOM', 'Oni Press', 'Titan']

    expect(inferPublisherFolder('Humble Comics Bundle: Top Cow Classics', candidates)).toBe(
      'Top Cow'
    )
    expect(inferPublisherFolder('Humble Comics Bundle: Oni Press Showcase', candidates)).toBe(
      'Oni Press'
    )
    expect(inferPublisherFolder('Humble Comics Bundle: Titan Comics Showcase', candidates)).toBe(
      'Titan'
    )
    expect(
      inferPublisherFolder('Humble Manga Bundle: Attack on Titan Final Season', candidates)
    ).toBe('humble')
  })

  it('collects existing flat publisher folders as candidate names', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-fs-test-'))

    try {
      const comicsPath = path.join(temporaryRoot, 'Comics')
      const booksPath = path.join(temporaryRoot, 'Books')
      await ensureDirectory(path.join(comicsPath, 'Top Cow', 'Series', 'book.cbz'))
      await ensureDirectory(path.join(comicsPath, 'humble', 'Series', 'book.cbz'))
      await ensureDirectory(path.join(comicsPath, 'Mega Bundle', 'Series', 'book.cbz'))
      await ensureDirectory(path.join(booksPath, 'Oni Press', 'Series', 'book.epub'))

      await expect(
        collectPublisherFolderCandidates([
          { path: comicsPath, layout: 'flat' },
          { path: booksPath, layout: 'bundle' },
        ])
      ).resolves.toEqual(['Top Cow'])
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('does not infer publishers from generic bundle families', () => {
    expect(inferPublisherFolder('Humble Book Bundle: Be the Change')).toBe('humble')
    expect(inferPublisherFolder('Humble Comics Bundle: Heroes of Indie Comics')).toBe('humble')
    expect(inferPublisherFolder('Humble Comics Bundle: Start Here!')).toBe('humble')
    expect(inferPublisherFolder('Humble Book Bundle: Tales of Horror')).toBe('humble')
    expect(inferPublisherFolder('Humble Fight for Racial Justice Bundle')).toBe('humble')
    expect(inferPublisherFolder('Humble Manga Bundle: Spring 2021 Anime Season')).toBe('humble')
    expect(inferPublisherFolder('Humble Manga Bundle: Attack on Titan Final Season')).toBe('humble')
    expect(inferPublisherFolder('IDW')).toBe('humble')
    expect(inferPublisherFolder('Black Decker')).toBe('humble')
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
    expect(normalizePublisherFamilyKey('BOOM! Studios')).toBe(normalizePublisherFamilyKey('BOOM'))
    expect(normalizePublisherFamilyKey('BOOM Studios')).toBe(normalizePublisherFamilyKey('BOOM!'))
    expect(normalizePublisherFamilyKey('Packt Publishing Pvt Ltd')).toBe(
      normalizePublisherFamilyKey('Packt')
    )
    expect(normalizePublisherFamilyKey('Packt Publishing Pvt. Ltd')).toBe(
      normalizePublisherFamilyKey('Packt')
    )
    expect(normalizePublisherFamilyKey('The Quarto Group')).toBe(
      normalizePublisherFamilyKey('Quarto')
    )
    expect(normalizePublisherFamilyKey('Titan Books')).toBe(normalizePublisherFamilyKey('Titan'))
    expect(normalizePublisherFamilyKey('Titan Press')).toBe(normalizePublisherFamilyKey('Titan'))
    expect(normalizePublisherFamilyKey('Titan Publishers')).toBe(
      normalizePublisherFamilyKey('Titan')
    )
    expect(normalizePublisherFamilyKey('Kodansha Comics')).toBe(
      normalizePublisherFamilyKey('Kodansha')
    )
  })

  it('canonicalizes publisher folder names with generic cleanup rules', () => {
    expect(canonicalPublisherFolderName('The Quarto Group')).toBe('Quarto')
    expect(canonicalPublisherFolderName('Apress Berkeley CA')).toBe('Apress')
    expect(canonicalPublisherFolderName('Titan Books')).toBe('Titan')
    expect(canonicalPublisherFolderName('Titan Press')).toBe('Titan Press')
    expect(canonicalPublisherFolderName('Titan Publishers')).toBe('Titan')
    expect(canonicalPublisherFolderName('Search Press')).toBe('Search Press')
    expect(canonicalPublisherFolderName('C T Publishing Inc')).toBe('C T Publishing')
    expect(canonicalPublisherFolderName('CRC Press Taylor & Francis Group LLC')).toBe(
      'CRC Press Taylor & Francis Group'
    )
    expect(canonicalPublisherFolderName('Kodansha Comics')).toBe('Kodansha')
  })

  it('infers publisher-focused bundle phrases without named publisher rules', () => {
    expect(inferPublisherFocusedFolder('Humble Comic Bundle: The Best Year of BOOM! Studios')).toBe(
      'BOOM Studios'
    )
    expect(inferPublisherFocusedFolder('Humble Comics Bundle: Example Press Mega Bundle')).toBe(
      'Example Press'
    )
    expect(inferPublisherFocusedFolder('Humble Fight for Racial Justice Bundle')).toBeUndefined()
  })

  it('prefers existing publisher family folders without named aliases', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-fs-test-'))

    try {
      await ensureDirectory(path.join(temporaryRoot, 'IDW', 'Series', 'book.cbz'))
      await ensureDirectory(path.join(temporaryRoot, 'IDW Publishing', 'Series', 'book.cbz'))
      await ensureDirectory(
        path.join(temporaryRoot, 'IDW 25th Anniversary Megabundle', 'Series', 'book.cbz')
      )

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
