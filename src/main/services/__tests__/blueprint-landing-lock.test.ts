/**
 * PARALLEL-RUNS — per-repo landing lock (autoLandBlueprint serialization).
 *
 * Multiple blueprints may run BUILD in one workspace concurrently, but landing
 * (the merge into the integration branch) must serialize PER REPO — a second
 * merge that starts while the first is mid-merge races the git index.
 *
 * autoLandBlueprint delegates its serialization to `enqueueLandingChain` (a
 * pure promise-chain mutex, exported here for exactly this test). These tests
 * prove through the real implementation:
 *   - two concurrent tasks on ONE key never interleave — the second starts
 *     only after the first resolves (FIFO = arrival order)
 *   - different keys (different repos/workspaces) DO run concurrently
 *   - a rejected landing never poisons the chain for the next arrival
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// Electron stub first (blueprint-track imports electron-log via repositories)
import { setupElectronStub } from './electron-stub'
setupElectronStub()

import { enqueueLandingChain } from '../blueprint-track'

interface TaskCall {
  name: string
  startedAt: number
  endedAt: number
}

/** A fake landOwner task with an artificial merge delay + call recording. */
function makeTask(name: string, calls: TaskCall[], delayMs = 30): () => Promise<string> {
  return async () => {
    const startedAt = Date.now()
    await new Promise((r) => setTimeout(r, delayMs))
    const endedAt = Date.now()
    calls.push({ name, startedAt, endedAt })
    return `${name}-landed`
  }
}

describe('enqueueLandingChain — per-repo landing lock', () => {
  test('two concurrent lands on ONE workspace never interleave (second starts after first resolves)', async () => {
    const chains = new Map<string, Promise<void>>()
    const calls: TaskCall[] = []
    let inFlight = 0
    let maxConcurrent = 0

    // Wrap the recorder to track concurrency (what interleave would violate).
    const track = (name: string): (() => Promise<string>) => {
      const inner = makeTask(name, calls)
      return async () => {
        inFlight++
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        try {
          return await inner()
        } finally {
          inFlight--
        }
      }
    }

    // Two concurrent lands, same workspace key (one repo) — arrival order a, b.
    const [resultA, resultB] = await Promise.all([
      enqueueLandingChain(chains, 'ws-lock', track('bp-land-a')),
      enqueueLandingChain(chains, 'ws-lock', track('bp-land-b'))
    ])

    assert.equal(resultA, 'bp-land-a-landed')
    assert.equal(resultB, 'bp-land-b-landed')
    assert.equal(calls.length, 2)
    assert.equal(maxConcurrent, 1, `lands must never run concurrently (max=${maxConcurrent})`)

    // Serialization: second's start ≥ first's end.
    const [first, second] = calls
    assert.equal(first.name, 'bp-land-a', 'FIFO — first arrival lands first')
    assert.ok(
      second.startedAt >= first.endedAt,
      `second land (${second.startedAt}) must start after first ends (${first.endedAt})`
    )
  })

  test('different workspaces (different repos) land concurrently — no cross-repo blocking', async () => {
    const chains = new Map<string, Promise<void>>()
    const calls: TaskCall[] = []
    let inFlight = 0
    let maxConcurrent = 0

    const track = (name: string): (() => Promise<string>) => {
      const inner = makeTask(name, calls, 40)
      return async () => {
        inFlight++
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        try {
          return await inner()
        } finally {
          inFlight--
        }
      }
    }

    await Promise.all([
      enqueueLandingChain(chains, 'ws-1', track('bp-ws1')),
      enqueueLandingChain(chains, 'ws-2', track('bp-ws2'))
    ])

    assert.equal(maxConcurrent, 2, 'independent repos must land in parallel')
    assert.equal(calls.length, 2)
  })

  test('a FAILED landing does not block the next blueprint (chain stays alive)', async () => {
    const chains = new Map<string, Promise<void>>()
    const calls: string[] = []

    const failing = async (): Promise<string> => {
      calls.push('bp-fail')
      throw new Error('git index locked')
    }
    const succeeding = async (): Promise<string> => {
      calls.push('bp-next')
      return 'ok'
    }

    // First land rejects — autoLandBlueprint catches its own errors, and the
    // chain swallows the rejection so the next arrival still runs.
    await assert.rejects(
      enqueueLandingChain(chains, 'ws-chain', failing),
      /git index locked/
    )
    const result = await enqueueLandingChain(chains, 'ws-chain', succeeding)
    assert.equal(result, 'ok')
    assert.deepEqual(calls, ['bp-fail', 'bp-next'], 'second land ran despite first rejecting')
  })
})

/**
 * PRODUCTION PATH — autoLandBlueprint serialization (c6 pin).
 *
 * Calls the REAL autoLandBlueprint twice concurrently for one workspace.
 * landingService.landOwner is stubbed with a MANUALLY-RESOLVED promise: the
 * first call's landOwner is held unresolved while the second autoLandBlueprint
 * is dispatched, proving through the real code that the second landOwner
 * invocation starts only after the first resolves (never interleaved).
 */
describe('autoLandBlueprint — production-path serialization (c6)', () => {
  test('second landOwner starts only after the first resolves — held-promise proof', async () => {
    const env = require('./landing-lock-env') as {
      blueprintTrackMod: typeof import('../blueprint-track')
      landingMod: { landingService: { landOwner: (...args: unknown[]) => Promise<unknown> } }
    }
    const { autoLandBlueprint } = env.blueprintTrackMod
    const svc = env.landingMod.landingService
    const origLandOwner = svc.landOwner

    // Manually-controlled first land: a gate we release explicitly.
    let releaseFirst: (() => void) | null = null
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const events: string[] = []
    let firstEndedAt = 0
    let secondStartedAt = 0
    let callCount = 0

    svc.landOwner = (async (_owner: unknown, _blueprintId: unknown) => {
      const isFirst = callCount === 0
      callCount++
      if (isFirst) {
        events.push('first-start')
        await firstGate // HOLD — second land must not start while this pends
        firstEndedAt = Date.now()
        events.push('first-end')
        return { outcome: 'merged', branch: 'b1' }
      }
      events.push('second-start')
      secondStartedAt = Date.now()
      events.push('second-end')
      return { outcome: 'merged', branch: 'b2' }
    }) as typeof svc.landOwner

    // The Promise executor ran synchronously — releaseFirst is set.
    const release: () => void = releaseFirst as unknown as () => void

    try {
      // Dispatch both concurrently. Neither completes until we release the gate.
      const landA = autoLandBlueprint({
        blueprintId: 'bp-prod-a',
        workspaceId: 'ws-prod',
        humanReviewNeeded: false
      })
      const landB = autoLandBlueprint({
        blueprintId: 'bp-prod-b',
        workspaceId: 'ws-prod',
        humanReviewNeeded: false
      })

      // Let microtasks settle: landA's landOwner has started and is held;
      // landB is enqueued behind it.
      await new Promise((r) => setTimeout(r, 25))
      assert.deepEqual(
        events,
        ['first-start'],
        'only the first landOwner has started — second is waiting on the lock'
      )

      // Release the first land. The second may start only after it resolves.
      release()
      await Promise.all([landA, landB])

      assert.equal(callCount, 2, 'both lands executed')
      assert.deepEqual(
        events,
        ['first-start', 'first-end', 'second-start', 'second-end'],
        'strict FIFO, no interleave'
      )
      assert.ok(
        secondStartedAt >= firstEndedAt,
        `second landOwner (${secondStartedAt}) started only after first resolved (${firstEndedAt})`
      )
    } finally {
      svc.landOwner = origLandOwner
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
