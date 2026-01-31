import path from 'node:path'

import { describe, expect, it } from 'bun:test'

import { commonParentDirectory } from '../src/utils/path'

describe('commonParentDirectory', () => {
  it('returns shared parent for multiple paths', () => {
    const root = path.resolve('/tmp', 'hbd-parent-test')
    const one = path.join(root, 'a', 'file.txt')
    const two = path.join(root, 'b', 'file.txt')
    expect(commonParentDirectory([one, two])).toBe(root)
  })

  it('returns cwd for empty input', () => {
    expect(commonParentDirectory([])).toBe(process.cwd())
  })
})
