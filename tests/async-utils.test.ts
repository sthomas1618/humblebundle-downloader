import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'

import { runWithConcurrency } from '../src/utils/async'

describe('runWithConcurrency', () => {
  const originalSetTimeout = globalThis.setTimeout

  beforeEach(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
  })

  it('processes all items within the concurrency limit', async () => {
    const items = [1, 2, 3, 4, 5, 6]
    const processed: number[] = []
    let inFlight = 0
    let maxInFlight = 0

    await runWithConcurrency(items, 2, async (item) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      processed.push(item)
      inFlight -= 1
    })

    expect(processed.sort((a, b) => a - b)).toEqual(items)
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('uses no workers when there are no items', async () => {
    const handler = spyOn({ handler: async () => {} }, 'handler')

    await runWithConcurrency([], 3, handler)

    expect(handler).not.toHaveBeenCalled()
  })

  it('executes work synchronously when concurrency exceeds items', async () => {
    const items = ['one', 'two']
    const processed: string[] = []

    await runWithConcurrency(items, 10, async (item) => {
      processed.push(item)
    })

    expect(processed).toEqual(items)
  })

  it('propagates handler errors', async () => {
    const items = [1, 2, 3]

    await expect(async () => {
      await runWithConcurrency(items, 2, async (item) => {
        if (item === 2) {
          throw new Error('boom')
        }
      })
    }).toThrow('boom')
  })
})
