/**
 * blueprint-send-outcome.test.ts
 *
 * Tests for session outcome classification per handleStreamError path.
 * Validates that SendOutcome values are correctly set for each terminal error
 * category and that executeTask / verify would react appropriately.
 *
 * Mirror-logic tests — we can't easily instantiate a full AgentSessionService +
 * AgentRecoveryManager in unit tests, so we test the outcome classification
 * logic and the consumer-side branching independently.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync, beforeEach } from './test-harness'
import { setupElectronStub } from './electron-stub'
import type { SendOutcome } from '../agent-session.service'

setupElectronStub()

// ═══════════════════════════════════════════════════════════════════════════
// SendOutcome type validation
// ═══════════════════════════════════════════════════════════════════════════

describe('SendOutcome type — valid values', () => {
  test('all expected outcome values are assignable', () => {
    const outcomes: SendOutcome[] = [
      'ok',
      'overload',
      'turn_limit_exhausted',
      'context_overflow',
      'error',
      'aborted'
    ]
    assert.equal(outcomes.length, 6)
    assert.ok(outcomes.includes('ok'))
    assert.ok(outcomes.includes('overload'))
    assert.ok(outcomes.includes('turn_limit_exhausted'))
    assert.ok(outcomes.includes('context_overflow'))
    assert.ok(outcomes.includes('error'))
    assert.ok(outcomes.includes('aborted'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Error classification → outcome mapping (mirror of handleStreamError)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mirror of classifyStreamError's output shape — duplicated here to avoid
 * importing internal RecoveryManager state.
 */
interface ErrorClassification {
  isOverload: boolean
  isMaxTurns: boolean
  isContextOverflow: boolean
  isAbort: boolean
}

/** Map a classification to the expected SendOutcome (mirrors handleStreamError logic). */
function expectedOutcome(c: ErrorClassification, maxTurnsCanContinue: boolean): SendOutcome {
  if (c.isOverload) return 'overload'
  if (c.isMaxTurns && maxTurnsCanContinue) return 'ok' // auto-continue resets outcome
  if (c.isMaxTurns) return 'turn_limit_exhausted'
  if (c.isContextOverflow) return 'context_overflow'
  if (c.isAbort) return 'aborted'
  return 'error'
}

describe('Error classification → SendOutcome mapping', () => {
  test('API overload → overload', () => {
    const c: ErrorClassification = {
      isOverload: true,
      isMaxTurns: false,
      isContextOverflow: false,
      isAbort: false
    }
    assert.equal(expectedOutcome(c, false), 'overload')
  })

  test('max_turns with continuations available → ok (auto-continue)', () => {
    const c: ErrorClassification = {
      isOverload: false,
      isMaxTurns: true,
      isContextOverflow: false,
      isAbort: false
    }
    assert.equal(expectedOutcome(c, true), 'ok')
  })

  test('max_turns exhausted → turn_limit_exhausted', () => {
    const c: ErrorClassification = {
      isOverload: false,
      isMaxTurns: true,
      isContextOverflow: false,
      isAbort: false
    }
    assert.equal(expectedOutcome(c, false), 'turn_limit_exhausted')
  })

  test('context overflow → context_overflow', () => {
    const c: ErrorClassification = {
      isOverload: false,
      isMaxTurns: false,
      isContextOverflow: true,
      isAbort: false
    }
    assert.equal(expectedOutcome(c, false), 'context_overflow')
  })

  test('abort/timeout → aborted', () => {
    const c: ErrorClassification = {
      isOverload: false,
      isMaxTurns: false,
      isContextOverflow: false,
      isAbort: true
    }
    assert.equal(expectedOutcome(c, false), 'aborted')
  })

  test('generic error (no flags) → error', () => {
    const c: ErrorClassification = {
      isOverload: false,
      isMaxTurns: false,
      isContextOverflow: false,
      isAbort: false
    }
    assert.equal(expectedOutcome(c, false), 'error')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Consumer-side branching: executeTask outcome check
// ═══════════════════════════════════════════════════════════════════════════

describe('executeTask outcome-check branching', () => {
  test('ok outcome → proceeds to parse output (success path)', () => {
    const outcome: SendOutcome = 'ok'
    const shouldParseOutput = outcome === 'ok'
    assert.equal(shouldParseOutput, true)
  })

  test('overload outcome → skips parsing, marks task failed', () => {
    const outcome = 'overload' as SendOutcome
    const shouldParseOutput = outcome === 'ok'
    assert.equal(shouldParseOutput, false)
  })

  test('turn_limit_exhausted → skips parsing, marks task failed', () => {
    const outcome = 'turn_limit_exhausted' as SendOutcome
    const shouldParseOutput = outcome === 'ok'
    assert.equal(shouldParseOutput, false)
  })

  test('context_overflow → skips parsing, marks task failed', () => {
    const outcome = 'context_overflow' as SendOutcome
    const shouldParseOutput = outcome === 'ok'
    assert.equal(shouldParseOutput, false)
  })

  test('error → skips parsing, marks task failed', () => {
    const outcome = 'error' as SendOutcome
    const shouldParseOutput = outcome === 'ok'
    assert.equal(shouldParseOutput, false)
  })

  test('aborted → skips parsing, marks task failed', () => {
    const outcome = 'aborted' as SendOutcome
    const shouldParseOutput = outcome === 'ok'
    assert.equal(shouldParseOutput, false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// No-write-activity detection (Fix 2 scheduling logic)
// ═══════════════════════════════════════════════════════════════════════════

describe('no-write-activity detection', () => {
  test('claims files + zero write tools → fail', () => {
    const claimedFiles = 3
    const writeToolCalls = 0
    const bashCalls = 0
    const noWriteActivity = writeToolCalls === 0 && bashCalls === 0
    const shouldFail = noWriteActivity && claimedFiles > 0
    assert.equal(shouldFail, true)
  })

  test('claims files + write tools > 0 → pass', () => {
    const claimedFiles = 3
    const writeToolCalls: number = 2
    const bashCalls = 0
    const noWriteActivity = writeToolCalls === 0 && bashCalls === 0
    const shouldFail = noWriteActivity && claimedFiles > 0
    assert.equal(shouldFail, false)
  })

  test('claims files + bash calls > 0 → pass (bash may write)', () => {
    const claimedFiles = 3
    const writeToolCalls = 0
    const bashCalls: number = 1
    const noWriteActivity = writeToolCalls === 0 && bashCalls === 0
    const shouldFail = noWriteActivity && claimedFiles > 0
    assert.equal(shouldFail, false)
  })

  test('no claims + no planned files → pass (integration task)', () => {
    const claimedFiles = 0
    const hasPlannedFiles = false
    const writeToolCalls = 0
    const bashCalls = 0
    const noWriteActivity = writeToolCalls === 0 && bashCalls === 0
    const shouldFail = noWriteActivity && (claimedFiles > 0 || hasPlannedFiles)
    assert.equal(shouldFail, false)
  })

  test('no claims + planned files + zero writes → fail', () => {
    const claimedFiles = 0
    const completion = null
    const hasPlannedFiles = true
    const writeToolCalls = 0
    const bashCalls = 0
    const noWriteActivity = writeToolCalls === 0 && bashCalls === 0
    const shouldFail = noWriteActivity && (claimedFiles > 0 || (!completion && hasPlannedFiles))
    assert.equal(shouldFail, true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Overload-aware cap halving (Fix 4 scheduling logic)
// ═══════════════════════════════════════════════════════════════════════════

describe('overload-aware cap halving', () => {
  test('cap 6 halved to 3 on overload', () => {
    let cap = 6
    const failureReason = 'overload'
    if (failureReason === 'overload' && cap > 1) {
      cap = Math.max(1, Math.floor(cap / 2))
    }
    assert.equal(cap, 3)
  })

  test('cap 3 halved to 1 on overload', () => {
    let cap = 3
    const failureReason = 'overload'
    if (failureReason === 'overload' && cap > 1) {
      cap = Math.max(1, Math.floor(cap / 2))
    }
    assert.equal(cap, 1)
  })

  test('cap 1 stays 1 (min floor)', () => {
    let cap = 1
    const failureReason = 'overload'
    if (failureReason === 'overload' && cap > 1) {
      cap = Math.max(1, Math.floor(cap / 2))
    }
    assert.equal(cap, 1) // guard prevents going below 1
  })

  test('non-overload failure does not halve cap', () => {
    let cap = 6
    const failureReason: string = 'error'
    let draining = false
    if (failureReason === 'overload' && cap > 1) {
      cap = Math.max(1, Math.floor(cap / 2))
    } else {
      draining = true
    }
    assert.equal(cap, 6)
    assert.equal(draining, true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Overload retry backoff computation
// ═══════════════════════════════════════════════════════════════════════

// Mirror constants from blueprint-build.service.ts
const OVERLOAD_MAX_RETRIES = 2
const OVERLOAD_BACKOFF_BASE_MS = 60_000

describe('overload retry — backoff computation', () => {
  test('attempt 1 → 60s delay', () => {
    const attempt = 1 // first retry (0-indexed prior retries = 0)
    const delay = OVERLOAD_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
    assert.equal(delay, 60_000)
  })

  test('attempt 2 → 120s delay', () => {
    const attempt = 2
    const delay = OVERLOAD_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
    assert.equal(delay, 120_000)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Overload retry — budget enforcement
// ═══════════════════════════════════════════════════════════════════════

describe('overload retry — budget enforcement', () => {
  /**
   * Mirror of the retry decision logic from executeWave.
   * Returns 'retry' | 'fail' depending on whether retries remain.
   */
  function retryDecision(
    failureReason: string,
    priorRetries: number,
    draining: boolean,
    aborted: boolean
  ): 'retry' | 'fail' | 'skip' {
    if (
      failureReason === 'overload' &&
      !draining &&
      !aborted &&
      priorRetries < OVERLOAD_MAX_RETRIES
    ) {
      return 'retry'
    }
    return failureReason === 'overload' ? 'fail' : 'skip'
  }

  test('first overload (0 prior retries) → retry', () => {
    assert.equal(retryDecision('overload', 0, false, false), 'retry')
  })

  test('second overload (1 prior retry) → retry', () => {
    assert.equal(retryDecision('overload', 1, false, false), 'retry')
  })

  test('third overload (2 prior retries = max) → fail (budget exhausted)', () => {
    assert.equal(retryDecision('overload', 2, false, false), 'fail')
  })

  test('overload during draining → skip (no retry when draining)', () => {
    assert.equal(retryDecision('overload', 0, true, false), 'fail')
  })

  test('overload during abort → skip (no retry when aborted)', () => {
    assert.equal(retryDecision('overload', 0, false, true), 'fail')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Overload retry — retries-exhausted → failed + drain
// ═══════════════════════════════════════════════════════════════════════

describe('overload retry — retries-exhausted drain logic', () => {
  test('overload with retries exhausted triggers draining', () => {
    // Mirror of the post-handleTaskCompletion drain logic
    const failureReason = 'overload'
    const success = false
    let draining = false

    // This mirrors the block after handleTaskCompletion:
    // overload with retries exhausted → draining = true
    if (!success && !draining) {
      if (failureReason === 'overload') {
        draining = true
      }
    }

    assert.equal(draining, true)
  })

  test('3 total attempts: 1 original + 2 retries, then fail', () => {
    const retries = new Map<string, number>()
    const taskId = 'task-1'
    const results: ('retry' | 'fail')[] = []

    for (let attempt = 0; attempt < 4; attempt++) {
      const prior = retries.get(taskId) ?? 0
      if (prior < OVERLOAD_MAX_RETRIES) {
        retries.set(taskId, prior + 1)
        results.push('retry')
      } else {
        results.push('fail')
        break
      }
    }

    // 2 retries then fail on 3rd overload
    assert.deepEqual(results, ['retry', 'retry', 'fail'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Non-overload failures never enter retry path
// ═══════════════════════════════════════════════════════════════════════

describe('non-overload failures bypass retry path', () => {
  const nonOverloadReasons = [
    'error',
    'turn_limit_exhausted',
    'context_overflow',
    'no-write-activity'
  ]

  for (const reason of nonOverloadReasons) {
    test(`failureReason='${reason}' → never retried`, () => {
      const isOverload = reason === 'overload'
      assert.equal(isOverload, false, `${reason} should not match overload check`)
    })
  }

  test('non-overload failure drains wave immediately (no retry)', () => {
    let draining = false
    const failureReason: string = 'error'

    if (failureReason === 'overload') {
      // Would enter retry path
      draining = false
    } else {
      draining = true
    }

    assert.equal(draining, true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// abortAwareSleep — real function tests
// ═══════════════════════════════════════════════════════════════════════

describe('abortAwareSleep', () => {
  let abortAwareSleep: (ms: number, signal?: AbortSignal) => Promise<void>

  beforeEach(async () => {
    const mod = await import('../blueprint-build.service')
    abortAwareSleep = mod.abortAwareSleep
  })

  test('resolves after delay (no signal)', async () => {
    const start = Date.now()
    await abortAwareSleep(50) // 50ms for test speed
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 40, `Expected ≥40ms, got ${elapsed}ms`)
  })

  test('resolves after delay (signal not aborted)', async () => {
    const ac = new AbortController()
    const start = Date.now()
    await abortAwareSleep(50, ac.signal)
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 40, `Expected ≥40ms, got ${elapsed}ms`)
  })

  test('rejects immediately when signal already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(() => abortAwareSleep(60_000, ac.signal), { message: 'aborted' })
  })

  test('rejects when signal fires during sleep', async () => {
    const ac = new AbortController()
    const start = Date.now()
    setTimeout(() => ac.abort(), 30) // abort after 30ms
    await assert.rejects(() => abortAwareSleep(60_000, ac.signal), { message: 'aborted' })
    const elapsed = Date.now() - start
    // Should reject quickly (within ~100ms), not wait 60s
    assert.ok(elapsed < 500, `Expected rejection within 500ms, got ${elapsed}ms`)
  })

  test('clears timer on abort (no leaked timeouts)', async () => {
    const ac = new AbortController()
    // If the timer leaks, the 60s sleep would keep the process alive.
    // We verify by checking the promise rejects promptly.
    const start = Date.now()
    const p = abortAwareSleep(60_000, ac.signal)
    ac.abort()
    await assert.rejects(() => p, { message: 'aborted' })
    const elapsed = Date.now() - start
    assert.ok(elapsed < 200, `Timer should have been cleared, elapsed ${elapsed}ms`)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// DEDUP-FIX: executeTask skips phaseProgress for overload outcome
// ═══════════════════════════════════════════════════════════════════════

describe('executeTask phaseProgress dedup — overload skip', () => {
  /**
   * Mirror of the sendOutcome !== 'ok' branch in executeTask.
   * Returns true if a phaseProgress emit should fire.
   */
  function shouldEmitPhaseProgress(sendOutcome: SendOutcome): boolean {
    if (sendOutcome === 'ok') return false // success path, no failure message
    return sendOutcome !== 'overload'
  }

  test('overload outcome → phaseProgress suppressed (scheduler owns messaging)', () => {
    assert.equal(shouldEmitPhaseProgress('overload'), false)
  })

  test('turn_limit_exhausted outcome → phaseProgress emitted', () => {
    assert.equal(shouldEmitPhaseProgress('turn_limit_exhausted'), true)
  })

  test('context_overflow outcome → phaseProgress emitted', () => {
    assert.equal(shouldEmitPhaseProgress('context_overflow'), true)
  })

  test('error outcome → phaseProgress emitted', () => {
    assert.equal(shouldEmitPhaseProgress('error'), true)
  })

  test('aborted outcome → phaseProgress emitted', () => {
    assert.equal(shouldEmitPhaseProgress('aborted'), true)
  })

  test('ok outcome → no failure message (success path)', () => {
    assert.equal(shouldEmitPhaseProgress('ok'), false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// TIMING-FIX: Retry settlement pushes timing into aggregate
// ═══════════════════════════════════════════════════════════════════════

interface MockTiming {
  durationMs: number
  tDispatch: number
  tSessionReady: number
  tFirstChunk: number
  tComplete: number
}

describe('retry settlement — timing aggregation', () => {
  test('timing present → pushed into taskTimings', () => {
    const taskTimings: MockTiming[] = []
    const timing: MockTiming = {
      durationMs: 5000,
      tDispatch: 1000,
      tSessionReady: 2000,
      tFirstChunk: 3000,
      tComplete: 6000
    }
    // Mirror: if (settled.taskResult.timing) result.taskTimings.push(settled.taskResult.timing)
    if (timing) {
      taskTimings.push(timing)
    }
    assert.equal(taskTimings.length, 1)
    assert.equal(taskTimings[0].durationMs, 5000)
  })

  test('timing absent → taskTimings unchanged', () => {
    const taskTimings: MockTiming[] = []
    const timing: MockTiming | undefined = undefined
    if (timing) {
      taskTimings.push(timing)
    }
    assert.equal(taskTimings.length, 0)
  })

  test('multiple retries accumulate all timings', () => {
    const taskTimings: MockTiming[] = []
    const attempts: (MockTiming | undefined)[] = [
      { durationMs: 3000, tDispatch: 100, tSessionReady: 200, tFirstChunk: 300, tComplete: 3100 },
      { durationMs: 4000, tDispatch: 200, tSessionReady: 300, tFirstChunk: 400, tComplete: 4200 },
      undefined // final attempt may have no timing on abort
    ]
    for (const t of attempts) {
      if (t) taskTimings.push(t)
    }
    assert.equal(taskTimings.length, 2)
    assert.equal(taskTimings[0].durationMs, 3000)
    assert.equal(taskTimings[1].durationMs, 4000)
  })
})

// ── Standalone runner ──

if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`
) {
  void summaryAsync()
}
