/**
 * Shared test harness for Code Atelier's custom test runner.
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

/**
 * Every test name passed to `test()`, and every name that actually reported a
 * result. A test registered but never reported is silently absent from the
 * totals — the run looks green while its assertions never ran. `summary()` and
 * `summaryAsync()` treat any such gap as a failure.
 */
const registeredTests: string[] = []
const reportedTests = new Set<string>()

/** Names registered but never reported. */
function findDroppedTests(): string[] {
  return registeredTests.filter((name) => !reportedTests.has(name))
}

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
  reportedTests.add(name)
  passed++
}

function reportFailure(name: string, err: unknown): void {
  console.error(`  \u2717 ${name}`)
  const message = err instanceof Error ? err.stack || err.message : String(err)
  console.error(`    ${message}`)
  reportedTests.add(name)
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
  registeredTests.push(name)
  if (options?.skipReason) {
    console.log(`  - ${name} (skipped: ${options.skipReason})`)
    reportedTests.add(name)
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
  const dropped = reportDroppedTests()
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  process.exit(failed > 0 || dropped > 0 || process.exitCode ? 1 : 0)
}

/**
 * Async summary — awaits every pending async test before printing totals.
 * Use this when your suite contains `async` tests.
 */
/**
 * Drain the pending queue; new tests may schedule more while we wait.
 *
 * Exported so a multi-file runner can drain after each file. Async tests start
 * eagerly (see `test()`), so without a per-file drain every async test in the
 * whole run is in flight at once: wall-clock assertions ("resolves within 5s")
 * then measure event-loop contention rather than the code under test, and a
 * file's tests can outlive the module mocks they were written against.
 */
export async function drainPending(): Promise<void> {
  while (pendingAsyncTests.length > 0) {
    const batch = pendingAsyncTests.splice(0, pendingAsyncTests.length)
    await Promise.all(batch)
  }
}

/**
 * How long to wait for stragglers with no progress before giving up. The clock
 * resets whenever another straggler reports, so a heavily loaded run keeps
 * waiting as long as it is still making progress.
 */
const DROP_STALL_MS = 30_000

/** Absolute cap on straggler waiting, so a genuinely hung test can't wedge CI. */
const DROP_TOTAL_CAP_MS = 180_000

export async function summaryAsync(): Promise<void> {
  await drainPending()

  // A test whose result depends on a real timer can still be in flight when the
  // queue looks empty — its promise isn't in `pendingAsyncTests` yet, or the
  // timer simply hasn't fired. Exiting here abandons it: the assertions never
  // run and the test appears in neither the passed nor the failed count. Wait
  // for stragglers instead of exiting out from under them — but only while they
  // keep arriving. How long this takes scales with suite size and machine load,
  // so a fixed window either wastes time or truncates a big run.
  const startedWaiting = Date.now()
  let remaining = findDroppedTests().length
  let lastProgressAt = Date.now()

  while (remaining > 0) {
    if (Date.now() - lastProgressAt > DROP_STALL_MS) break
    if (Date.now() - startedWaiting > DROP_TOTAL_CAP_MS) break
    await new Promise((resolve) => setTimeout(resolve, 50))
    await drainPending()
    const now = findDroppedTests().length
    if (now < remaining) lastProgressAt = Date.now()
    remaining = now
  }

  const dropped = reportDroppedTests()
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  process.exit(failed > 0 || dropped > 0 || process.exitCode ? 1 : 0)
}

/**
 * Print any registered-but-unreported tests and return the count.
 *
 * A silently dropped test is worse than a failing one: it looks like passing
 * coverage while asserting nothing. This turned a whole file's worth of
 * streaming-lifecycle tests into dead weight without the totals ever moving,
 * so the condition is loud and fails the run.
 */
function reportDroppedTests(): number {
  const dropped = findDroppedTests()
  if (dropped.length === 0) return 0

  console.error(
    `\n✗ ${dropped.length} test(s) were registered but never reported — ` +
      `they did not run and are counted in neither passed nor failed:`
  )
  for (const name of dropped) console.error(`    - ${name}`)
  return dropped.length
}

// ─────────────────────────────────────────────────────────────────────────────
// Async mutex — serialize tests that mutate a process-global (e.g. globalThis.fetch).
// The harness starts all async tests concurrently, so any two suites that swap a
// shared global will clobber each other across `await` points. Wrap their bodies
// in `runExclusive()` so they take turns on a single shared lock.
// ─────────────────────────────────────────────────────────────────────────────

let exclusiveChain: Promise<unknown> = Promise.resolve()

export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = exclusiveChain.then(fn, fn)
  // Keep the chain alive regardless of success/failure so the next waiter still runs.
  exclusiveChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
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
  registeredTests.length = 0
  reportedTests.clear()
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
