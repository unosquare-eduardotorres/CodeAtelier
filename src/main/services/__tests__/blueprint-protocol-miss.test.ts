/**
 * blueprint-protocol-miss.test.ts
 *
 * GLM-PROTOCOL-MISS fixes — unit tests.
 *
 * 1. `shouldPassProtocolMissAsUnproven` — the "wrote but didn't sign" gate:
 *    all-zero verification + cumulative write activity + planned files ⇒ pass
 *    as unproven; zero-activity tasks never pass (they hard-fail separately),
 *    and (P1) a Bash-only task passes only when the gate baseline diff proves
 *    the tree actually changed.
 * 5. `infraFailureFingerprint` — the P3 repeated-infra signature predicate.
 * 2. `isRetryableError` — the protocol-miss failureReason stays retryable
 *    (message-only rewording must not silently de-retry).
 * 3. `isProtocolMissRung` — the poisoned-transcript signature predicate
 *    (GLM-PROTOCOL-MISS-04).
 * 4. `decideResume` — returns `poisoned-transcript` when the streak ≥ 1.
 *
 * (The `humanizeFailureReason` UI-wording assertions live in the renderer
 * test task-failure-display.test.ts — same file as the function under test.)
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  BlueprintBuildService,
  infraFailureFingerprint,
  INFRA_REPEAT_BUDGET,
  INFRA_REPEAT_FAILURE_REASON,
  isProtocolMissRung,
  PROTOCOL_MISS_BUDGET,
  PROTOCOL_MISS_BUDGET_FAILURE_REASON,
  shouldPassProtocolMissAsUnproven
} from '../blueprint-build.service'
import { BlueprintService } from '../blueprint.service'

// ═══════════════════════════════════════════════════════════════════════════
// shouldPassProtocolMissAsUnproven
// ═══════════════════════════════════════════════════════════════════════════

describe('shouldPassProtocolMissAsUnproven — wrote-but-didnt-sign gate', () => {
  test('passes when all-zero + write tool calls + planned files', () => {
    assert.equal(
      shouldPassProtocolMissAsUnproven({
        allZero: true,
        cumulativeWriteToolCalls: 3,
        cumulativeBashCalls: 0,
        hasPlannedFiles: true,
        // Not consulted when a write tool fired — asserted explicitly below.
        baselineDiffEmpty: true
      }),
      true
    )
  })

  test('write activity is decided by the counters — the diff is not consulted', () => {
    // Regression guard for P1: the new baseline check must apply ONLY to the
    // zero-write shape. A task that wrote and then reverted its own change
    // (empty diff) still passes exactly as before.
    for (const baselineDiffEmpty of [true, false, null]) {
      assert.equal(
        shouldPassProtocolMissAsUnproven({
          allZero: true,
          cumulativeWriteToolCalls: 2,
          cumulativeBashCalls: 0,
          hasPlannedFiles: true,
          baselineDiffEmpty
        }),
        true,
        `writes > 0 must pass regardless of baselineDiffEmpty=${String(baselineDiffEmpty)}`
      )
    }
  })

  test('P1 — Bash-only passes ONLY when the baseline diff proves the tree changed', () => {
    // A task can legitimately do all its work through a generator script, which
    // is why bash > 0 is allowed to reach the pass at all — but the evidence is
    // the diff, not the counter.
    assert.equal(
      shouldPassProtocolMissAsUnproven({
        allZero: true,
        cumulativeWriteToolCalls: 0,
        cumulativeBashCalls: 2,
        hasPlannedFiles: true,
        baselineDiffEmpty: false
      }),
      true
    )
  })

  test('P1 — the R013 shape (writes=0, bash=3, nothing changed) now FAILS', () => {
    // Live incident: three `git status --porcelain` calls that hung without
    // executing, and a planned README.md that had existed for hours. The old
    // AND-guard accepted that as "work". Bash count is not write evidence.
    assert.equal(
      shouldPassProtocolMissAsUnproven({
        allZero: true,
        cumulativeWriteToolCalls: 0,
        cumulativeBashCalls: 3,
        hasPlannedFiles: true,
        baselineDiffEmpty: true
      }),
      false
    )
  })

  test('P1 — an unanswerable diff does NOT grant a zero-write pass', () => {
    // Deliberately the opposite default to shouldFailForNoWriteActivity: there,
    // null falls back to the counters and preserves prior behaviour. Here the
    // counters are exactly what proved untrustworthy, so "we cannot measure it"
    // must not be read as "it happened".
    assert.equal(
      shouldPassProtocolMissAsUnproven({
        allZero: true,
        cumulativeWriteToolCalls: 0,
        cumulativeBashCalls: 3,
        hasPlannedFiles: true,
        baselineDiffEmpty: null
      }),
      false
    )
  })

  test('fails when there was zero activity at all — zero-write tasks must keep failing', () => {
    assert.equal(
      shouldPassProtocolMissAsUnproven({
        allZero: true,
        cumulativeWriteToolCalls: 0,
        cumulativeBashCalls: 0,
        hasPlannedFiles: true,
        baselineDiffEmpty: false
      }),
      false,
      'no tools ran at all — a non-empty diff belongs to someone else'
    )
  })

  test('fails when verification is not all-zero (real discrepancies exist)', () => {
    assert.equal(
      shouldPassProtocolMissAsUnproven({
        allZero: false,
        cumulativeWriteToolCalls: 5,
        cumulativeBashCalls: 1,
        hasPlannedFiles: true,
        baselineDiffEmpty: false
      }),
      false
    )
  })

  test('fails when the task has no planned files (nothing to anchor the pass)', () => {
    assert.equal(
      shouldPassProtocolMissAsUnproven({
        allZero: true,
        cumulativeWriteToolCalls: 2,
        cumulativeBashCalls: 0,
        hasPlannedFiles: false,
        baselineDiffEmpty: false
      }),
      false
    )
  })

  test('all-zero but missing planned files is NOT all-zero — regression guard', () => {
    // If the verifier reports missingPlanned > 0, allZero is false and the
    // protocol-miss branch must not fire; that shape is a genuine failure.
    assert.equal(
      shouldPassProtocolMissAsUnproven({
        allZero: false,
        cumulativeWriteToolCalls: 4,
        cumulativeBashCalls: 0,
        hasPlannedFiles: true,
        baselineDiffEmpty: false
      }),
      false
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Poisoned-transcript signature — isProtocolMissRung (GLM-PROTOCOL-MISS-04)
// ═══════════════════════════════════════════════════════════════════════════

describe('isProtocolMissRung — truth table', () => {
  const REASON =
    'verification failed — no completion block in CLI output (protocol miss — ' +
    'model did not emit the required blueprint-phase-complete block)'

  test('protocol-miss failure + zero new writes ⇒ true (streak-worthy)', () => {
    assert.equal(
      isProtocolMissRung({
        success: false,
        failureReason: REASON,
        writesBefore: 4,
        writesAfter: 4
      }),
      true
    )
  })

  test('protocol-miss failure WITH new writes ⇒ false (recoverable kind)', () => {
    assert.equal(
      isProtocolMissRung({
        success: false,
        failureReason: REASON,
        writesBefore: 4,
        writesAfter: 7
      }),
      false
    )
  })

  test('executor-error failure carrying the protocol-miss text ⇒ false (transport, not protocol)', () => {
    assert.equal(
      isProtocolMissRung({
        success: false,
        failureReason: `executor error: stream died after protocol miss ${REASON}`,
        writesBefore: 0,
        writesAfter: 0
      }),
      false
    )
  })

  test('success or a different failure ⇒ false (streak resets)', () => {
    assert.equal(
      isProtocolMissRung({
        success: true,
        failureReason: undefined,
        writesBefore: 0,
        writesAfter: 0
      }),
      false
    )
    assert.equal(
      isProtocolMissRung({
        success: false,
        failureReason: 'BUILD-T001 phase stalled — no activity for 5m',
        writesBefore: 2,
        writesAfter: 2
      }),
      false
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// decideResume — poisoned-transcript escape (GLM-PROTOCOL-MISS-04)
// ═══════════════════════════════════════════════════════════════════════════

describe('decideResume — poisoned-transcript escape', () => {
  // Prototype access, same pattern as blueprint-build.service.test.ts: the
  // service never reads instance state before the protocol-miss branch we are
  // exercising (appPreferenceRepository is a module singleton already stubbed
  // by the shared electron stub / setup-full-mock).
  const decide = (
    BlueprintBuildService.prototype as unknown as {
      decideResume: (p: Record<string, unknown>) => Promise<{ resume: boolean; reason?: string }>
    }
  ).decideResume

  const baseParams = {
    blueprintId: 'bp-test',
    taskId: 'T001',
    attempt: 2,
    convId: 'blueprint-build-bp-test-T001',
    generation: 0,
    outcome: 'error' as const,
    resumeSafe: true,
    providerAtStart: 'anthropic' as const,
    workspacePath: '/tmp/test-ws',
    previousRungWasResume: false,
    previousResumableSessionId: 'ses_stale123',
    previousSessionPoisoned: false,
    executeAttempt: 1
  }

  test('streak ≥ 1 ⇒ resume denied with reason poisoned-transcript', async () => {
    const decision = await decide.call(new BlueprintBuildService(), {
      ...baseParams,
      consecutiveProtocolMisses: 1
    })
    assert.equal(decision.resume, false)
    assert.equal(decision.reason, 'poisoned-transcript')
  })

  test('streak 0 ⇒ the escape does not fire (decision falls through to the permit)', async () => {
    const decision = await decide.call(new BlueprintBuildService(), { ...baseParams })
    assert.notEqual(decision.reason, 'poisoned-transcript')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Retry classification — protocol miss must remain retryable
// ═══════════════════════════════════════════════════════════════════════════

describe('isRetryableError — protocol-miss wording', () => {
  test('the new protocol-miss failureReason is retryable', () => {
    const reason =
      'verification failed — no completion block in CLI output (protocol miss — model did not emit the required blueprint-phase-complete block)'
    assert.equal(BlueprintService.isRetryableErrorStatic(reason), true)
  })

  test('bare "protocol miss" is retryable (pattern survives wording drift)', () => {
    assert.equal(BlueprintService.isRetryableErrorStatic('protocol miss'), true)
  })

  test('the legacy API/transport-error wording stays retryable', () => {
    assert.equal(
      BlueprintService.isRetryableErrorStatic(
        'verification failed — no completion block in CLI output (turn likely ended in an API/transport error)'
      ),
      true
    )
  })

  test('protocol-miss reason does not collide with NON_RETRYABLE patterns', () => {
    const reason =
      'verification failed — no completion block in CLI output (protocol miss — model did not emit the required blueprint-phase-complete block)'
    assert.doesNotMatch(reason, /cancelled/i)
    assert.doesNotMatch(reason, /max.?turns/i)
    assert.doesNotMatch(reason, /budget/i)
    assert.doesNotMatch(reason, /parse.*fail/i)
    assert.doesNotMatch(reason, /Cannot retry/i)
    assert.doesNotMatch(reason, /not found/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// D4 — consecutive protocol-miss budget
// ═══════════════════════════════════════════════════════════════════════════

describe('D4 — protocol-miss budget', () => {
  test('budget is 3 (three consecutive misses exhaust it)', () => {
    assert.equal(PROTOCOL_MISS_BUDGET, 3)
  })

  test('the budget failure reason is NON-retryable (scheduleAutoRetry refuses)', () => {
    assert.equal(
      BlueprintService.isRetryableErrorStatic(PROTOCOL_MISS_BUDGET_FAILURE_REASON),
      false,
      'the budget-exhaustion wording must not fund an auto retry'
    )
  })

  test('the budget failure reason does NOT match the retryable /protocol miss/i pattern', () => {
    // Hyphenated "protocol-miss" deliberately — the retryable pattern matches
    // "protocol miss" (space), so this exhaustion wording stays non-retryable.
    assert.doesNotMatch(PROTOCOL_MISS_BUDGET_FAILURE_REASON, /protocol miss/i)
    assert.match(PROTOCOL_MISS_BUDGET_FAILURE_REASON, /budget/i)
  })

  test('a success rung resets the streak (a stochastic model is never budgeted out)', () => {
    // miss, miss, success ⇒ streak 0 — the fold in recordRungEvidence resets
    // on any rung that is NOT the isProtocolMissRung signature.
    const outcomes = [
      isProtocolMissRung({
        success: false,
        failureReason: 'verification failed — no completion block (protocol miss)',
        writesBefore: 0,
        writesAfter: 0
      }),
      isProtocolMissRung({
        success: false,
        failureReason: 'verification failed — no completion block (protocol miss)',
        writesBefore: 0,
        writesAfter: 0
      }),
      isProtocolMissRung({ success: true, writesBefore: 0, writesAfter: 4 })
    ]
    let streak = 0
    for (const miss of outcomes) streak = miss ? streak + 1 : 0
    assert.equal(streak, 0, 'a success between misses resets the counter')
  })

  test('three consecutive misses reach the budget (fold simulation)', () => {
    const misses = [true, true, true]
    let streak = 0
    for (const miss of misses) streak = miss ? streak + 1 : 0
    assert.ok(streak >= PROTOCOL_MISS_BUDGET, 'three misses exhaust the budget')
    assert.ok(streak >= PROTOCOL_MISS_BUDGET)
  })
})

// ════════════════════════════════════════════════════════════════════════
// P3 — repeated-infra budget (infraFailureFingerprint)
// ════════════════════════════════════════════════════════════════════════

describe('infraFailureFingerprint — truth table', () => {
  const STALL = 'no prompt activity within 300000ms'

  test('an infra failure yields a fingerprint', () => {
    assert.equal(
      infraFailureFingerprint({ success: false, failureClass: 'infra', failureReason: STALL }),
      'no prompt activity within #ms'
    )
  })

  test('digits are normalised — the same stall at a different timeout is the SAME failure', () => {
    // This is the point of the normalisation: fb03fdff moved the windows, and a
    // streak must not reset just because the number in the message changed.
    assert.equal(
      infraFailureFingerprint({ success: false, failureClass: 'infra', failureReason: STALL }),
      infraFailureFingerprint({
        success: false,
        failureClass: 'infra',
        failureReason: 'no prompt activity within 480000ms'
      })
    )
  })

  test('different infra failures do not fold together', () => {
    assert.notEqual(
      infraFailureFingerprint({ success: false, failureClass: 'infra', failureReason: STALL }),
      infraFailureFingerprint({
        success: false,
        failureClass: 'infra',
        failureReason: 'executor error: OpenCode server died mid-turn'
      })
    )
  })

  test('success, quality and aborted rungs yield null (no streak)', () => {
    assert.equal(
      infraFailureFingerprint({ success: true, failureClass: 'infra', failureReason: STALL }),
      null
    )
    // Quality failures are what the retry ladder EXISTS for — never capped here.
    assert.equal(
      infraFailureFingerprint({
        success: false,
        failureClass: 'quality',
        failureReason: 'task-tests gate failed'
      }),
      null
    )
    assert.equal(
      infraFailureFingerprint({
        success: false,
        failureClass: 'aborted',
        failureReason: 'aborted'
      }),
      null
    )
    assert.equal(infraFailureFingerprint({ success: false, failureClass: 'infra' }), null)
  })

  test('protocol misses are excluded — they have their own budget', () => {
    // Double counting would cut PROTOCOL_MISS_BUDGET's recovery nudges short.
    assert.equal(
      infraFailureFingerprint({
        success: false,
        failureClass: 'infra',
        failureReason:
          'verification failed — no completion block in CLI output (protocol miss — ' +
          'model did not emit the required blueprint-phase-complete block)'
      }),
      null
    )
  })

  test('three identical infra failures exhaust the budget; a different one resets (fold simulation)', () => {
    const fold = (reasons: (string | null)[]): number => {
      let streak = 0
      let last: string | null = null
      for (const reason of reasons) {
        const fp = reason
          ? infraFailureFingerprint({
              success: false,
              failureClass: 'infra',
              failureReason: reason
            })
          : null
        if (fp !== null && fp === last) streak++
        else streak = fp === null ? 0 : 1
        last = fp
      }
      return streak
    }
    // R010/R011/R012's shape: the same dead wait, over and over.
    assert.ok(fold([STALL, STALL, STALL]) >= INFRA_REPEAT_BUDGET)
    // A success in the middle resets it.
    assert.equal(fold([STALL, STALL, null, STALL]), 1)
    // So does a genuinely different infra failure.
    assert.equal(fold([STALL, STALL, 'executor error: server died', STALL]), 1)
  })

  test('the repeated-infra failure reason is NON-retryable (scheduleAutoRetry refuses)', () => {
    assert.equal(
      BlueprintService.isRetryableErrorStatic(INFRA_REPEAT_FAILURE_REASON),
      false,
      'the exhaustion wording must not fund another identical wait'
    )
  })

  test('the exhaustion wording does not re-match the retryable no-activity pattern', () => {
    // It must not carry the very phrase it is reporting on, or scheduleAutoRetry
    // would classify it as the transient failure it is meant to stop.
    assert.doesNotMatch(INFRA_REPEAT_FAILURE_REASON, /no prompt activity within/i)
    assert.match(INFRA_REPEAT_FAILURE_REASON, /budget/i)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
