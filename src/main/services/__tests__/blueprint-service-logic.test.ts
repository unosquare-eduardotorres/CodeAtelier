/**
 * Unit tests for BlueprintService — pure-logic methods that don't require DB.
 *
 * Tests parsePhaseCompletion (regex + JSON parsing) and getPipelineStatus
 * (in-memory pipeline state map).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BlueprintService, PHASE_ARTIFACT_RELEVANCE } from '../blueprint.service'
import type { BlueprintPhaseType } from '../../../shared/blueprint-types'

describe('BlueprintService.parsePhaseCompletion', () => {
  const svc = new BlueprintService()

  test('valid_json_block_returns_parsed_object', () => {
    const text = `Some analysis text.

\`\`\`blueprint-phase-complete
{"score": 85, "summary": "Phase complete", "questions": ["Q1", "Q2"]}
\`\`\`

More text.`
    const result = svc.parsePhaseCompletion(text)
    assert.ok(result !== null)
    assert.equal(result!.score, 85)
    assert.equal(result!.summary, 'Phase complete')
    assert.deepEqual(result!.questions, ['Q1', 'Q2'])
  })

  test('no_code_block_returns_null', () => {
    const result = svc.parsePhaseCompletion('Just plain text, no code blocks.')
    assert.equal(result, null)
  })

  test('malformed_json_returns_null', () => {
    const text = `\`\`\`blueprint-phase-complete
{not valid json}
\`\`\``
    const result = svc.parsePhaseCompletion(text)
    assert.equal(result, null)
  })

  test('empty_string_returns_null', () => {
    const result = svc.parsePhaseCompletion('')
    assert.equal(result, null)
  })

  test('wrong_code_block_type_returns_null', () => {
    const text = `\`\`\`json
{"score": 85}
\`\`\``
    const result = svc.parsePhaseCompletion(text)
    assert.equal(result, null)
  })

  test('multiple_code_blocks_matches_first_blueprint_phase_complete', () => {
    const text = `\`\`\`blueprint-phase-complete
{"score": 70, "summary": "First"}
\`\`\`

Some text.

\`\`\`blueprint-phase-complete
{"score": 90, "summary": "Second"}
\`\`\``
    const result = svc.parsePhaseCompletion(text)
    assert.ok(result !== null)
    assert.equal(result!.score, 70)
    assert.equal(result!.summary, 'First')
  })

  test('score_field_preserved', () => {
    const text = `\`\`\`blueprint-phase-complete
{"score": 42}
\`\`\``
    const result = svc.parsePhaseCompletion(text)
    assert.ok(result !== null)
    assert.equal(result!.score, 42)
  })

  test('questions_array_preserved', () => {
    const text = `\`\`\`blueprint-phase-complete
{"questions": ["What framework?", "What database?"]}
\`\`\``
    const result = svc.parsePhaseCompletion(text)
    assert.ok(result !== null)
    assert.deepEqual(result!.questions, ['What framework?', 'What database?'])
  })

  test('handles_whitespace_after_language_tag', () => {
    const text = `\`\`\`blueprint-phase-complete  
{"score": 55}
\`\`\``
    const result = svc.parsePhaseCompletion(text)
    // The regex uses \s* after the tag, so trailing whitespace should match
    assert.ok(result !== null)
    assert.equal(result!.score, 55)
  })

  test('block_with_nested_objects_parses_correctly', () => {
    const text = `\`\`\`blueprint-phase-complete
{"score": 80, "details": {"strengths": ["a"], "weaknesses": ["b"]}}
\`\`\``
    const result = svc.parsePhaseCompletion(text)
    assert.ok(result !== null)
    assert.equal(result!.score, 80)
  })
})

describe('BlueprintService.getPipelineStatus', () => {
  test('unknown_workspaceId_returns_not_running', () => {
    const svc = new BlueprintService()
    const status = svc.getPipelineStatus('unknown-ws')
    assert.equal(status.running, false)
    assert.equal(status.blueprintId, null)
    assert.equal(status.currentPhase, null)
  })

  test('returns_correct_shape', () => {
    const svc = new BlueprintService()
    const status = svc.getPipelineStatus('any-ws')
    assert.equal(typeof status.running, 'boolean')
    assert.ok('blueprintId' in status)
    assert.ok('currentPhase' in status)
  })

  test('after_markPipelineRunning_returns_running_state', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-1', 'bp-1', 'specify')
    const status = svc.getPipelineStatus('ws-1')
    assert.equal(status.running, true)
    assert.equal(status.blueprintId, 'bp-1')
    assert.equal(status.currentPhase, 'specify')
  })

  test('after_markPipelineStopped_returns_not_running', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-2', 'bp-2', 'plan')
    svc.markPipelineStopped('ws-2')
    const status = svc.getPipelineStatus('ws-2')
    assert.equal(status.running, false)
  })

  test('isRunning_returns_false_for_unknown_workspace', () => {
    const svc = new BlueprintService()
    assert.equal(svc.isRunning('non-existent'), false)
  })

  test('isRunning_returns_true_after_markPipelineRunning', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-3', 'bp-3', 'clarify')
    assert.equal(svc.isRunning('ws-3'), true)
  })

  test('getActiveBlueprintId_returns_null_for_unknown_workspace', () => {
    const svc = new BlueprintService()
    assert.equal(svc.getActiveBlueprintId('non-existent'), null)
  })

  test('getActiveBlueprintId_returns_id_after_markPipelineRunning', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-4', 'bp-4', 'tasks')
    assert.equal(svc.getActiveBlueprintId('ws-4'), 'bp-4')
  })

  test('getAbortSignal_returns_null_for_unknown_workspace', () => {
    const svc = new BlueprintService()
    assert.equal(svc.getAbortSignal('non-existent'), null)
  })

  test('getAbortSignal_returns_signal_after_markPipelineRunning', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-5', 'bp-5', 'review')
    const signal = svc.getAbortSignal('ws-5')
    assert.ok(signal instanceof AbortSignal)
    assert.equal(signal!.aborted, false)
  })

  test('markPipelineStopped_clears_abortController', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-6', 'bp-6', 'build')
    svc.markPipelineStopped('ws-6')
    const signal = svc.getAbortSignal('ws-6')
    assert.equal(signal, null)
  })

  test('markPipelineStopped_is_safe_for_unknown_workspace', () => {
    const svc = new BlueprintService()
    // Should not throw
    svc.markPipelineStopped('non-existent')
    assert.ok(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  M5: failPipeline tests
// ═══════════════════════════════════════════════════════════════════════════

describe('BlueprintService.failPipeline', () => {
  test('failPipeline_from_phase_running_transitions_to_failed', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-f1', 'bp-f1', 'specify')
    svc.failPipeline('ws-f1', 'test error')
    const machine = svc.getMachine('ws-f1')
    assert.equal(machine.currentState, 'failed')
    assert.equal(svc.isRunning('ws-f1'), false)
  })

  test('failPipeline_from_awaiting_clarify_questions', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-f2', 'bp-f2', 'clarify')
    const machine = svc.getMachine('ws-f2')
    machine.transition('questionsParsed')
    svc.failPipeline('ws-f2', 'session died')
    assert.equal(machine.currentState, 'failed')
    assert.equal(svc.isRunning('ws-f2'), false)
  })

  test('failPipeline_from_awaiting_clarify_gate', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-f3', 'bp-f3', 'clarify')
    const machine = svc.getMachine('ws-f3')
    machine.transition('gateParsed')
    svc.failPipeline('ws-f3', 'gate error')
    assert.equal(machine.currentState, 'failed')
  })

  test('failPipeline_from_awaiting_approval', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-f4', 'bp-f4', 'review')
    const machine = svc.getMachine('ws-f4')
    machine.transition('approvalNeeded')
    svc.failPipeline('ws-f4', 'approval timeout')
    assert.equal(machine.currentState, 'failed')
  })

  test('failPipeline_from_idle_is_safe', () => {
    const svc = new BlueprintService()
    // Should not throw
    svc.failPipeline('ws-f5', 'no-op error')
    const machine = svc.getMachine('ws-f5')
    assert.equal(machine.currentState, 'idle')
  })

  test('failPipeline_stores_lastError_in_snapshot', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-f6', 'bp-f6', 'plan')
    svc.failPipeline('ws-f6', 'plan exploded')
    const snapshot = svc.getSnapshot('ws-f6')
    assert.equal(snapshot.lastError, 'plan exploded')
    assert.equal(snapshot.running, false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  M5: Watchdog assertMachineConsistency tests
// ═══════════════════════════════════════════════════════════════════════════

describe('BlueprintService.assertMachineConsistency', () => {
  test('idle_machine_is_consistent', () => {
    const svc = new BlueprintService()
    // Should not throw or change state
    svc.assertMachineConsistency('ws-w1')
    assert.equal(svc.getMachine('ws-w1').currentState, 'idle')
  })

  test('running_pipeline_is_consistent', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-w2', 'bp-w2', 'plan')
    svc.assertMachineConsistency('ws-w2')
    // Machine should remain in phase-running
    assert.equal(svc.getMachine('ws-w2').currentState, 'phase-running')
  })

  test('stranded_machine_gets_force_reset', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-w3', 'bp-w3', 'clarify')
    const machine = svc.getMachine('ws-w3')
    machine.transition('questionsParsed')
    // Manually set running=false to simulate crash
    svc.markPipelineStopped('ws-w3')
    // Machine is now idle (markPipelineStopped drives phaseComplete).
    // But if it were stuck in awaiting-clarify-questions without running=true...
    // Let's test with a forced state mismatch:
    // Force machine to a non-idle state without pipeline running
    machine.transition('startPhase', { blueprintId: 'bp-w3', phase: 'clarify' })
    machine.transition('questionsParsed')
    // Now machine is awaiting-clarify-questions but running=false and no session
    svc.assertMachineConsistency('ws-w3')
    assert.equal(machine.currentState, 'idle', 'Watchdog should have reset stranded machine')
  })

  test('terminal_machine_is_consistent', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-w4', 'bp-w4', 'build')
    svc.failPipeline('ws-w4', 'test')
    svc.assertMachineConsistency('ws-w4')
    // Machine should remain in failed state
    assert.equal(svc.getMachine('ws-w4').currentState, 'failed')
  })

  test('pending_approval_is_consistent', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('ws-w5', 'bp-w5', 'review')
    const machine = svc.getMachine('ws-w5')
    machine.transition('approvalNeeded')
    // Set approval state but clear running
    svc.setPendingApproval('ws-w5', { planSummary: 'test' })
    svc.markPipelineStopped('ws-w5')
    // Force back to awaiting approval
    machine.transition('startPhase', { blueprintId: 'bp-w5', phase: 'review' })
    machine.transition('approvalNeeded')
    // Should NOT force-reset because pendingApproval is set
    svc.assertMachineConsistency('ws-w5')
    assert.equal(machine.currentState, 'awaiting-approval')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  M9: setClarifyState tests
// ═══════════════════════════════════════════════════════════════════════════

describe('BlueprintService.setClarifyState', () => {
  test('setClarifyState_pushes_and_getClarifyStateForSnapshot_reads', () => {
    const svc = new BlueprintService()
    svc.setClarifyState('ws-c1', { findings: null, questions: null })
    const state = svc.getClarifyStateForSnapshot('ws-c1')
    assert.ok(state !== null)
    assert.equal(state!.findings, null)
  })

  test('setClarifyState_null_clears', () => {
    const svc = new BlueprintService()
    svc.setClarifyState('ws-c2', { findings: null, questions: null })
    svc.setClarifyState('ws-c2', null)
    const state = svc.getClarifyStateForSnapshot('ws-c2')
    assert.equal(state, null)
  })

  test('getSnapshot_uses_clarifyState', () => {
    const svc = new BlueprintService()
    const testFindings = {
      findings: [{ topic: 'test', status: 'outstanding' as const, detail: 'details' }]
    }
    svc.setClarifyState('ws-c3', { findings: testFindings as unknown as null, questions: null })
    const snapshot = svc.getSnapshot('ws-c3')
    assert.deepEqual(snapshot.clarifyFindings, testFindings)
  })
})

// ═════════════════════════════════════════════════════════════════════════
//  PHASE_ARTIFACT_RELEVANCE map — phase-aware artifact selection
// ═════════════════════════════════════════════════════════════════════════

describe('PHASE_ARTIFACT_RELEVANCE', () => {
  test('specify_has_no_relevant_artifact_types', () => {
    assert.equal(PHASE_ARTIFACT_RELEVANCE.specify.size, 0)
  })

  test('clarify_only_needs_spec', () => {
    assert.ok(PHASE_ARTIFACT_RELEVANCE.clarify.has('spec'))
    assert.equal(PHASE_ARTIFACT_RELEVANCE.clarify.size, 1)
  })

  test('plan_only_needs_spec_after_clarify_merge', () => {
    // Plan B: clarify merges resolutions into spec in-place, so plan only needs spec
    assert.ok(PHASE_ARTIFACT_RELEVANCE.plan.has('spec'))
    assert.ok(
      !PHASE_ARTIFACT_RELEVANCE.plan.has('clarify-qa'),
      'clarify-qa merged into spec by finalizeClarifyPhase'
    )
    assert.equal(PHASE_ARTIFACT_RELEVANCE.plan.size, 1)
  })

  test('tasks_needs_spec_and_plan', () => {
    assert.ok(PHASE_ARTIFACT_RELEVANCE.tasks.has('spec'))
    assert.ok(PHASE_ARTIFACT_RELEVANCE.tasks.has('plan'))
    assert.ok(
      !PHASE_ARTIFACT_RELEVANCE.tasks.has('clarify-qa'),
      'clarify-qa merged into spec by finalizeClarifyPhase'
    )
    assert.equal(PHASE_ARTIFACT_RELEVANCE.tasks.size, 2)
  })

  test('review_needs_spec_plan_tasks_discoveries', () => {
    const r = PHASE_ARTIFACT_RELEVANCE.review
    assert.ok(r.has('spec'))
    assert.ok(r.has('plan'))
    assert.ok(r.has('tasks'))
    assert.ok(r.has('discoveries'))
    assert.ok(!r.has('clarify-qa'), 'clarify-qa merged into spec by finalizeClarifyPhase')
    assert.equal(r.size, 4)
  })

  test('build_needs_plan_tasks_discoveries_but_not_spec', () => {
    const b = PHASE_ARTIFACT_RELEVANCE.build
    assert.ok(b.has('plan'))
    assert.ok(b.has('tasks'))
    assert.ok(b.has('discoveries'))
    assert.ok(!b.has('spec'), 'build should NOT include spec')
    assert.equal(b.size, 3)
  })

  test('verify_needs_spec_plan_build_discoveries_but_not_tasks', () => {
    const v = PHASE_ARTIFACT_RELEVANCE.verify
    assert.ok(v.has('spec'))
    assert.ok(v.has('plan'))
    assert.ok(v.has('build'))
    assert.ok(v.has('discoveries'))
    assert.ok(!v.has('tasks'), 'verify should NOT include full tasks JSON')
    assert.equal(v.size, 4)
  })

  test('no_phase_includes_clarify_qa_after_plan_b', () => {
    // Plan B: clarify-qa is merged into spec by finalizeClarifyPhase,
    // so no phase should reference it in the relevance map anymore
    const phases: BlueprintPhaseType[] = [
      'specify',
      'clarify',
      'plan',
      'tasks',
      'review',
      'build',
      'verify'
    ]
    for (const phase of phases) {
      assert.ok(
        !PHASE_ARTIFACT_RELEVANCE[phase].has('clarify-qa'),
        `${phase} should not reference clarify-qa — resolutions are merged into spec`
      )
    }
  })

  test('all_phases_are_covered', () => {
    const phases: BlueprintPhaseType[] = [
      'specify',
      'clarify',
      'plan',
      'tasks',
      'review',
      'build',
      'verify'
    ]
    for (const phase of phases) {
      assert.ok(phase in PHASE_ARTIFACT_RELEVANCE, `Missing phase: ${phase}`)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
