/**
 * Run async work for a list of items using a bounded worker pool.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  async function worker(): Promise<void> {
    while (index < items.length) {
      const current = items[index]
      index += 1
      await handler(current)
    }
  }

  const pool = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(pool)
}
