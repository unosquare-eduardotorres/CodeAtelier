/**
 * Shared test harness for Agent Studio's custom test runner.
 * Import `test`, `describe`, and `summary` instead of defining them inline.
 *
 * Usage:
 *   import { test, describe, summary } from './test-harness'
 *   describe('MyModule', () => { test('does X', () => { ... }) })
 *   summary()  // call at end of file — exits with code 1 if any failures
 */

export let passed = 0
export let failed = 0
export let skipped = 0

export function test(name: string, fn: () => void, options?: { skipReason?: string }): void {
  if (options?.skipReason) {
    console.log(`  - ${name} (skipped: ${options.skipReason})`)
    skipped++
    return
  }

  try {
    fn()
    console.log(`  \u2713 ${name}`)
    passed++
  } catch (err) {
    console.error(`  \u2717 ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

export function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

export function summary(): void {
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  process.exit(failed > 0 ? 1 : 0)
}

/**
 * Reset counters — useful when running multiple test files in a single process.
 */
export function resetCounters(): void {
  passed = 0
  failed = 0
  skipped = 0
}
