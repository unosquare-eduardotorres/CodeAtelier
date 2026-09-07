/**
 * WAVE-RACE FIX — OpenCode server lifecycle semantics.
 *
 * Root cause being pinned here: parallel blueprint wave tasks share ONE
 * singleton executor with a fixed port-4096 server. The old lifecycle had
 * three sibling-kill vectors:
 *   1. TOCTOU triple-start: every task checked `!isRunning()` then called
 *      start() — all saw "not running", all raced createOpencode().
 *   2. killStaleServer() killed whatever held port 4096 — including a
 *      sibling's live server.
 *   3. stop() was unconditional — a failed task's teardown killed the server
 *      out from under a sibling's live turn (the BUILD-T001 5-min stall).
 *
 * These tests pin the new semantics:
 *   - ServerRefTracker acquire/release/shouldStop arithmetic
 *   - start() serialization (concurrent callers await one startup)
 *   - stop() is a no-op while refs remain; teardown at refcount 0
 *   - killStaleServer skipped when our own server is live
 *   - ServeError retried exactly once after backoff
 *
 * Run: tsx src/main/services/__tests__/opencode-server-lifecycle.test.ts
 */

import assert from 'node:assert/strict'
import { describe, test, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

// Standalone runs need the electron + .sql loader stubs installed before the
// executor module (→ db/index.ts → schema.sql) is imported. Static imports
// hoist above the stub call, so the module is pulled in via require() AFTER
// the stub is active (same pattern as notification.service.test.ts).
setupElectronStub()

const { ServerRefTracker, OpenCodeExecutor, openCodeExecutor } =
  require('../opencode-executor') as {
    ServerRefTracker: new () => {
      acquire(key: string): void
      release(key: string): boolean
      has(key: string): boolean
      size: number
      shouldStop(): boolean
      clear(): void
    }
    OpenCodeExecutor: new () => ExecForTest
    openCodeExecutor: ExecForTest
  }

interface ExecForTest {
  serverOwnerCount: number
  isRunning(): boolean
  stop(): Promise<void>
  ensureStartedForTest(ownerKey: string): Promise<void>
  startForTest(): Promise<void>
  killStaleServerForTest(): Promise<void>
  releaseServer(key: string): boolean
  releaseAllOwnersForTest(): void
  forceStopForTest(): Promise<void>
  __setStartOnceImplForTest(impl: () => Promise<void>): void
  __setKillStaleImplForTest(impl: () => Promise<void>): void
  startHealthCheck?: (cb?: (healthy: boolean, version?: string) => void) => void
}

// ── Pure refcount arithmetic ─────────────────────────────────────────────────

describe('ServerRefTracker (pure refcount)', () => {
  test('empty tracker → shouldStop() true', () => {
    const t = new ServerRefTracker()
    assert.equal(t.size, 0)
    assert.equal(t.shouldStop(), true)
  })

  test('acquire → shouldStop() false', () => {
    const t = new ServerRefTracker()
    t.acquire('a')
    assert.equal(t.size, 1)
    assert.equal(t.shouldStop(), false)
    assert.equal(t.has('a'), true)
  })

  test('acquire is idempotent per key (double-acquire ≠ two refs)', () => {
    const t = new ServerRefTracker()
    t.acquire('a')
    t.acquire('a')
    assert.equal(t.size, 1)
  })

  test('release with remaining refs → shouldStop() false', () => {
    const t = new ServerRefTracker()
    t.acquire('a')
    t.acquire('b')
    assert.equal(t.release('a'), true)
    assert.equal(t.shouldStop(), false)
    assert.equal(t.has('a'), false)
    assert.equal(t.has('b'), true)
  })

  test('last release → shouldStop() true', () => {
    const t = new ServerRefTracker()
    t.acquire('a')
    t.acquire('b')
    t.release('a')
    assert.equal(t.release('b'), true)
    assert.equal(t.shouldStop(), true)
  })

  test('double-release returns false (no-op, not a negative refcount)', () => {
    const t = new ServerRefTracker()
    t.acquire('a')
    assert.equal(t.release('a'), true)
    assert.equal(t.release('a'), false)
    assert.equal(t.size, 0)
  })

  test('release of a never-acquired key returns false', () => {
    const t = new ServerRefTracker()
    assert.equal(t.release('ghost'), false)
  })

  test('clear() force-drops all refs', () => {
    const t = new ServerRefTracker()
    t.acquire('a')
    t.acquire('b')
    t.clear()
    assert.equal(t.size, 0)
    assert.equal(t.shouldStop(), true)
  })
})

// ── Executor lifecycle semantics (singleton, mocked SDK) ─────────────────────

// ── Executor lifecycle semantics (fresh instance per test) ───────────────────
// The harness runs async tests CONCURRENTLY, so these tests use a fresh
// OpenCodeExecutor instance each — the singleton would be mutated by sibling
// tests mid-assertion. The semantics under test are per-instance.

describe('OpenCodeExecutor server lifecycle', () => {
  /** Fresh executor with benign start/kill impls — no real spawn, no lsof. */
  const freshExecutor = (): typeof openCodeExecutor => {
    const ex = new OpenCodeExecutor()
    ex.__setStartOnceImplForTest(async () => {
      /* no-op — seam marks isStarted */
    })
    ex.__setKillStaleImplForTest(async () => {
      /* no-op */
    })
    return ex
  }

  test('ensureStarted acquires an owner ref', async () => {
    const ex = freshExecutor()
    await ex.ensureStartedForTest('k1')
    assert.equal(ex.serverOwnerCount, 1)
  })

  test('releaseServer returns true only on the LAST release', async () => {
    const ex = freshExecutor()
    await ex.ensureStartedForTest('k1')
    await ex.ensureStartedForTest('k2')
    assert.equal(ex.releaseServer('k1'), false) // k2 still holds
    assert.equal(ex.releaseServer('k2'), true) // last ref
  })

  test('stop() is a no-op while refs remain, runs at refcount 0', async () => {
    const ex = freshExecutor()
    await ex.ensureStartedForTest('k1')
    await ex.ensureStartedForTest('k2')
    await ex.stop() // must NOT tear down — k1/k2 hold refs
    assert.equal(ex.isRunning(), true)
    ex.releaseServer('k1')
    ex.releaseServer('k2')
    await ex.stop() // refcount 0 → teardown runs
    assert.equal(ex.isRunning(), false)
  })

  test('concurrent ensureStarted → single start (no TOCTOU triple-start)', async () => {
    const ex = freshExecutor()
    let starts = 0
    ex.__setStartOnceImplForTest(async () => {
      starts++
      await new Promise((r) => setTimeout(r, 20))
    })
    await Promise.all([
      ex.ensureStartedForTest('k1'),
      ex.ensureStartedForTest('k2'),
      ex.ensureStartedForTest('k3')
    ])
    assert.equal(starts, 1)
    assert.equal(ex.serverOwnerCount, 3)
  })

  test('ServeError is retried exactly once, then succeeds', async () => {
    const ex = freshExecutor()
    let attempts = 0
    ex.__setStartOnceImplForTest(async () => {
      attempts++
      if (attempts === 1) throw new Error('ServeError: port 4096 already in use')
      // second attempt succeeds
    })
    await ex.startForTest()
    assert.equal(attempts, 2)
  })

  test('non-port errors are NOT retried', async () => {
    const ex = freshExecutor()
    let attempts = 0
    ex.__setStartOnceImplForTest(async () => {
      attempts++
      throw new Error('OpenCode CLI not found')
    })
    await assert.rejects(ex.startForTest(), /CLI not found/)
    assert.equal(attempts, 1)
  })

  test('ServeError retried twice → rejects (no infinite retry)', async () => {
    const ex = freshExecutor()
    let attempts = 0
    ex.__setStartOnceImplForTest(async () => {
      attempts++
      throw new Error('ServeError: port 4096 already in use')
    })
    await assert.rejects(ex.startForTest(), /ServeError/)
    assert.equal(attempts, 2)
  })

  test('ensureStarted failure drops the owner ref (no dead-session leak)', async () => {
    const ex = freshExecutor()
    ex.__setStartOnceImplForTest(async () => {
      throw new Error('OpenCode CLI not found')
    })
    await assert.rejects(ex.ensureStartedForTest('k1'), /CLI not found/)
    assert.equal(ex.serverOwnerCount, 0)
  })

  test('killStaleServer is skipped when our own server is live', async () => {
    const ex = freshExecutor()
    let killCalls = 0
    ex.__setKillStaleImplForTest(async () => {
      killCalls++
    })
    await ex.ensureStartedForTest('k1')
    // Server is now "live" (isStarted true via the mocked startOnce).
    await ex.killStaleServerForTest()
    assert.equal(killCalls, 0)
  })

  test('killStaleServer runs when no live server (stale holder)', async () => {
    const ex = freshExecutor()
    let killCalls = 0
    ex.__setKillStaleImplForTest(async () => {
      killCalls++
    })
    // No start → isStarted false → the stale-kill path is NOT skipped.
    await ex.killStaleServerForTest()
    assert.equal(killCalls, 1)
  })

  // ── A1/A2/A5 ZOMBIE-RECOVERY (docs/opencode-zombie-server-diagnosis.md) ──

  test('A2: zombie server (isStarted=true, stale client) is force-restarted', async () => {
    const ex = freshExecutor()
    let starts = 0
    ex.__setStartOnceImplForTest(async () => {
      starts++
    })
    // First start succeeds (marks isStarted, no client set by the seam).
    await ex.ensureStartedForTest('k2')
    assert.equal(starts, 1)
    // Inject the zombie: a stale non-null client whose session.list rejects
    // with the exact incident shape (TypeError: fetch failed).
    ;(ex as unknown as { client: unknown }).client = {
      session: { list: () => Promise.reject(new TypeError('fetch failed')) }
    }
    await ex.ensureStartedForTest('k2')
    // The zombie was detected → teardown + restart ran (start impl called again).
    assert.equal(starts, 2, 'zombie must be force-restarted')
    assert.equal(ex.isRunning(), true)
    // A5: forceStop cleared owners; the caller re-acquired k2 for the fresh server.
    assert.equal(ex.serverOwnerCount, 1)
    // The stale client must not survive the restart.
    assert.equal((ex as unknown as { client: unknown }).client, null)
  })

  test('A2: healthy server on the fast path — single start, no restart', async () => {
    const ex = freshExecutor()
    let starts = 0
    ex.__setStartOnceImplForTest(async () => {
      starts++
    })
    await ex.ensureStartedForTest('k1')
    ;(ex as unknown as { client: unknown }).client = {
      session: { list: () => Promise.resolve({ data: [] }) }
    }
    await ex.ensureStartedForTest('k2')
    assert.equal(starts, 1, 'healthy server must NOT be restarted')
    assert.equal(ex.isRunning(), true)
    assert.equal(ex.serverOwnerCount, 2)
  })

  test('A1: start() arms the health monitor exactly once (direct success)', async () => {
    const ex = freshExecutor()
    let healthStarts = 0
    ;(ex as unknown as { startHealthCheck: () => void }).startHealthCheck = () => {
      healthStarts++
    }
    await ex.startForTest()
    assert.equal(healthStarts, 1)
  })

  test('A1: health monitor also armed after a ServeError-retry success', async () => {
    const ex = freshExecutor()
    let attempts = 0
    ex.__setStartOnceImplForTest(async () => {
      attempts++
      if (attempts === 1) throw new Error('ServeError: port 4096 already in use')
    })
    let healthStarts = 0
    ;(ex as unknown as { startHealthCheck: () => void }).startHealthCheck = () => {
      healthStarts++
    }
    await ex.startForTest()
    assert.equal(attempts, 2)
    assert.equal(healthStarts, 1, 'retry success must arm the monitor exactly once')
  })

  test('A1: failed start (non-port error) does NOT arm the health monitor', async () => {
    const ex = freshExecutor()
    ex.__setStartOnceImplForTest(async () => {
      throw new Error('OpenCode CLI not found')
    })
    let healthStarts = 0
    ;(ex as unknown as { startHealthCheck: () => void }).startHealthCheck = () => {
      healthStarts++
    }
    await assert.rejects(ex.startForTest(), /CLI not found/)
    assert.equal(healthStarts, 0)
  })

  test('A5: forceStop voids every owner claim (ocSessions=3 fix)', async () => {
    const ex = freshExecutor()
    await ex.ensureStartedForTest('k1')
    await ex.ensureStartedForTest('k2')
    await ex.ensureStartedForTest('k3')
    assert.equal(ex.serverOwnerCount, 3)
    await ex.forceStopForTest()
    assert.equal(ex.serverOwnerCount, 0, 'a torn-down server voids every claim')
    assert.equal(ex.isRunning(), false)
  })

  test('A2 probe cache: N concurrent ensureStarted against a healthy client → 1 session.list', async () => {
    const ex = freshExecutor()
    ex.__setStartOnceImplForTest(async () => {
      /* no-op */
    })
    await ex.ensureStartedForTest('k0')
    let listCalls = 0
    // Microtask-delayed resolution so concurrent callers genuinely overlap
    // on the probe before any of them lands in the healthy-cache window.
    ;(ex as unknown as { client: unknown }).client = {
      session: {
        list: () =>
          new Promise((resolve) => {
            listCalls++
            setTimeout(() => resolve({ data: [] }), 10)
          })
      }
    }
    await Promise.all([
      ex.ensureStartedForTest('a'),
      ex.ensureStartedForTest('b'),
      ex.ensureStartedForTest('c'),
      ex.ensureStartedForTest('d'),
      ex.ensureStartedForTest('e')
    ])
    assert.equal(listCalls, 1, 'concurrent probes must share one in-flight round-trip')
    assert.equal(ex.isRunning(), true)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
