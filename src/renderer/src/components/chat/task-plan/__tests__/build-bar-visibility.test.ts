/**
 * BuildActionBar visibility rules.
 *
 * Run: tsx src/renderer/src/components/chat/task-plan/__tests__/build-bar-visibility.test.ts
 */
import assert from 'node:assert/strict'
import {
  test,
  describe,
  summaryAsync
} from '../../../../../../main/services/__tests__/test-harness'
import { isBuildRunning, isPlanLocked, type ExecutionLike } from '../build-bar-visibility'

function exec(phaseStatuses: string[], opts: { completedAt?: number } = {}): ExecutionLike {
  return {
    completedAt: opts.completedAt,
    phases: phaseStatuses.map((status) => ({ status }))
  }
}

describe('isBuildRunning', () => {
  test('no execution record is not running', () => {
    assert.equal(isBuildRunning(undefined), false)
    assert.equal(isBuildRunning(null), false)
  })

  test('a phase in progress is running', () => {
    assert.equal(isBuildRunning(exec(['completed', 'in_progress', 'pending'])), true)
  })

  test('a started phase is running', () => {
    assert.equal(isBuildRunning(exec(['started'])), true)
  })

  test('completedAt short-circuits even if a phase looks in-flight', () => {
    // The live IPC completion event is authoritative.
    assert.equal(isBuildRunning(exec(['in_progress'], { completedAt: 123 })), false)
  })

  test('all phases terminal is not running', () => {
    assert.equal(isBuildRunning(exec(['completed', 'failed', 'skipped'])), false)
  })

  test('a pending-only execution is not running', () => {
    // startExecution seeds every phase as 'pending'; the build has not begun.
    assert.equal(isBuildRunning(exec(['pending', 'pending'])), false)
  })

  test('REGRESSION: a hydrated finished build is not running despite no completedAt', () => {
    // chat.store re-creates the record on conversation load and never calls
    // completeExecution, so completedAt is absent. Treating that as "running"
    // permanently hid the action bar for every later plan in the conversation.
    const hydrated = exec(['completed', 'completed'], { completedAt: undefined })
    assert.equal(isBuildRunning(hydrated), false)
  })

  test('a zero-phase execution is not running', () => {
    // Phase-less plans always create a record (D2) but expose no phase signal —
    // isStreaming is what covers them during the build.
    assert.equal(isBuildRunning(exec([])), false)
  })
})

describe('isPlanLocked', () => {
  test('an unactioned plan with no execution is unlocked', () => {
    assert.equal(isPlanLocked({ planAction: undefined, execution: undefined }), false)
  })

  test('any persisted planAction locks the plan', () => {
    for (const action of ['build', 'refine', 'save_as_idea', 'council']) {
      assert.equal(isPlanLocked({ planAction: action, execution: undefined }), true, action)
    }
  })

  test('a running build locks an otherwise unactioned plan', () => {
    // Mid-build emit_plan replaces latestPlanMsg, so planAction is empty on the
    // new message — the running build is what keeps the bar hidden across the
    // 50-200ms gaps where isStreaming drops between phases.
    assert.equal(isPlanLocked({ planAction: undefined, execution: exec(['in_progress']) }), true)
  })

  test('REGRESSION: a new plan after a completed build is unlocked', () => {
    // The plan-iterate-after-build flow: the conversation still holds the old
    // execution record, but the new plan message has no planAction and must be
    // buildable.
    assert.equal(
      isPlanLocked({ planAction: undefined, execution: exec(['completed', 'completed']) }),
      false
    )
  })

  test('REGRESSION: a new plan after a hydrated build is unlocked', () => {
    assert.equal(
      isPlanLocked({
        planAction: undefined,
        execution: exec(['completed'], { completedAt: undefined })
      }),
      false
    )
  })

  test('an empty-string planAction does not lock', () => {
    assert.equal(isPlanLocked({ planAction: '', execution: undefined }), false)
  })

  test('REGRESSION: a stale in-flight phase does not lock once the chat is idle', () => {
    // The bug: models routinely never emit the final emit_phase_progress, so a
    // phase stays 'in_progress' and completeExecution never runs. Every plan
    // after the first Build Now in the conversation stayed locked.
    assert.equal(
      isPlanLocked({ planAction: undefined, execution: exec(['in_progress']), buildIdle: true }),
      false
    )
  })

  test('a mid-build emit_plan still locks while the stream is live', () => {
    // Preserves the fix isBuildRunning was added for: buildIdle is false while
    // the agent is working, so the replacement plan message stays locked.
    assert.equal(
      isPlanLocked({ planAction: undefined, execution: exec(['in_progress']), buildIdle: false }),
      true
    )
  })

  test('planAction outranks buildIdle — the same plan never re-arms', () => {
    assert.equal(
      isPlanLocked({ planAction: 'build', execution: exec(['in_progress']), buildIdle: true }),
      true
    )
  })

  test('REGRESSION: a hydrated interrupted build is unlocked once idle', () => {
    // chat.store rehydrates persisted phase statuses verbatim, so a build killed
    // by a restart comes back as 'in_progress' with no completedAt.
    assert.equal(
      isPlanLocked({
        planAction: undefined,
        execution: exec(['completed', 'in_progress'], { completedAt: undefined }),
        buildIdle: true
      }),
      false
    )
  })

  test('omitting buildIdle preserves the previous behaviour', () => {
    assert.equal(isPlanLocked({ planAction: undefined, execution: exec(['started']) }), true)
    assert.equal(isPlanLocked({ planAction: undefined, execution: exec(['completed']) }), false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
