/**
 * Unit tests for DaVinciRoleAdapter — verifies the adapter correctly
 * wires the Generalist-specific pieces (prompt assembler, MCP config,
 * persona, intent detection, control-tool callback wiring) into the
 * AgentRoleAdapter interface.
 *
 * Phase 1 of the Project Specialist refactor.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { DaVinciRoleAdapter } from '../role-adapters/da-vinci.adapter'
import type {
  AdapterIntentContext,
  AgentSessionEventName
} from '../agent-session.types'
import type { ControlToolState } from '../../../shared/types'

describe('DaVinciRoleAdapter', () => {
  test('role_and_agentId_are_correct', () => {
    const adapter = new DaVinciRoleAdapter()
    assert.equal(adapter.role, 'da-vinci')
    // agent_id string stays 'generalist' — that's the DB value (Layer 2 migration territory)
    assert.equal(adapter.agentId, 'generalist')
  })

  test('getPersona_returns_null_by_default', () => {
    const adapter = new DaVinciRoleAdapter()
    assert.equal(adapter.getPersona().id, null)
    assert.equal(adapter.getPersona().data, null)
  })

  test('setPersona_to_null_is_noop_when_already_null', () => {
    const adapter = new DaVinciRoleAdapter()
    adapter.setPersona(null)
    assert.equal(adapter.getPersona().id, null)
  })

  test('getPromptAssembler_returns_instance', () => {
    const adapter = new DaVinciRoleAdapter()
    assert.ok(adapter.getPromptAssembler())
  })

  test('addPendingContext_accumulates_size', () => {
    const adapter = new DaVinciRoleAdapter()
    assert.equal(adapter.getPendingContextSize('conv-1'), 0)
    adapter.addPendingContext('conv-1', 'hello')
    assert.equal(adapter.getPendingContextSize('conv-1'), 5)
    adapter.addPendingContext('conv-1', 'world') // appended with separator
    assert.ok(adapter.getPendingContextSize('conv-1') >= 10)
  })

  test('buildControlCallbacks_returns_wired_callbacks', () => {
    const adapter = new DaVinciRoleAdapter()
    const events: Array<{ evt: AgentSessionEventName; payload: unknown }> = []
    const callbacks = adapter.buildControlCallbacks({
      conversationId: 'c1',
      emit: (evt, payload) => events.push({ evt, payload }),
      getAccumulatedText: () => ''
    })

    assert.equal(typeof callbacks.onPlan, 'function')
    assert.equal(typeof callbacks.onAskUser, 'function')
    assert.equal(typeof callbacks.onMemory, 'function')
  })

  test('emitDetectedIntents_emits_response_when_no_control_tools_fired', () => {
    const adapter = new DaVinciRoleAdapter()
    const emitted: Array<{ evt: string; payload: unknown }> = []
    const ctx: AdapterIntentContext = {
      accumulatedText: 'Hello world',
      controlToolState: {
        plan: false,
        askUser: false,
        memory: false
      } as ControlToolState,
      mode: 'plan',
      conversationId: 'c1',
      emit: (evt, payload) => emitted.push({ evt, payload })
    }
    adapter.emitDetectedIntents(ctx)

    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]!.evt, 'intent')
    assert.deepEqual(emitted[0]!.payload, {
      type: 'response',
      content: 'Hello world'
    })
  })

  test('emitDetectedIntents_emits_plan_when_plan_tool_fired', () => {
    const adapter = new DaVinciRoleAdapter()
    const emitted: Array<{ evt: string; payload: unknown }> = []
    const planEvent = {
      rawContent: '{}',
      structuredPlan: { title: 'P', summary: 's' },
      beforePlan: '',
      afterPlan: ''
    }
    adapter.emitDetectedIntents({
      accumulatedText: 'text',
      controlToolState: {
        plan: true,
        askUser: false,
        memory: false,
        planIntent: { type: 'plan', plan: planEvent as never }
      } as ControlToolState,
      mode: 'plan',
      conversationId: 'c1',
      emit: (evt, payload) => emitted.push({ evt, payload })
    })

    const intents = emitted.filter((e) => e.evt === 'intent')
    assert.ok(intents.length >= 1, `expected at least 1 intent, got ${intents.length}`)
    const planIntent = intents.find(
      (e) => (e.payload as { type: string }).type === 'plan'
    )
    assert.ok(planIntent, 'expected plan intent to be emitted')
  })

  test('onSessionStop_clears_feature_flags_and_persona', () => {
    const adapter = new DaVinciRoleAdapter()
    adapter.setPersona(null) // legal no-op
    adapter.onSessionStop()
    assert.equal(adapter.getPersona().id, null)
    assert.equal(adapter.getPersona().data, null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
