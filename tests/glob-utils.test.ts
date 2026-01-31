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
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'hbd-glob-test-'))
    const nestedDir = path.join(tempRoot, 'nested')
    const deeperDir = path.join(nestedDir, 'deeper')
    await createFile(path.join(tempRoot, 'one.txt'))
    await createFile(path.join(tempRoot, 'two.pdf'))
    await createFile(path.join(nestedDir, 'three.txt'))
    await createFile(path.join(deeperDir, 'four.txt'))

    try {
      const globResult = await resolveInputFiles(path.join(tempRoot, '**/*.txt'), {
        matches: (filePath) => path.extname(filePath) === '.txt',
      })
      expect(globResult.root).toBe(tempRoot)
      expect(globResult.files.sort()).toEqual(
        [
          path.join(tempRoot, 'one.txt'),
          path.join(nestedDir, 'three.txt'),
          path.join(deeperDir, 'four.txt'),
        ].sort()
      )

      const dirResult = await resolveInputFiles(tempRoot, {
        matches: (filePath) => path.extname(filePath) === '.txt',
      })
      expect(dirResult.root).toBe(tempRoot)
      expect(dirResult.files.sort()).toEqual(globResult.files.sort())
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('returns empty for non-matching file input', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'hbd-glob-test-'))
    const filePath = path.join(tempRoot, 'sample.pdf')
    await createFile(filePath)

    try {
      const result = await resolveInputFiles(filePath, {
        matches: (inputPath) => path.extname(inputPath) === '.txt',
      })
      expect(result.files).toEqual([])
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
