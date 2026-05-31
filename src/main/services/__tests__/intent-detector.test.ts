/**
 * Unit tests for IntentDetector — stateless intent extraction from control tool state
 * and accumulated text (grill blocks).
 *
 * Pure logic: no filesystem, no network, no real Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { createIntentDetector } from './helpers/agent-factory'
import type { ControlToolState, AgentIntent } from '../../../shared/types'

/** Helper to build an empty ControlToolState */
function emptyControlState(): ControlToolState {
  return { plan: false, askUser: false, memory: false }
}

describe('IntentDetector', () => {
  test('returns_empty_array_when_no_intents_detected', () => {
    const { detector } = createIntentDetector()
    const result = detector.detectAll('Hello, how can I help?', emptyControlState(), 'plan')
    assert.deepEqual(result, [])
  })

  test('detects_plan_intent_from_controlToolState', () => {
    const { detector } = createIntentDetector()
    const planIntent: AgentIntent & { type: 'plan' } = {
      type: 'plan',
      plan: {
        rawContent: '## Plan\n1. Do thing',
        structuredPlan: null,
        beforePlan: '',
        afterPlan: ''
      }
    }
    const controlState: ControlToolState = {
      ...emptyControlState(),
      plan: true,
      planIntent
    }

    const result = detector.detectAll('some text', controlState, 'plan')
    assert.equal(result.length, 1)
    assert.equal(result[0].type, 'plan')
  })

  test('detects_askUser_intent_from_controlToolState', () => {
    const { detector } = createIntentDetector()
    const askUserIntent: AgentIntent & { type: 'askUser' } = {
      type: 'askUser',
      questions: [
        { id: 'q1', question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }
      ]
    }
    const controlState: ControlToolState = {
      ...emptyControlState(),
      askUser: true,
      askUserIntent
    }

    const result = detector.detectAll('asking...', controlState, 'plan')
    assert.equal(result.length, 1)
    assert.equal(result[0].type, 'askUser')
  })

  test('detects_grill_summary_from_accumulated_text', () => {
    const { detector } = createIntentDetector()
    const text =
      'Some preamble\n```grill-summary\n{"summary": "All good", "proposedTasks": [{"title": "T1", "description": "D1"}]}\n```\nAfter'

    const result = detector.detectAll(text, emptyControlState(), 'plan')
    assert.equal(result.length, 1)
    assert.equal(result[0].type, 'grillComplete')
    const intent = result[0] as AgentIntent & { type: 'grillComplete' }
    assert.equal(intent.summary, 'All good')
    assert.equal(intent.proposedTasks.length, 1)
    assert.equal(intent.proposedTasks[0].title, 'T1')
  })

  test('detects_grill_questions_from_accumulated_text', () => {
    const { detector } = createIntentDetector()
    const text =
      '```grill-question\n{"questions": [{"id": "q1", "question": "What stack?", "options": [{"label": "React"}]}]}\n```'

    const result = detector.detectAll(text, emptyControlState(), 'plan')
    assert.equal(result.length, 1)
    assert.equal(result[0].type, 'grillQuestion')
    const intent = result[0] as AgentIntent & { type: 'grillQuestion' }
    assert.equal(intent.questions.length, 1)
    assert.equal(intent.questions[0].id, 'q1')
  })

  test('detects_grill_evaluation_from_accumulated_text', () => {
    const { detector } = createIntentDetector()
    const text =
      '```grill-evaluation\n{"score": 8, "scoreLabel": "Great", "feedback": "Nice work", "questions": [{"id": "q1", "question": "Next?", "options": []}]}\n```'

    const result = detector.detectAll(text, emptyControlState(), 'plan')
    assert.equal(result.length, 1)
    assert.equal(result[0].type, 'grillEvaluation')
    const intent = result[0] as AgentIntent & { type: 'grillEvaluation' }
    assert.equal(intent.evaluation.score, 8)
    assert.equal(intent.evaluation.scoreLabel, 'Great')
    assert.equal(intent.evaluation.feedback, 'Nice work')
  })

  test('handles_malformed_grill_json_gracefully', () => {
    const { detector } = createIntentDetector()
    const text = '```grill-summary\n{invalid json here}\n```'

    const result = detector.detectAll(text, emptyControlState(), 'plan')
    assert.deepEqual(result, [], 'malformed JSON should not crash, returns empty')
  })

  test('combines_multiple_intents_in_one_turn', () => {
    const { detector } = createIntentDetector()
    const planIntent: AgentIntent & { type: 'plan' } = {
      type: 'plan',
      plan: { rawContent: 'plan content', structuredPlan: null, beforePlan: '', afterPlan: '' }
    }
    const controlState: ControlToolState = {
      ...emptyControlState(),
      plan: true,
      planIntent
    }
    const text =
      '```grill-question\n{"questions": [{"id": "q1", "question": "Confirm?", "options": []}]}\n```'

    const result = detector.detectAll(text, controlState, 'plan')
    assert.equal(result.length, 2, 'should have plan + grillQuestion')
    const types = result.map((i) => i.type)
    assert.ok(types.includes('plan'), 'should include plan')
    assert.ok(types.includes('grillQuestion'), 'should include grillQuestion')
  })

  test('detects_multiple_grill_evaluation_blocks', () => {
    const { detector } = createIntentDetector()
    const block1 =
      '```grill-evaluation\n{"score": 5, "scoreLabel": "OK", "feedback": "Decent", "questions": [{"id": "q1", "question": "A?", "options": []}]}\n```'
    const block2 =
      '```grill-evaluation\n{"score": 9, "scoreLabel": "Excellent", "feedback": "Perfect", "questions": [{"id": "q2", "question": "B?", "options": []}]}\n```'
    const text = `First block:\n${block1}\nSecond block:\n${block2}`

    const result = detector.detectAll(text, emptyControlState(), 'plan')
    const evals = result.filter((i) => i.type === 'grillEvaluation')
    assert.equal(evals.length, 2, 'should detect both grill-evaluation blocks')
    const eval1 = (evals[0] as AgentIntent & { type: 'grillEvaluation' }).evaluation
    const eval2 = (evals[1] as AgentIntent & { type: 'grillEvaluation' }).evaluation
    assert.equal(eval1.score, 5)
    assert.equal(eval2.score, 9)
  })
})
