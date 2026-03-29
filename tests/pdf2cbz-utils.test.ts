import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import { getOutputPath, resolveInputFiles } from '../src/cli/pdf2cbz-utils'

async function createFile(filePath: string, contents = 'data'): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, contents)
}

describe('pdf2cbz utils', () => {
  it('resolves only PDF inputs', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'hbd-pdf2cbz-utils-'))
    const pdfPath = path.join(temporaryRoot, 'comic.pdf')
    const textPath = path.join(temporaryRoot, 'notes.txt')
    await createFile(pdfPath)
    await createFile(textPath)

    try {
      const result = await resolveInputFiles(temporaryRoot)
      expect(result.files).toEqual([pdfPath])
      expect(result.root).toBe(temporaryRoot)
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('builds CBZ output paths', () => {
    const pdfPath = path.join('/tmp', 'comic.pdf')
    const defaultPath = getOutputPath(pdfPath)
    expect(defaultPath).toBe(path.join('/tmp', 'comic.cbz'))

    const outDirectory = path.join('/tmp', 'out')
    const customPath = getOutputPath(pdfPath, outDirectory)
    expect(customPath).toBe(path.join(path.resolve(outDirectory), 'comic.cbz'))
  })
})
