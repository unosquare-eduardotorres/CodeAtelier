/**
 * Shared test harness for Agent Studio's custom test runner.
 * Import `test`, `describe`, and `summary` / `summaryAsync` instead of defining them inline.
 *
 * Synchronous usage:
 *   import { test, describe, summary } from './test-harness'
 *   describe('MyModule', () => { test('does X', () => { ... }) })
 *   summary()  // call at end of file — exits with code 1 if any failures
 *
 * Async usage:
 *   describe('MyModule', () => {
 *     test('does X async', async () => { await doSomething() })
 *   })
 *   await summaryAsync()  // awaits pending async tests before exiting
 *
 * Lifecycle hooks (scoped to nearest describe):
 *   describe('MyModule', () => {
 *     beforeEach(() => { resetState() })
 *     afterEach(() => { cleanup() })
 *     test('does X', () => { ... })
 *   })
 *
 * Spies (for test doubles without external deps):
 *   const spy = createSpy((x: number) => x * 2)
 *   spy(5)
 *   assert.equal(spy.callCount, 1)
 *   assert.deepEqual(spy.calls[0], [5])
 */

export let passed = 0
export let failed = 0
export let skipped = 0

type Hook = () => void | Promise<void>

interface DescribeScope {
  name: string
  beforeEachHooks: Hook[]
  afterEachHooks: Hook[]
}

// Track nested describe scopes so hooks are scoped correctly.
const scopeStack: DescribeScope[] = []

// Track pending async tests so `summaryAsync()` can await them.
const pendingAsyncTests: Promise<void>[] = []

async function runHooks(hooks: Hook[]): Promise<void> {
  for (const hook of hooks) {
    await hook()
  }
}

function collectHooks(kind: 'beforeEach' | 'afterEach'): Hook[] {
  const key = kind === 'beforeEach' ? 'beforeEachHooks' : 'afterEachHooks'
  // beforeEach runs outer → inner; afterEach runs inner → outer.
  const scopes = kind === 'beforeEach' ? scopeStack : [...scopeStack].reverse()
  return scopes.flatMap((s) => s[key])
}

function reportSuccess(name: string): void {
  console.log(`  \u2713 ${name}`)
  passed++
}

function reportFailure(name: string, err: unknown): void {
  console.error(`  \u2717 ${name}`)
  const message = err instanceof Error ? err.stack || err.message : String(err)
  console.error(`    ${message}`)
  failed++
}

async function runTestAsync(
  name: string,
  fn: () => void | Promise<void>,
  beforeHooks: Hook[],
  afterHooks: Hook[]
): Promise<void> {
  try {
    await runHooks(beforeHooks)
    await fn()
    await runHooks(afterHooks)
    reportSuccess(name)
  } catch (err) {
    reportFailure(name, err)
    try {
      await runHooks(afterHooks)
    } catch (afterErr) {
      console.error(`    afterEach threw: ${(afterErr as Error).message}`)
    }
  }
}

export function test(
  name: string,
  fn: () => void | Promise<void>,
  options?: { skipReason?: string }
): void {
  if (options?.skipReason) {
    console.log(`  - ${name} (skipped: ${options.skipReason})`)
    skipped++
    return
  }

  const beforeHooks = collectHooks('beforeEach')
  const afterHooks = collectHooks('afterEach')

  // Always route through the async path when we have hooks — they may be async,
  // and sequencing is cleaner with awaits. For tests with no hooks we try the
  // synchronous fast path first and only fall back to async if the test returns
  // a promise.
  if (beforeHooks.length > 0 || afterHooks.length > 0) {
    pendingAsyncTests.push(runTestAsync(name, fn, beforeHooks, afterHooks))
    return
  }

  let result: unknown
  try {
    result = fn()
  } catch (err) {
    reportFailure(name, err)
    return
  }

  if (result && typeof (result as Promise<unknown>).then === 'function') {
    pendingAsyncTests.push(
      (async () => {
        try {
          await result
          reportSuccess(name)
        } catch (err) {
          reportFailure(name, err)
        }
      })()
    )
    return
  }

  reportSuccess(name)
}

export function describe(name: string, fn: () => void | Promise<void>): void {
  console.log(`\n${name}`)
  const scope: DescribeScope = { name, beforeEachHooks: [], afterEachHooks: [] }
  scopeStack.push(scope)
  try {
    const out = fn()
    if (out && typeof (out as Promise<void>).then === 'function') {
      // Async describe — pop the scope when it resolves.
      pendingAsyncTests.push(
        (async () => {
          try {
            await out
          } finally {
            if (scopeStack[scopeStack.length - 1] === scope) scopeStack.pop()
          }
        })()
      )
      return
    }
  } catch (err) {
    console.error(`  ✗ describe(${name}) threw: ${(err as Error).message}`)
    failed++
  }
  scopeStack.pop()
}

export function beforeEach(fn: Hook): void {
  const scope = scopeStack[scopeStack.length - 1]
  if (!scope) {
    throw new Error('beforeEach() must be called inside a describe() block')
  }
  scope.beforeEachHooks.push(fn)
}

export function afterEach(fn: Hook): void {
  const scope = scopeStack[scopeStack.length - 1]
  if (!scope) {
    throw new Error('afterEach() must be called inside a describe() block')
  }
  scope.afterEachHooks.push(fn)
}

/**
 * Synchronous summary — call at end of file for purely synchronous test suites.
 * Exits the process with code 1 if any tests failed.
 *
 * If your suite uses `async` tests or async lifecycle hooks, prefer `summaryAsync()`.
 */
export function summary(): void {
  if (pendingAsyncTests.length > 0) {
    console.warn(
      `[test-harness] ${pendingAsyncTests.length} async test(s) pending — use summaryAsync() instead.`
    )
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  process.exit(failed > 0 ? 1 : 0)
}

/**
 * Async summary — awaits every pending async test before printing totals.
 * Use this when your suite contains `async` tests.
 */
export async function summaryAsync(): Promise<void> {
  // Drain the queue — new tests may schedule more pending promises.
  while (pendingAsyncTests.length > 0) {
    const batch = pendingAsyncTests.splice(0, pendingAsyncTests.length)
    await Promise.all(batch)
  }
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
  pendingAsyncTests.length = 0
  scopeStack.length = 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Spy utility — zero-dependency test double for tracking calls and stubbing.
// ─────────────────────────────────────────────────────────────────────────────

export interface Spy<TArgs extends unknown[] = unknown[], TReturn = unknown> {
  (...args: TArgs): TReturn
  readonly calls: TArgs[]
  readonly callCount: number
  readonly lastCall: TArgs | undefined
  reset(): void
  mockReturnValue(value: TReturn): void
  mockImplementation(impl: (...args: TArgs) => TReturn): void
}

/**
 * Create a spy that records every call. Optionally wraps a real implementation.
 *
 *   const spy = createSpy<[number], number>((x) => x * 2)
 *   spy(5)                 // returns 10
 *   spy.callCount          // 1
 *   spy.calls[0]           // [5]
 *   spy.mockReturnValue(0) // subsequent calls return 0
 */
export function createSpy<TArgs extends unknown[] = unknown[], TReturn = unknown>(
  impl?: (...args: TArgs) => TReturn
): Spy<TArgs, TReturn> {
  const calls: TArgs[] = []
  let currentImpl: ((...args: TArgs) => TReturn) | undefined = impl
  let fixedReturn: { value: TReturn } | undefined

  const spy = ((...args: TArgs): TReturn => {
    calls.push(args)
    if (fixedReturn) return fixedReturn.value
    if (currentImpl) return currentImpl(...args)
    return undefined as unknown as TReturn
  }) as Spy<TArgs, TReturn>

  Object.defineProperty(spy, 'calls', { get: () => calls })
  Object.defineProperty(spy, 'callCount', { get: () => calls.length })
  Object.defineProperty(spy, 'lastCall', {
    get: () => (calls.length === 0 ? undefined : calls[calls.length - 1])
  })
  spy.reset = (): void => {
    calls.length = 0
  }
  spy.mockReturnValue = (value: TReturn): void => {
    fixedReturn = { value }
  }
  spy.mockImplementation = (newImpl: (...args: TArgs) => TReturn): void => {
    currentImpl = newImpl
    fixedReturn = undefined
  }
  return spy
}
