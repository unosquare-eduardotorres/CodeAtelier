/**
 * Unit tests for ConversationStateMachine — the state machine that tracks
 * conversation lifecycle (idle → chat-agent-streaming → complete → idle).
 *
 * Pure logic: no filesystem, no network, no real Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { createConversationStateMachine, createMockBrowserWindow } from './helpers/agent-factory'

describe('ConversationStateMachine', () => {
  test('starts_in_idle_state', () => {
    const { stateMachine } = createConversationStateMachine()
    assert.equal(stateMachine.currentState, 'idle')
  })

  test('transitions_from_idle_to_chat_agent_streaming_on_sendMessage', () => {
    const { stateMachine } = createConversationStateMachine()
    const result = stateMachine.transition('sendMessage', 'conv-1')
    assert.equal(result, true)
    assert.equal(stateMachine.currentState, 'chat-agent-streaming')
  })

  test('returns_to_idle_on_chatAgentComplete', () => {
    const { stateMachine } = createConversationStateMachine()

    assert.equal(stateMachine.transition('sendMessage', 'conv-1'), true)
    assert.equal(stateMachine.currentState, 'chat-agent-streaming')

    assert.equal(stateMachine.transition('chatAgentComplete'), true)
    assert.equal(stateMachine.currentState, 'idle')
  })

  test('returns_to_idle_on_messageFinalised_from_streaming', () => {
    const { stateMachine } = createConversationStateMachine()
    stateMachine.transition('sendMessage', 'conv-1')
    assert.equal(stateMachine.transition('messageFinalised'), true)
    assert.equal(stateMachine.currentState, 'idle')
  })

  test('rejects_invalid_transition_and_returns_false', () => {
    const { stateMachine } = createConversationStateMachine()
    // idle + streamError is invalid (streamError only valid from streaming)
    const result = stateMachine.transition('streamError')
    assert.equal(result, false)
    assert.equal(stateMachine.currentState, 'idle', 'state should remain idle')
  })

  test('emits_stateChange_event_on_valid_transition', () => {
    const { stateMachine, stateChanges } = createConversationStateMachine()
    stateMachine.transition('sendMessage', 'conv-42')

    assert.equal(stateChanges.length, 1)
    assert.equal(stateChanges[0].from, 'idle')
    assert.equal(stateChanges[0].to, 'chat-agent-streaming')
    assert.equal(stateChanges[0].event, 'sendMessage')
  })

  test('sends_IPC_state_change_to_renderer', () => {
    const { stateMachine, sentMessages } = createConversationStateMachine()
    stateMachine.transition('sendMessage', 'conv-99')

    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].channel, 'chat:stateChange')
    const payload = sentMessages[0].payload as Record<string, unknown>
    assert.equal(payload.from, 'idle')
    assert.equal(payload.to, 'chat-agent-streaming')
    assert.equal(payload.event, 'sendMessage')
  })

  test('does_not_send_IPC_when_window_destroyed', () => {
    const { ConversationStateMachine } = require('../conversation-state-machine') as {
      ConversationStateMachine: new () => InstanceType<
        typeof import('../conversation-state-machine').ConversationStateMachine
      >
    }
    const sm = new ConversationStateMachine()
    const { window, sentMessages } = createMockBrowserWindow({ destroyed: true })
    sm.setMainWindow(window as unknown as import('electron').BrowserWindow)

    // Should not throw, and should not send
    sm.transition('sendMessage', 'conv-dead')
    assert.equal(sentMessages.length, 0, 'no IPC sent when window is destroyed')
    assert.equal(sm.currentState, 'chat-agent-streaming')
  })

  test('idempotent_transitions_when_already_idle', () => {
    const { stateMachine, stateChanges } = createConversationStateMachine()
    assert.equal(stateMachine.currentState, 'idle')

    // These events should be no-ops in idle state (return true but no state change)
    assert.equal(stateMachine.transition('messageFinalised'), true)
    assert.equal(stateMachine.transition('errorHandled'), true)
    assert.equal(stateMachine.transition('cleanupComplete'), true)
    assert.equal(stateMachine.transition('chatAgentComplete'), true)

    assert.equal(stateMachine.currentState, 'idle')
    // No stateChange events emitted for idempotent no-ops
    assert.equal(stateChanges.length, 0, 'no stateChange events for idle no-ops')
  })

  test('tracks_conversation_id_through_transitions', () => {
    const { stateMachine } = createConversationStateMachine()
    assert.equal(stateMachine.activeConversationId, null)

    stateMachine.transition('sendMessage', 'conv-abc')
    assert.equal(stateMachine.activeConversationId, 'conv-abc')

    // Transition back to idle clears conversationId
    stateMachine.transition('chatAgentComplete')
    assert.equal(stateMachine.currentState, 'idle')
    assert.equal(stateMachine.activeConversationId, null, 'cleared when returning to idle')
  })

  test('forceReset_returns_to_idle_from_any_state', () => {
    const nonIdleStates = [['sendMessage'], ['sendMessage', 'streamError']] as const

    for (const transitions of nonIdleStates) {
      const { stateMachine } = createConversationStateMachine()
      for (const t of transitions) {
        stateMachine.transition(t, 'conv-force')
      }
      assert.notEqual(stateMachine.currentState, 'idle', `should not be idle after ${transitions}`)

      stateMachine.forceReset()
      assert.equal(
        stateMachine.currentState,
        'idle',
        `should be idle after forceReset from ${stateMachine.currentState}`
      )
      assert.equal(stateMachine.activeConversationId, null, 'conversationId cleared on forceReset')
    }
  })

  test('isStreaming_returns_true_only_in_chat_agent_streaming', () => {
    const { stateMachine } = createConversationStateMachine()
    assert.equal(stateMachine.isStreaming(), false, 'idle is not streaming')

    stateMachine.transition('sendMessage', 'conv-1')
    assert.equal(stateMachine.isStreaming(), true, 'chat-agent-streaming is streaming')

    stateMachine.transition('chatAgentComplete')
    assert.equal(stateMachine.isStreaming(), false, 'idle after complete is not streaming')
  })
})
