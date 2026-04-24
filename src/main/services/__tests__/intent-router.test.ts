/**
 * Unit tests for IntentRouter — routes AgentIntent values to IPC channels.
 *
 * Pure logic: uses mock BrowserWindow to capture IPC sends.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { createIntentRouter } from './helpers/agent-factory'
import type { AgentIntent } from '../../../shared/types'

describe('IntentRouter', () => {
  test('routes_plan_intent_to_CHAT_PLAN_channel', () => {
    const { router, sentMessages } = createIntentRouter()
    const intent: AgentIntent = {
      type: 'plan',
      plan: {
        rawContent: '## My Plan\n1. Step one',
        structuredPlan: null,
        beforePlan: 'intro',
        afterPlan: 'outro'
      }
    }

    router.route('conv-1', intent)

    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].channel, 'chat:plan')
    const payload = sentMessages[0].payload as Record<string, unknown>
    assert.equal(payload.conversationId, 'conv-1')
    assert.equal(payload.rawContent, '## My Plan\n1. Step one')
  })

  test('routes_askUser_intent_to_CHAT_ASK_QUESTION_channel', () => {
    const { router, sentMessages } = createIntentRouter()
    const intent: AgentIntent = {
      type: 'askUser',
      questions: [
        { id: 'q1', question: 'Which DB?', options: [{ label: 'Postgres' }] }
      ]
    }

    router.route('conv-2', intent)

    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].channel, 'chat:askQuestion')
    const payload = sentMessages[0].payload as Record<string, unknown>
    assert.equal(payload.conversationId, 'conv-2')
    assert.ok(Array.isArray(payload.questions))
    assert.equal((payload.questions as unknown[]).length, 1)
  })

  test('routes_grillQuestion_intent_to_CHAT_GRILL_QUESTION_channel', () => {
    const { router, sentMessages } = createIntentRouter()
    const intent: AgentIntent = {
      type: 'grillQuestion',
      questions: [
        { id: 'gq1', question: 'What approach?', options: [{ label: 'A' }, { label: 'B' }] }
      ]
    }

    router.route('conv-3', intent)

    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].channel, 'chat:grillQuestion')
    const payload = sentMessages[0].payload as Record<string, unknown>
    assert.equal(payload.conversationId, 'conv-3')
    assert.equal((payload.questions as unknown[]).length, 1)
  })

  test('routes_grillComplete_intent_to_CHAT_GRILL_COMPLETE_channel', () => {
    const { router, sentMessages } = createIntentRouter()
    const intent: AgentIntent = {
      type: 'grillComplete',
      summary: 'Requirements gathered successfully',
      proposedTasks: [{ title: 'Task 1', description: 'Do the thing' }]
    }

    router.route('conv-4', intent)

    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].channel, 'chat:grillComplete')
    const payload = sentMessages[0].payload as Record<string, unknown>
    assert.equal(payload.conversationId, 'conv-4')
    assert.equal(payload.summary, 'Requirements gathered successfully')
    assert.equal((payload.proposedTasks as unknown[]).length, 1)
  })

  test('routes_grillEvaluation_intent_to_CHAT_GRILL_EVALUATION_channel', () => {
    const { router, sentMessages } = createIntentRouter()
    const intent: AgentIntent = {
      type: 'grillEvaluation',
      evaluation: {
        score: 7,
        scoreLabel: 'Good',
        feedback: 'Solid answers',
        questions: [{ id: 'eq1', question: 'Anything else?', options: [] }]
      }
    }

    router.route('conv-5', intent)

    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].channel, 'chat:grillEvaluation')
    const payload = sentMessages[0].payload as Record<string, unknown>
    assert.equal(payload.conversationId, 'conv-5')
    assert.equal(payload.score, 7)
    assert.equal(payload.scoreLabel, 'Good')
  })

  test('does_not_send_IPC_for_response_intent', () => {
    const { router, sentMessages } = createIntentRouter()
    const intent: AgentIntent = { type: 'response', content: 'Hello world' }

    router.route('conv-6', intent)

    assert.equal(sentMessages.length, 0, 'response intent should not send IPC')
  })

})
