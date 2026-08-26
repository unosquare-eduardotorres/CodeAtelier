/**
 * Shared harness for the e2e service-runner behavioural tests.
 *
 * Recipe (verified): under tsx a runner's `await import('…')` resolves to the
 * SAME live CJS object that `require('…')` returns, so pre-requiring a service
 * and monkey-patching a method on its singleton is visible inside the runner.
 * That drives both the success and the failure branch of every try/catch
 * without a live LLM or a child process.
 *
 * Two hazards this module exists to remove:
 *  1. test-harness runs async tests concurrently (Promise.all), so any two
 *     tests that patch the same singleton clobber each other. `serial()` puts
 *     every test body on the harness's single exclusive lock.
 *  2. The runners contain hard-coded sleeps (1–5s) and "give up" fallbacks
 *     (30s–20min). `serial()` installs a clamped setTimeout for the duration of
 *     the test so a run takes milliseconds while both branches stay reachable.
 */
// NOTE: deliberately NOT test-harness's runExclusive. That lock is shared with
// other suites, and a long chain of runner tests would queue their exclusive
// tests behind ours. This file keeps its own chain so the serialization is
// scoped to the runner tests that actually need it.
let chain: Promise<unknown> = Promise.resolve()
function runOnPrivateChain<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
import type { E2EServiceContext } from '../e2e-testing/service-runners/index'
import type { E2ETranscriptEntry } from '../../../shared/types'

// ── Patch management ─────────────────────────────────────────────────────────

/** Define an own property that shadows prototype getters, and restore exactly. */
function patchProp(obj: any, key: string, value: unknown): () => void {
  const own = Object.getOwnPropertyDescriptor(obj, key)
  Object.defineProperty(obj, key, { value, writable: true, configurable: true, enumerable: true })
  return () => {
    if (own) Object.defineProperty(obj, key, own)
    else delete obj[key]
  }
}

export interface Patcher {
  /** Replace `obj[key]` for the duration of the test. */
  set: (obj: any, key: string, value: unknown) => void
}

const realSetTimeout = global.setTimeout

/** Delay at or above which a timer is treated as a "give up" fallback. */
const LONG_DELAY_MS = 10_000

/**
 * Timer policy while a runner test is in flight.
 *
 * The runners are littered with multi-second sleeps; left real they add minutes
 * to the suite. Two rules, and the boundary between them matters:
 *
 *  - delay < 10s  -> fire immediately. These are the runners' own pacing waits.
 *  - delay >= 10s -> keep the ORIGINAL delay, but unref it.
 *
 * The second rule is not cosmetic. test-harness's `drainPending` cap is a bare
 * `setTimeout(resolve, 180_000)`; an earlier version of this helper clamped that
 * to 25ms, so the cap won the race against `Promise.all(batch)` and abandoned
 * every test still pending anywhere in the suite — 74 dropped tests and a
 * 14-point coverage drop. Long delays must therefore never be shortened.
 * Unref'ing them is safe (the cap is a safety net, not the normal exit) and it
 * stops the runners' uncleared fallbacks — council's 20-minute timer is never
 * cleared — from holding the process open for twenty minutes at the end of a run.
 *
 * A ref'd keep-alive interval is held for the duration so nothing we unref can
 * let the event loop go idle underneath the rest of the suite.
 */
export function serial(fn: (p: Patcher) => Promise<void>): () => Promise<void> {
  return () =>
    runOnPrivateChain(async () => {
      const undos: (() => void)[] = []
      const p: Patcher = { set: (o, k, v) => undos.push(patchProp(o, k, v)) }

      const patched: any = (cb: any, ms?: number, ...args: any[]) => {
        if (ms !== undefined && ms >= LONG_DELAY_MS) {
          const t: any = realSetTimeout(cb, ms, ...args)
          t?.unref?.()
          return t
        }
        return realSetTimeout(cb, 0, ...args)
      }
      patched.__promisify__ = (realSetTimeout as any).__promisify__

      const keepAlive = setInterval(() => {}, 1_000)
      global.setTimeout = patched
      try {
        await fn(p)
      } finally {
        global.setTimeout = realSetTimeout
        clearInterval(keepAlive)
        while (undos.length) undos.pop()!()
      }
    })
}

// ── Fixtures & transcript readers ────────────────────────────────────────────

export function tryRequire(path: string): any {
  try {
    return require(path)
  } catch {
    return null
  }
}

export function makeCtx(
  workspaceId: string,
  overrides: Partial<E2EServiceContext> = {}
): E2EServiceContext {
  return {
    workspaceId,
    workspacePath: '/tmp/e2e-runner-behavior-fixture',
    modelId: 'test-model',
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    signal: new AbortController().signal,
    streamPrompt: async () => [],
    ...overrides
  }
}

export const statuses = (t: E2ETranscriptEntry[]): string[] =>
  t.filter((e) => e.type === 'status').map((e) => e.content ?? '')

export const errors = (t: E2ETranscriptEntry[]): string[] =>
  t.filter((e) => e.type === 'error').map((e) => e.content ?? '')

export const texts = (t: E2ETranscriptEntry[]): string[] =>
  t.filter((e) => e.role === 'assistant' && e.type === 'text').map((e) => e.content ?? '')

export const assistantText = (content: string): E2ETranscriptEntry => ({
  role: 'assistant',
  type: 'text',
  content,
  timestamp: Date.now()
})
