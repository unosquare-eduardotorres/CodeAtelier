/**
 * Unit tests for ConversationStateMachine — the state machine that tracks
 * conversation lifecycle (idle → streaming → handoff → executing → complete → idle).
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

  test('transitions_from_idle_to_generalist_streaming_on_sendMessage', () => {
    const { stateMachine } = createConversationStateMachine()
    const result = stateMachine.transition('sendMessage', 'conv-1')
    assert.equal(result, true)
    assert.equal(stateMachine.currentState, 'generalist-streaming')
  })

  test('transitions_through_full_handoff_pipeline', () => {
    const { stateMachine } = createConversationStateMachine()

    assert.equal(stateMachine.transition('sendMessage', 'conv-1'), true)
    assert.equal(stateMachine.currentState, 'generalist-streaming')

    assert.equal(stateMachine.transition('handoffDetected'), true)
    assert.equal(stateMachine.currentState, 'handoff-detected')

    assert.equal(stateMachine.transition('decompositionReady'), true)
    assert.equal(stateMachine.currentState, 'decomposing')

    assert.equal(stateMachine.transition('executionStarted'), true)
    assert.equal(stateMachine.currentState, 'specialist-executing')

    assert.equal(stateMachine.transition('allComplete'), true)
    assert.equal(stateMachine.currentState, 'pipeline-complete')

    assert.equal(stateMachine.transition('messageFinalised'), true)
    assert.equal(stateMachine.currentState, 'idle')
  })

  test('rejects_invalid_transition_and_returns_false', () => {
    const { stateMachine } = createConversationStateMachine()
    // idle + generalistComplete is NOT in the valid transitions for idle (only sendMessage is)
    // But wait — generalistComplete is in IDEMPOTENT_WHEN_IDLE, so it returns true as no-op
    // Let's use a truly invalid transition: idle + handoffDetected
    const result = stateMachine.transition('handoffDetected')
    assert.equal(result, false)
    assert.equal(stateMachine.currentState, 'idle', 'state should remain idle')
  })

  test('emits_stateChange_event_on_valid_transition', () => {
    const { stateMachine, stateChanges } = createConversationStateMachine()
    stateMachine.transition('sendMessage', 'conv-42')

    assert.equal(stateChanges.length, 1)
    assert.equal(stateChanges[0].from, 'idle')
    assert.equal(stateChanges[0].to, 'generalist-streaming')
    assert.equal(stateChanges[0].event, 'sendMessage')
  })

  test('sends_IPC_state_change_to_renderer', () => {
    const { stateMachine, sentMessages } = createConversationStateMachine()
    stateMachine.transition('sendMessage', 'conv-99')

    assert.equal(sentMessages.length, 1)
    assert.equal(sentMessages[0].channel, 'chat:stateChange')
    const payload = sentMessages[0].payload as Record<string, unknown>
    assert.equal(payload.from, 'idle')
    assert.equal(payload.to, 'generalist-streaming')
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
    assert.equal(sm.currentState, 'generalist-streaming')
  })

  test('idempotent_transitions_when_already_idle', () => {
    const { stateMachine, stateChanges } = createConversationStateMachine()
    assert.equal(stateMachine.currentState, 'idle')

    // These events should be no-ops in idle state (return true but no state change)
    assert.equal(stateMachine.transition('messageFinalised'), true)
    assert.equal(stateMachine.transition('errorHandled'), true)
    assert.equal(stateMachine.transition('cleanupComplete'), true)
    assert.equal(stateMachine.transition('generalistComplete'), true)

    assert.equal(stateMachine.currentState, 'idle')
    // No stateChange events emitted for idempotent no-ops
    assert.equal(stateChanges.length, 0, 'no stateChange events for idle no-ops')
  })

  test('tracks_conversation_id_through_transitions', () => {
    const { stateMachine } = createConversationStateMachine()
    assert.equal(stateMachine.activeConversationId, null)

    stateMachine.transition('sendMessage', 'conv-abc')
    assert.equal(stateMachine.activeConversationId, 'conv-abc')

    stateMachine.transition('handoffDetected')
    assert.equal(stateMachine.activeConversationId, 'conv-abc', 'preserved through transitions')

    // Transition back to idle clears conversationId
    stateMachine.transition('decompositionReady')
    stateMachine.transition('executionStarted')
    stateMachine.transition('allComplete')
    stateMachine.transition('messageFinalised')
    assert.equal(stateMachine.currentState, 'idle')
    assert.equal(stateMachine.activeConversationId, null, 'cleared when returning to idle')
  })

  test('forceReset_returns_to_idle_from_any_state', () => {
    const nonIdleStates = [
      ['sendMessage'],
      ['sendMessage', 'handoffDetected'],
      ['sendMessage', 'handoffDetected', 'decompositionReady'],
      ['sendMessage', 'handoffDetected', 'decompositionReady', 'executionStarted'],
      ['sendMessage', 'streamError']
    ] as const

    for (const transitions of nonIdleStates) {
      const { stateMachine } = createConversationStateMachine()
      for (const t of transitions) {
        stateMachine.transition(t, 'conv-force')
      }
      assert.notEqual(stateMachine.currentState, 'idle', `should not be idle after ${transitions}`)

      stateMachine.forceReset()
      assert.equal(stateMachine.currentState, 'idle', `should be idle after forceReset from ${stateMachine.currentState}`)
      assert.equal(stateMachine.activeConversationId, null, 'conversationId cleared on forceReset')
    }
  })

  test('isStreaming_returns_true_only_in_generalist_streaming', () => {
    const { stateMachine } = createConversationStateMachine()
    assert.equal(stateMachine.isStreaming(), false, 'idle is not streaming')

    stateMachine.transition('sendMessage', 'conv-1')
    assert.equal(stateMachine.isStreaming(), true, 'generalist-streaming is streaming')

    stateMachine.transition('handoffDetected')
    assert.equal(stateMachine.isStreaming(), false, 'handoff-detected is not streaming')
  })

  test('isExecuting_returns_true_for_handoff_decomposing_executing', () => {
    const { stateMachine } = createConversationStateMachine()
    assert.equal(stateMachine.isExecuting(), false, 'idle is not executing')

    stateMachine.transition('sendMessage', 'conv-1')
    assert.equal(stateMachine.isExecuting(), false, 'streaming is not executing')

    stateMachine.transition('handoffDetected')
    assert.equal(stateMachine.isExecuting(), true, 'handoff-detected is executing')

    stateMachine.forceReset()
    stateMachine.transition('sendMessage', 'conv-2')
    stateMachine.transition('handoffDetected')
    stateMachine.transition('decompositionReady')
    assert.equal(stateMachine.isExecuting(), true, 'decomposing is executing')

    stateMachine.transition('executionStarted')
    assert.equal(stateMachine.isExecuting(), true, 'specialist-executing is executing')

    stateMachine.transition('allComplete')
    assert.equal(stateMachine.isExecuting(), false, 'pipeline-complete is not executing')
  })
})
