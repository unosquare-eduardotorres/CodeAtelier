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
  test('plan_intent_logs_but_does_not_send_IPC', () => {
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

    // Plan data reaches the renderer through the streaming pipeline (TaskPlanCard),
    // so no dedicated IPC channel is needed.
    assert.equal(
      sentMessages.length,
      0,
      'plan intent should not send IPC — data arrives via streaming'
    )
  })

  test('routes_askUser_intent_to_CHAT_ASK_QUESTION_channel', () => {
    const { router, sentMessages } = createIntentRouter()
    const intent: AgentIntent = {
      type: 'askUser',
      questions: [{ id: 'q1', question: 'Which DB?', options: [{ label: 'Postgres' }] }]
    }

    router.route('conv-2', intent)

    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].channel, 'chat:askQuestion')
    const payload = sentMessages[0].payload as Record<string, unknown>
    assert.equal(payload.conversationId, 'conv-2')
    assert.ok(Array.isArray(payload.questions))
    assert.equal((payload.questions as unknown[]).length, 1)
  })

  test('grill_intents_are_no_ops_in_intent_router', () => {
    // Legacy chat-integrated grill flow is now handled by the dedicated grill system
    // (grill.ipc.ts). IntentRouter no longer sends CHAT_GRILL_* IPC messages.
    const { router, sentMessages } = createIntentRouter()

    router.route('conv-3', {
      type: 'grillQuestion',
      questions: [
        { id: 'gq1', question: 'What approach?', options: [{ label: 'A' }, { label: 'B' }] }
      ]
    })

    router.route('conv-4', {
      type: 'grillComplete',
      summary: 'Requirements gathered successfully',
      proposedTasks: [{ title: 'Task 1', description: 'Do the thing' }]
    })

    router.route('conv-5', {
      type: 'grillEvaluation',
      evaluation: {
        score: 7,
        scoreLabel: 'Good',
        feedback: 'Solid answers',
        questions: [{ id: 'eq1', question: 'Anything else?', options: [] }]
      }
    })

    assert.equal(
      sentMessages.length,
      0,
      'grill intents should not send IPC — handled by dedicated grill system'
    )
  })

  test('does_not_send_IPC_for_response_intent', () => {
    const { router, sentMessages } = createIntentRouter()
    const intent: AgentIntent = { type: 'response', content: 'Hello world' }

    router.route('conv-6', intent)

    assert.equal(sentMessages.length, 0, 'response intent should not send IPC')
  })
})
