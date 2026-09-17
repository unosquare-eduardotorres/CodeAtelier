/**
 * Unit tests for BlueprintService — pure-logic methods that don't require DB.
 *
 * Tests parsePhaseCompletion (regex + JSON parsing) and getPipelineStatus
 * (in-memory pipeline state map).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  BlueprintService,
  PHASE_ARTIFACT_RELEVANCE,
  MIRRORED_ARTIFACT_TYPES,
  keepNewestArtifactPerType
} from '../blueprint.service'
import type { BlueprintArtifact, BlueprintPhaseType } from '../../../shared/blueprint-types'

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
    svc.markPipelineRunning('bp-1', 'specify', 'ws-1')
    const status = svc.getPipelineStatus('ws-1')
    assert.equal(status.running, true)
    assert.equal(status.blueprintId, 'bp-1')
    assert.equal(status.currentPhase, 'specify')
  })

  test('after_markPipelineStopped_returns_not_running', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-2', 'plan', 'ws-2')
    svc.markPipelineStopped('bp-2')
    const status = svc.getPipelineStatus('ws-2')
    assert.equal(status.running, false)
  })

  test('isRunning_returns_false_for_unknown_workspace', () => {
    const svc = new BlueprintService()
    assert.equal(svc.isRunning('non-existent'), false)
  })

  test('isRunning_returns_true_after_markPipelineRunning', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-3', 'clarify', 'ws-3')
    assert.equal(svc.isRunning('bp-3'), true)
  })

  test('getActiveBlueprintId_returns_null_for_unknown_workspace', () => {
    const svc = new BlueprintService()
    assert.equal(svc.getActiveBlueprintId('non-existent'), null)
  })

  test('getActiveBlueprintId_returns_id_after_markPipelineRunning', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-4', 'tasks', 'ws-4')
    assert.equal(svc.getActiveBlueprintId('ws-4'), 'bp-4')
  })

  test('getAbortSignal_returns_null_for_unknown_workspace', () => {
    const svc = new BlueprintService()
    assert.equal(svc.getAbortSignal('non-existent'), null)
  })

  test('getAbortSignal_returns_signal_after_markPipelineRunning', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-5', 'review', 'ws-5')
    const signal = svc.getAbortSignal('bp-5')
    assert.ok(signal instanceof AbortSignal)
    assert.equal(signal!.aborted, false)
  })

  test('markPipelineStopped_clears_abortController', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-6', 'build', 'ws-6')
    svc.markPipelineStopped('bp-6')
    const signal = svc.getAbortSignal('bp-6')
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
    svc.markPipelineRunning('bp-f1', 'specify', 'ws-f1')
    svc.failPipeline('bp-f1', 'test error')
    const machine = svc.getMachine('bp-f1')
    assert.equal(machine.currentState, 'failed')
    assert.equal(svc.isRunning('bp-f1'), false)
  })

  test('failPipeline_from_awaiting_clarify_questions', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-f2', 'clarify', 'ws-f2')
    const machine = svc.getMachine('bp-f2')
    machine.transition('questionsParsed')
    svc.failPipeline('bp-f2', 'session died')
    assert.equal(machine.currentState, 'failed')
    assert.equal(svc.isRunning('bp-f2'), false)
  })

  test('failPipeline_from_awaiting_clarify_gate', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-f3', 'clarify', 'ws-f3')
    const machine = svc.getMachine('bp-f3')
    machine.transition('gateParsed')
    svc.failPipeline('bp-f3', 'gate error')
    assert.equal(machine.currentState, 'failed')
  })

  test('failPipeline_from_awaiting_approval', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-f4', 'review', 'ws-f4')
    const machine = svc.getMachine('bp-f4')
    machine.transition('approvalNeeded')
    svc.failPipeline('bp-f4', 'approval timeout')
    assert.equal(machine.currentState, 'failed')
  })

  test('failPipeline_from_idle_is_safe', () => {
    const svc = new BlueprintService()
    // Should not throw
    svc.failPipeline('bp-f5', 'no-op error')
    const machine = svc.getMachine('bp-f5')
    assert.equal(machine.currentState, 'idle')
  })

  test('failPipeline_stores_lastError_in_snapshot', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-f6', 'plan', 'ws-f6')
    svc.failPipeline('bp-f6', 'plan exploded')
    const snapshot = svc.getSnapshot('bp-f6')
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
    svc.assertMachineConsistency('bp-w1')
    assert.equal(svc.getMachine('bp-w1').currentState, 'idle')
  })

  test('running_pipeline_is_consistent', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-w2', 'plan', 'ws-w2')
    svc.assertMachineConsistency('bp-w2')
    // Machine should remain in phase-running
    assert.equal(svc.getMachine('bp-w2').currentState, 'phase-running')
  })

  test('stranded_machine_gets_force_reset', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-w3', 'clarify', 'ws-w3')
    const machine = svc.getMachine('bp-w3')
    machine.transition('questionsParsed')
    // Manually set running=false to simulate crash
    svc.markPipelineStopped('bp-w3')
    // Machine is now idle (markPipelineStopped drives phaseComplete).
    // But if it were stuck in awaiting-clarify-questions without running=true...
    // Let's test with a forced state mismatch:
    // Force machine to a non-idle state without pipeline running
    machine.transition('startPhase', { blueprintId: 'bp-w3', phase: 'clarify' })
    machine.transition('questionsParsed')
    // Now machine is awaiting-clarify-questions but running=false and no session
    svc.assertMachineConsistency('bp-w3')
    assert.equal(machine.currentState, 'idle', 'Watchdog should have reset stranded machine')
  })

  test('terminal_machine_is_consistent', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-w4', 'build', 'ws-w4')
    svc.failPipeline('bp-w4', 'test')
    svc.assertMachineConsistency('bp-w4')
    // Machine should remain in failed state
    assert.equal(svc.getMachine('bp-w4').currentState, 'failed')
  })

  test('pending_approval_is_consistent', () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-w5', 'review', 'ws-w5')
    const machine = svc.getMachine('bp-w5')
    machine.transition('approvalNeeded')
    // Set approval state but clear running
    svc.setPendingApproval('ws-w5', { blueprintId: 'bp-w5', planSummary: 'test' })
    svc.markPipelineStopped('ws-w5')
    // Force back to awaiting approval
    machine.transition('startPhase', { blueprintId: 'bp-w5', phase: 'review' })
    machine.transition('approvalNeeded')
    // Should NOT force-reset because pendingApproval is set
    svc.assertMachineConsistency('bp-w5')
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

  test('build_needs_plan_discoveries_but_not_spec_or_tasks', () => {
    const b = PHASE_ARTIFACT_RELEVANCE.build
    assert.ok(b.has('plan'))
    assert.ok(b.has('discoveries'))
    assert.ok(!b.has('spec'), 'build should NOT include spec')
    assert.ok(
      !b.has('tasks'),
      'build gets its task from `## Current Task` (blueprint_tasks rows), not the tasks artifact'
    )
    assert.equal(b.size, 2)
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

  test('no_phase_ever_receives_the_preflight_artifact', () => {
    // SECURITY. Preflight checks embed internal hostnames and DSN targets
    // (`cache.internal:6379`, `db.corp.example:5432`) in their messages. The
    // REVIEW phase persists them as a `preflight` artifact, and everything in
    // this map is rendered into a phase prompt and sent to the model provider.
    // Today preflight is excluded from every set — but only by omission, which
    // one "give the reviewer better context" edit silently undoes. This test is
    // the thing that stops that edit.
    const phases: BlueprintPhaseType[] = [
      'specify',
      'clarify',
      'plan',
      'tasks',
      'review',
      'build',
      'code-review',
      'verify'
    ]
    for (const phase of phases) {
      assert.ok(
        !PHASE_ARTIFACT_RELEVANCE[phase].has('preflight'),
        `${phase} must not receive the preflight artifact — it leaks internal hostnames to the model provider`
      )
    }
  })

  test('the_preflight_artifact_is_never_mirrored_to_disk', () => {
    // Same exposure by a second route: mirrored types are written to
    // `blueprints/<name>/<type>.md` and the phase prompts explicitly tell the
    // agent it may Read those files.
    assert.ok(
      !MIRRORED_ARTIFACT_TYPES.has('preflight'),
      'mirroring preflight puts internal hostnames in a file the prompts invite the agent to Read'
    )
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

// ══════════════════════════════════════════════════════════════════
//  A9 — keepNewestArtifactPerType (pure)
// ══════════════════════════════════════════════════════════════════

describe('keepNewestArtifactPerType', () => {
  const a = (type: string, contentMd: string): BlueprintArtifact =>
    ({ type, contentMd }) as BlueprintArtifact

  test('keeps the last artifact of each duplicated type', () => {
    const out = keepNewestArtifactPerType([a('plan', 'v1'), a('plan', 'v2'), a('spec', 's')])
    assert.deepEqual(
      out.map((x) => x.contentMd),
      ['v2', 's']
    )
  })

  test('preserves relative order of the survivors', () => {
    const out = keepNewestArtifactPerType([
      a('spec', 's1'),
      a('plan', 'p1'),
      a('spec', 's2'),
      a('tasks', 't1')
    ])
    assert.deepEqual(
      out.map((x) => x.type),
      ['plan', 'spec', 'tasks']
    )
  })

  test('discoveries are exempt — formatArtifacts merges entries across them', () => {
    const out = keepNewestArtifactPerType([
      a('discoveries', 'd1'),
      a('discoveries', 'd2'),
      a('discoveries', 'd3')
    ])
    assert.equal(out.length, 3)
  })

  test('*-partial artifacts are exempt — they are the retry payload', () => {
    const out = keepNewestArtifactPerType([
      a('plan', 'p'),
      a('plan-partial', 'attempt-1'),
      a('plan-partial', 'attempt-2')
    ])
    assert.equal(out.length, 3)
  })

  test('empty input and single artifacts pass through untouched', () => {
    assert.deepEqual(keepNewestArtifactPerType([]), [])
    const one = [a('plan', 'only')]
    assert.deepEqual(keepNewestArtifactPerType(one), one)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
