import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import { isGlobInput, resolveInputFiles } from '../src/utils/glob'

async function createFile(filePath: string, contents = 'data'): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, contents)
}

describe('glob utilities', () => {
  it('detects glob patterns', () => {
    expect(isGlobInput('foo/*.pdf')).toBe(true)
    expect(isGlobInput('foo/?/bar')).toBe(true)
    expect(isGlobInput('foo/bar.pdf')).toBe(false)
  })

  it('resolves files for glob and directory inputs', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-glob-test-'))
    const nestedDirectory = path.join(temporaryRoot, 'nested')
    const deeperDirectory = path.join(nestedDirectory, 'deeper')
    await createFile(path.join(temporaryRoot, 'one.txt'))
    await createFile(path.join(temporaryRoot, 'two.pdf'))
    await createFile(path.join(nestedDirectory, 'three.txt'))
    await createFile(path.join(deeperDirectory, 'four.txt'))

    try {
      const globResult = await resolveInputFiles(path.join(temporaryRoot, '**/*.txt'), {
        matches: (filePath) => path.extname(filePath) === '.txt',
      })
      expect(globResult.root).toBe(temporaryRoot)
      expect(globResult.files.sort()).toEqual(
        [
          path.join(temporaryRoot, 'one.txt'),
          path.join(nestedDirectory, 'three.txt'),
          path.join(deeperDirectory, 'four.txt'),
        ].sort()
      )

      const directoryResult = await resolveInputFiles(temporaryRoot, {
        matches: (filePath) => path.extname(filePath) === '.txt',
      })
      expect(directoryResult.root).toBe(temporaryRoot)
      expect(directoryResult.files.sort()).toEqual(globResult.files.sort())
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('returns empty for non-matching file input', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-glob-test-'))
    const filePath = path.join(temporaryRoot, 'sample.pdf')
    await createFile(filePath)

    try {
      const result = await resolveInputFiles(filePath, {
        matches: (inputPath) => path.extname(inputPath) === '.txt',
      })
      expect(result.files).toEqual([])
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('resolves single file inputs and captures parent root', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-glob-test-'))
    const filePath = path.join(temporaryRoot, 'sample.txt')
    await createFile(filePath)

    try {
      const result = await resolveInputFiles(filePath, {
        matches: (inputPath) => path.extname(inputPath) === '.txt',
      })
      expect(result.files).toEqual([filePath])
      expect(result.root).toBe(temporaryRoot)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('handles glob patterns rooted above current directory', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-glob-test-'))
    const nestedDirectory = path.join(temporaryRoot, 'nested')
    await createFile(path.join(nestedDirectory, 'example.txt'))

    try {
      const relativePattern = path.join(temporaryRoot, 'nested', '*.txt')
      const result = await resolveInputFiles(relativePattern, {
        matches: (inputPath) => path.extname(inputPath) === '.txt',
      })
      expect(result.root).toBe(nestedDirectory)
      expect(result.files).toEqual([path.join(nestedDirectory, 'example.txt')])
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})
