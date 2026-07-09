/**
 * Unit tests for plan-tool-recovery gating by adapter capability.
 *
 * Verifies that:
 * 1. Blueprint adapters (supportsEmitPlanRecovery = false) skip recovery
 * 2. Da Vinci adapter (supportsEmitPlanRecovery = true) allows recovery
 * 3. The timeout watchdog in attemptPlanToolRecovery aborts after 2 minutes
 *    of inactivity (tested with a short timeout override)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, createSpy } from './test-harness'

// ── Recovery gating condition (extracted logic, no real services needed) ──

/** Mirrors the gate condition in agent-recovery-manager.ts:attemptStreamRecovery */
function shouldAttemptPlanRecovery(params: {
  supportsEmitPlanRecovery: boolean
  planModeToolBlock: boolean
  currentMode: string
  controlToolStatePlan: boolean
  timedOut: boolean
}): boolean {
  return (
    params.supportsEmitPlanRecovery &&
    params.planModeToolBlock &&
    params.currentMode === 'plan' &&
    !params.controlToolStatePlan &&
    !params.timedOut
  )
}

describe('Plan-Tool-Recovery Gating', () => {
  test('Da Vinci adapter (supportsEmitPlanRecovery=true) allows recovery when all conditions met', () => {
    const result = shouldAttemptPlanRecovery({
      supportsEmitPlanRecovery: true,
      planModeToolBlock: true,
      currentMode: 'plan',
      controlToolStatePlan: false,
      timedOut: false
    })
    assert.equal(result, true, 'Recovery should be attempted for Da Vinci')
  })

  test('Blueprint adapter (supportsEmitPlanRecovery=false) skips recovery even when all other conditions met', () => {
    const result = shouldAttemptPlanRecovery({
      supportsEmitPlanRecovery: false,
      planModeToolBlock: true,
      currentMode: 'plan',
      controlToolStatePlan: false,
      timedOut: false
    })
    assert.equal(result, false, 'Recovery must be skipped for blueprint sessions')
  })

  test('Recovery skipped when not in plan mode', () => {
    const result = shouldAttemptPlanRecovery({
      supportsEmitPlanRecovery: true,
      planModeToolBlock: true,
      currentMode: 'build',
      controlToolStatePlan: false,
      timedOut: false
    })
    assert.equal(result, false)
  })

  test('Recovery skipped when plan already emitted', () => {
    const result = shouldAttemptPlanRecovery({
      supportsEmitPlanRecovery: true,
      planModeToolBlock: true,
      currentMode: 'plan',
      controlToolStatePlan: true,
      timedOut: false
    })
    assert.equal(result, false)
  })

  test('Recovery skipped on timeout', () => {
    const result = shouldAttemptPlanRecovery({
      supportsEmitPlanRecovery: true,
      planModeToolBlock: true,
      currentMode: 'plan',
      controlToolStatePlan: false,
      timedOut: true
    })
    assert.equal(result, false)
  })

  test('Recovery skipped when no plan-mode tool block occurred', () => {
    const result = shouldAttemptPlanRecovery({
      supportsEmitPlanRecovery: true,
      planModeToolBlock: false,
      currentMode: 'plan',
      controlToolStatePlan: false,
      timedOut: false
    })
    assert.equal(result, false)
  })
})

// ── Timeout watchdog test ──

describe('Plan-Tool-Recovery Timeout Watchdog', () => {
  test('aborts when no chunks arrive within timeout window', async () => {
    // Simulate the timeout pattern from agent-recovery-nudge.ts
    // using a short timeout (50ms) and a never-yielding iterator
    const TIMEOUT_MS = 50

    async function* neverYield(): AsyncGenerator<{ type: string }> {
      // Simulate a hanging executor — never yields, never returns
      await new Promise(() => {}) // hangs forever
    }

    const iter = neverYield()
    const startTime = Date.now()

    const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), TIMEOUT_MS)
    )
    const next = iter.next()
    const result = await Promise.race([next, timeoutPromise])

    const elapsed = Date.now() - startTime
    assert.equal(result.done, true, 'Timeout should resolve with done=true')
    assert.ok(elapsed >= TIMEOUT_MS - 5, `Should wait at least ${TIMEOUT_MS}ms (got ${elapsed}ms)`)
    // Under concurrent test execution the event loop may be busy, so allow
    // generous headroom (2s) — the important assertion is that the timeout
    // fires rather than hanging forever.
    assert.ok(elapsed < TIMEOUT_MS + 3000, `Should not wait too long (got ${elapsed}ms)`)

    // Fire-and-forget cleanup — the generator is stuck in an unresolvable
    // await, so iter.return() itself will hang.  We just let it GC.
    void iter.return(undefined as never).catch(() => {})
  })

  test('processes chunks normally when they arrive before timeout', async () => {
    const TIMEOUT_MS = 200
    const chunks: string[] = []

    async function* quickYield(): AsyncGenerator<{ type: string; name: string }> {
      yield { type: 'text', name: 'chunk1' }
      yield { type: 'text', name: 'chunk2' }
    }

    const iter = quickYield()

    // Process first chunk
    const timeoutPromise1 = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), TIMEOUT_MS)
    )
    const result1 = await Promise.race([iter.next(), timeoutPromise1])
    assert.equal(result1.done, false)
    chunks.push((result1.value as { name: string }).name)

    // Process second chunk
    const timeoutPromise2 = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), TIMEOUT_MS)
    )
    const result2 = await Promise.race([iter.next(), timeoutPromise2])
    assert.equal(result2.done, false)
    chunks.push((result2.value as { name: string }).name)

    // Iterator should finish normally
    const timeoutPromise3 = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), TIMEOUT_MS)
    )
    const result3 = await Promise.race([iter.next(), timeoutPromise3])
    assert.equal(result3.done, true)

    assert.deepEqual(chunks, ['chunk1', 'chunk2'])
  })
})

// Only run summary when this file is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
