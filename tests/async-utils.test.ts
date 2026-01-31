import { describe, expect, it } from 'bun:test'

import { runWithConcurrency } from '../src/utils/async'

describe('runWithConcurrency', () => {
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
})
