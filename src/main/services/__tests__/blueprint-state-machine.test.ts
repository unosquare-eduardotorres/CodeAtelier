/**
 * BlueprintStateMachine — transition table unit tests.
 *
 * Validates: valid transitions, invalid transitions (rejected),
 * idempotent-when-idle, forceReset, context management, and
 * stateChange event emission.
 */

import assert from 'node:assert/strict'
import { describe, test } from './test-harness'
import { BlueprintStateMachine, type BlueprintStateChangePayload } from '../blueprint-state-machine'

/** Fresh machine per test — avoids async test runner clobbering. */
function make(wsId = 'ws-test'): BlueprintStateMachine {
  return new BlueprintStateMachine(wsId)
}

describe('BlueprintStateMachine', () => {
  // ── Initial State ──

  test('starts in idle state', () => {
    const sm = make()
    assert.equal(sm.currentState, 'idle')
    assert.equal(sm.blueprintId, null)
    assert.equal(sm.phase, null)
    assert.equal(sm.workspaceId, 'ws-test')
  })

  test('isIdle() returns true initially', () => {
    const sm = make()
    assert.equal(sm.isIdle(), true)
    assert.equal(sm.isRunning(), false)
    assert.equal(sm.isAwaitingInput(), false)
    assert.equal(sm.isTerminal(), false)
  })

  // ── Valid Transitions: Happy Path ──

  test('idle → startPhase → phase-running', () => {
    const sm = make()
    const result = sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    assert.equal(result, true)
    assert.equal(sm.currentState, 'phase-running')
    assert.equal(sm.blueprintId, 'bp-1')
    assert.equal(sm.phase, 'specify')
    assert.equal(sm.isRunning(), true)
  })

  test('phase-running → phaseComplete → idle', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    const result = sm.transition('phaseComplete')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'idle')
    assert.equal(sm.blueprintId, null)
    assert.equal(sm.phase, null)
  })

  test('full specify → clarify → plan phase chain', () => {
    const sm = make()
    // specify starts
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    assert.equal(sm.currentState, 'phase-running')

    // specify completes
    sm.transition('phaseComplete')
    assert.equal(sm.currentState, 'idle')

    // clarify starts
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    assert.equal(sm.currentState, 'phase-running')
    assert.equal(sm.phase, 'clarify')

    // questions parsed
    sm.transition('questionsParsed')
    assert.equal(sm.currentState, 'awaiting-clarify-questions')

    // answer received
    sm.transition('answerReceived')
    assert.equal(sm.currentState, 'phase-running')

    // gate parsed (completion)
    sm.transition('gateParsed')
    assert.equal(sm.currentState, 'awaiting-clarify-gate')

    // proceed to plan
    sm.transition('proceedGate')
    assert.equal(sm.currentState, 'idle')

    // plan starts
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'plan' })
    assert.equal(sm.currentState, 'phase-running')
    assert.equal(sm.phase, 'plan')
  })

  // ── Clarify Sub-States ──

  test('phase-running → questionsParsed → awaiting-clarify-questions', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    const result = sm.transition('questionsParsed')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'awaiting-clarify-questions')
    assert.equal(sm.isClarifyState(), true)
    assert.equal(sm.isAwaitingInput(), true)
  })

  test('phase-running → awaitingInput → awaiting-clarify-input', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    const result = sm.transition('awaitingInput')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'awaiting-clarify-input')
    assert.equal(sm.isClarifyState(), true)
  })

  test('phase-running → gateParsed → awaiting-clarify-gate', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    const result = sm.transition('gateParsed')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'awaiting-clarify-gate')
    assert.equal(sm.isClarifyState(), true)
  })

  test('awaiting-clarify-gate → iterate → phase-running (more clarify)', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('gateParsed')
    const result = sm.transition('iterate')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'phase-running')
  })

  test('awaiting-clarify-gate → proceedGate → idle', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('gateParsed')
    const result = sm.transition('proceedGate')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'idle')
    assert.equal(sm.blueprintId, null)
  })

  // ── Approval Flow ──

  test('phase-running → approvalNeeded → awaiting-approval', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'review' })
    const result = sm.transition('approvalNeeded')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'awaiting-approval')
    assert.equal(sm.isAwaitingInput(), true)
    assert.equal(sm.isClarifyState(), false)
  })

  test('awaiting-approval → approvalResponded → idle', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'review' })
    sm.transition('approvalNeeded')
    const result = sm.transition('approvalResponded')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'idle')
  })

  // ── Cancel from every active state ──

  test('cancel from phase-running → cancelled', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    const result = sm.transition('cancel')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'cancelled')
    assert.equal(sm.isTerminal(), true)
  })

  test('cancel from awaiting-clarify-questions → cancelled', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('questionsParsed')
    const result = sm.transition('cancel')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'cancelled')
  })

  test('cancel from awaiting-clarify-input → cancelled', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('awaitingInput')
    const result = sm.transition('cancel')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'cancelled')
  })

  test('cancel from awaiting-clarify-gate → cancelled', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('gateParsed')
    const result = sm.transition('cancel')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'cancelled')
  })

  test('cancel from awaiting-approval → cancelled', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'review' })
    sm.transition('approvalNeeded')
    const result = sm.transition('cancel')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'cancelled')
  })

  // ── Fail ──

  test('fail from phase-running → failed', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    const result = sm.transition('fail')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'failed')
    assert.equal(sm.isTerminal(), true)
  })

  test('fail from awaiting-clarify-questions → failed', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('questionsParsed')
    const result = sm.transition('fail')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'failed')
  })

  // ── Retry ──

  test('retry from cancelled → idle', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    sm.transition('cancel')
    const result = sm.transition('retry')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'idle')
    assert.equal(sm.blueprintId, null)
  })

  test('retry from failed → idle', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    sm.transition('fail')
    const result = sm.transition('retry')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'idle')
  })

  // ── Invalid Transitions (rejected) ──

  test('startPhase from phase-running is invalid', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    const result = sm.transition('startPhase', { blueprintId: 'bp-2', phase: 'clarify' })
    assert.equal(result, false)
    assert.equal(sm.currentState, 'phase-running')
    assert.equal(sm.blueprintId, 'bp-1')
  })

  test('answerReceived from phase-running is invalid', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    const result = sm.transition('answerReceived')
    assert.equal(result, false)
    assert.equal(sm.currentState, 'phase-running')
  })

  test('questionsParsed from idle is invalid', () => {
    const sm = make()
    const result = sm.transition('questionsParsed')
    assert.equal(result, false)
    assert.equal(sm.currentState, 'idle')
  })

  test('proceedGate from phase-running is invalid', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    const result = sm.transition('proceedGate')
    assert.equal(result, false)
    assert.equal(sm.currentState, 'phase-running')
  })

  test('iterate from awaiting-clarify-questions is invalid', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('questionsParsed')
    const result = sm.transition('iterate')
    assert.equal(result, false)
    assert.equal(sm.currentState, 'awaiting-clarify-questions')
  })

  test('retry from idle is invalid', () => {
    const sm = make()
    const result = sm.transition('retry')
    assert.equal(result, false)
    assert.equal(sm.currentState, 'idle')
  })

  test('retry from phase-running is invalid', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    const result = sm.transition('retry')
    assert.equal(result, false)
    assert.equal(sm.currentState, 'phase-running')
  })

  test('startPhase from cancelled is invalid (must retry first)', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    sm.transition('cancel')
    const result = sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    assert.equal(result, false)
    assert.equal(sm.currentState, 'cancelled')
  })

  // ── Idempotent-When-Idle ──

  test('phaseComplete when already idle is idempotent (returns true)', () => {
    const sm = make()
    const result = sm.transition('phaseComplete')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'idle')
  })

  test('cancel when already idle is idempotent (returns true)', () => {
    const sm = make()
    const result = sm.transition('cancel')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'idle')
  })

  test('proceedGate when already idle is idempotent (returns true)', () => {
    const sm = make()
    const result = sm.transition('proceedGate')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'idle')
  })

  test('approvalResponded when already idle is idempotent (returns true)', () => {
    const sm = make()
    const result = sm.transition('approvalResponded')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'idle')
  })

  // ── Idempotent awaitingInput (duplicate event while already awaiting) ──

  test('awaitingInput from awaiting-clarify-input is idempotent (returns true, state unchanged)', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('awaitingInput')
    assert.equal(sm.currentState, 'awaiting-clarify-input')
    const result = sm.transition('awaitingInput')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'awaiting-clarify-input')
  })

  test('awaitingInput from awaiting-clarify-questions is idempotent (returns true, state unchanged)', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('questionsParsed')
    assert.equal(sm.currentState, 'awaiting-clarify-questions')
    const result = sm.transition('awaitingInput')
    assert.equal(result, true)
    assert.equal(sm.currentState, 'awaiting-clarify-questions')
  })

  test('stateChange NOT emitted on idempotent awaitingInput no-op', () => {
    const sm = make()
    const events: BlueprintStateChangePayload[] = []
    sm.on('stateChange', (p: BlueprintStateChangePayload) => events.push(p))

    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('awaitingInput')
    const countAfterFirst = events.length
    sm.transition('awaitingInput') // duplicate — no-op
    assert.equal(events.length, countAfterFirst)
  })

  test('awaitingInput from awaiting-clarify-gate is still invalid (not in idempotent set)', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('gateParsed')
    assert.equal(sm.currentState, 'awaiting-clarify-gate')
    const result = sm.transition('awaitingInput')
    assert.equal(result, false)
    assert.equal(sm.currentState, 'awaiting-clarify-gate')
  })

  // ── Context Management ──

  test('context (blueprintId, phase) is cleared on transition to idle', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    assert.equal(sm.blueprintId, 'bp-1')
    assert.equal(sm.phase, 'specify')

    sm.transition('phaseComplete')
    assert.equal(sm.blueprintId, null)
    assert.equal(sm.phase, null)
  })

  test('context is preserved through non-idle transitions', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('questionsParsed')
    assert.equal(sm.blueprintId, 'bp-1')
    assert.equal(sm.phase, 'clarify')

    sm.transition('answerReceived')
    assert.equal(sm.blueprintId, 'bp-1')
    assert.equal(sm.phase, 'clarify')
  })

  test('phase is updated when new phase context is provided', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    assert.equal(sm.phase, 'specify')

    sm.transition('phaseComplete')
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    assert.equal(sm.phase, 'clarify')
  })

  test('context is preserved in cancelled/failed state', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    sm.transition('cancel')
    assert.equal(sm.blueprintId, 'bp-1')
    assert.equal(sm.phase, 'specify')
    assert.equal(sm.currentState, 'cancelled')
  })

  test('context is cleared on retry (returns to idle)', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    sm.transition('cancel')
    sm.transition('retry')
    assert.equal(sm.blueprintId, null)
    assert.equal(sm.phase, null)
    assert.equal(sm.currentState, 'idle')
  })

  // ── forceReset ──

  test('forceReset from phase-running → idle', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    sm.forceReset()
    assert.equal(sm.currentState, 'idle')
    assert.equal(sm.blueprintId, null)
    assert.equal(sm.phase, null)
  })

  test('forceReset from awaiting-clarify-gate → idle', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('gateParsed')
    sm.forceReset()
    assert.equal(sm.currentState, 'idle')
  })

  test('forceReset from cancelled → idle', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    sm.transition('cancel')
    sm.forceReset()
    assert.equal(sm.currentState, 'idle')
  })

  test('forceReset from idle is harmless', () => {
    const sm = make()
    sm.forceReset()
    assert.equal(sm.currentState, 'idle')
  })

  // ── Event Emission ──

  test('stateChange event emitted on valid transition', () => {
    const sm = make()
    const events: BlueprintStateChangePayload[] = []
    sm.on('stateChange', (p: BlueprintStateChangePayload) => events.push(p))

    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })

    assert.equal(events.length, 1)
    assert.equal(events[0].from, 'idle')
    assert.equal(events[0].to, 'phase-running')
    assert.equal(events[0].event, 'startPhase')
    assert.equal(events[0].blueprintId, 'bp-1')
    assert.equal(events[0].phase, 'specify')
    assert.equal(events[0].workspaceId, 'ws-test')
  })

  test('stateChange event NOT emitted on invalid transition', () => {
    const sm = make()
    const events: BlueprintStateChangePayload[] = []
    sm.on('stateChange', (p: BlueprintStateChangePayload) => events.push(p))

    sm.transition('questionsParsed') // invalid from idle
    assert.equal(events.length, 0)
  })

  test('stateChange event NOT emitted on idempotent no-op', () => {
    const sm = make()
    const events: BlueprintStateChangePayload[] = []
    sm.on('stateChange', (p: BlueprintStateChangePayload) => events.push(p))

    sm.transition('phaseComplete') // idempotent when idle
    assert.equal(events.length, 0)
  })

  test('forceReset emits stateChange with forceReset event', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })

    const events: BlueprintStateChangePayload[] = []
    sm.on('stateChange', (p: BlueprintStateChangePayload) => events.push(p))

    sm.forceReset()

    assert.equal(events.length, 1)
    assert.equal(events[0].from, 'phase-running')
    assert.equal(events[0].to, 'idle')
    assert.equal(events[0].event, 'forceReset')
    assert.equal(events[0].blueprintId, null)
    assert.equal(events[0].phase, null)
  })

  // ── Full Pipeline Sequence ──

  test('full 7-phase pipeline: specify → clarify (with Q&A) → plan → tasks → review (approval) → build → verify', () => {
    const sm = make()

    // SPECIFY
    assert.equal(sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' }), true)
    assert.equal(sm.transition('phaseComplete'), true)

    // CLARIFY — with questions, answer, then gate
    assert.equal(sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' }), true)
    assert.equal(sm.transition('questionsParsed'), true)
    assert.equal(sm.transition('answerReceived'), true)
    assert.equal(sm.transition('gateParsed'), true)
    assert.equal(sm.transition('iterate'), true)
    assert.equal(sm.transition('gateParsed'), true)
    assert.equal(sm.transition('proceedGate'), true)

    // PLAN
    assert.equal(sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'plan' }), true)
    assert.equal(sm.transition('phaseComplete'), true)

    // TASKS
    assert.equal(sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'tasks' }), true)
    assert.equal(sm.transition('phaseComplete'), true)

    // REVIEW — with approval gate
    assert.equal(sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'review' }), true)
    assert.equal(sm.transition('approvalNeeded'), true)
    assert.equal(sm.transition('approvalResponded'), true)

    // BUILD
    assert.equal(sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'build' }), true)
    assert.equal(sm.transition('phaseComplete'), true)

    // VERIFY
    assert.equal(sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'verify' }), true)
    assert.equal(sm.transition('phaseComplete'), true)

    assert.equal(sm.currentState, 'idle')
  })

  // ── Cancel Mid-Stream + Retry ──

  test('cancel mid-clarify then retry resumes cleanly', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    sm.transition('questionsParsed')
    sm.transition('cancel')
    assert.equal(sm.currentState, 'cancelled')
    assert.equal(sm.isTerminal(), true)

    sm.transition('retry')
    assert.equal(sm.currentState, 'idle')
    assert.equal(sm.isIdle(), true)

    // Can start again
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'clarify' })
    assert.equal(sm.currentState, 'phase-running')
  })

  test('fail mid-build then retry resumes cleanly', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'build' })
    sm.transition('fail')
    assert.equal(sm.currentState, 'failed')

    sm.transition('retry')
    assert.equal(sm.currentState, 'idle')

    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'build' })
    assert.equal(sm.currentState, 'phase-running')
  })

  // ── Multiple workspaces are isolated ──

  test('two machines for different workspaces are independent', () => {
    const sm1 = make('ws-1')
    const sm2 = make('ws-2')

    sm1.transition('startPhase', { blueprintId: 'bp-1', phase: 'specify' })
    assert.equal(sm1.currentState, 'phase-running')
    assert.equal(sm2.currentState, 'idle')

    sm2.transition('startPhase', { blueprintId: 'bp-2', phase: 'build' })
    assert.equal(sm2.currentState, 'phase-running')
    assert.equal(sm2.blueprintId, 'bp-2')
    assert.equal(sm1.blueprintId, 'bp-1')
  })
})

// ── C2 FIX: late terminal events are absorbed in non-running states ──

describe('BlueprintStateMachine — late terminal event absorption', () => {
  // Regression origin (log-confirmed 22:17:10): review ends at the approval
  // gate, then the finally block's markPipelineStopped → phaseComplete fires
  // 12ms later → `Invalid transition: awaiting-approval + phaseComplete`.

  test('awaiting-approval + phaseComplete → absorbed, state unchanged', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'review' })
    sm.transition('approvalNeeded')
    assert.equal(sm.currentState, 'awaiting-approval')

    const result = sm.transition('phaseComplete')
    assert.equal(result, true, 'late completion after the gate is a race, not an error')
    assert.equal(sm.currentState, 'awaiting-approval', 'gate state stays intact')

    // The gate still works afterward
    assert.equal(sm.transition('approvalResponded'), true)
    assert.equal(sm.currentState, 'idle')
  })

  test('cancelled + phaseComplete → absorbed, stays cancelled', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'build' })
    sm.transition('cancel')
    assert.equal(sm.currentState, 'cancelled')

    assert.equal(sm.transition('phaseComplete'), true)
    assert.equal(sm.currentState, 'cancelled')
  })

  test('cancelled + fail → absorbed, stays cancelled', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'build' })
    sm.transition('cancel')

    assert.equal(sm.transition('fail'), true)
    assert.equal(sm.currentState, 'cancelled', 'cancel won — late fail must not flip to failed')
  })

  test('failed + phaseComplete → absorbed, stays failed', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'verify' })
    sm.transition('fail')

    assert.equal(sm.transition('phaseComplete'), true)
    assert.equal(sm.currentState, 'failed')
  })

  test('absorbed events emit no stateChange', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'review' })
    sm.transition('approvalNeeded')

    let changes = 0
    sm.on('stateChange', () => changes++)
    sm.transition('phaseComplete') // absorbed
    assert.equal(changes, 0, 'absorption is a no-op — no stateChange emitted')
  })

  test('genuine invalid transitions still return false', () => {
    const sm = make()
    // idle + questionsParsed is genuinely invalid
    assert.equal(sm.transition('questionsParsed'), false)

    // awaiting-approval + answerReceived is genuinely invalid
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'review' })
    sm.transition('approvalNeeded')
    assert.equal(sm.transition('answerReceived'), false)
    assert.equal(sm.currentState, 'awaiting-approval')
  })

  test('cancelled + approvalNeeded is NOT absorbed (genuinely invalid)', () => {
    const sm = make()
    sm.transition('startPhase', { blueprintId: 'bp-1', phase: 'review' })
    sm.transition('cancel')
    // approvalNeeded from cancelled is not in the absorption table
    assert.equal(sm.transition('approvalNeeded'), false)
    assert.equal(sm.currentState, 'cancelled')
  })
})
