/**
 * Unit tests for BlueprintService — pure-logic methods that don't require DB.
 *
 * Tests parsePhaseCompletion (regex + JSON parsing) and getPipelineStatus
 * (in-memory pipeline state map).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BlueprintService } from '../blueprint.service'

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

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
