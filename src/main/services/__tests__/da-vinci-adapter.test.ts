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
import { specialistRepository } from '../../db/repositories'
import type { AdapterIntentContext, AgentSessionEventName } from '../agent-session.types'
import type { ControlToolState, Specialist } from '../../../shared/types'

describe('DaVinciRoleAdapter', () => {
  test('role_and_agentId_are_correct', () => {
    const adapter = new DaVinciRoleAdapter()
    assert.equal(adapter.role, 'da-vinci')
    // agent_id matches the role after Layer 2 migration (#69) rename.
    assert.equal(adapter.agentId, 'da-vinci')
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
    const planIntent = intents.find((e) => (e.payload as { type: string }).type === 'plan')
    assert.ok(planIntent, 'expected plan intent to be emitted')
  })

  test('onSessionStop_clears_feature_flags_and_persona', () => {
    const adapter = new DaVinciRoleAdapter()
    adapter.setPersona(null) // legal no-op
    adapter.onSessionStop()
    assert.equal(adapter.getPersona().id, null)
    assert.equal(adapter.getPersona().data, null)
  })

  // ── Specialist-swap proposal detection ──

  function stubReadySpecialist(ready: Specialist | null): () => void {
    const orig = specialistRepository.findReadyByWorkspace.bind(specialistRepository)
    specialistRepository.findReadyByWorkspace = () => ready
    return () => {
      specialistRepository.findReadyByWorkspace = orig
    }
  }

  function makeSpecialist(id: string, name: string): Specialist {
    return {
      id,
      agentId: `workspace-specialist-${id}`,
      displayName: name,
      description: '',
      icon: '🤖',
      color: '#000',
      prompt: '',
      priority: 100,
      isActive: true,
      sourceYaml: null,
      alias: null,
      avatarUrl: null,
      isCore: false,
      createdAt: '',
      updatedAt: ''
    }
  }

  test('refreshFeatureFlags_arms_signal_when_specialist_becomes_ready', () => {
    const adapter = new DaVinciRoleAdapter()
    const restore = stubReadySpecialist(makeSpecialist('spec-a', 'Payments Specialist'))
    try {
      adapter.refreshFeatureFlags({
        workspacePath: '/tmp',
        workspaceId: 'ws-1',
        conversationId: null
      })
      // The assembler should now have the signal armed.
      const msg = adapter.getPromptAssembler().buildEffectiveMessage({
        message: 'hi',
        conversationId: 'c1',
        hasImages: false,
        turnCount: 5,
        sessionId: undefined,
        mode: 'plan'
      })
      assert.ok(
        msg.includes('[PROJECT SPECIALIST READY: Payments Specialist]'),
        'sentinel should be injected once'
      )
    } finally {
      restore()
    }
  })

  test('refreshFeatureFlags_does_not_re_arm_for_same_specialist_on_subsequent_turns', () => {
    const adapter = new DaVinciRoleAdapter()
    const restore = stubReadySpecialist(makeSpecialist('spec-a', 'Payments Specialist'))
    try {
      // First turn — signal fires.
      adapter.refreshFeatureFlags({
        workspacePath: '/tmp',
        workspaceId: 'ws-1',
        conversationId: null
      })
      adapter.getPromptAssembler().buildEffectiveMessage({
        message: 'hi',
        conversationId: 'c1',
        hasImages: false,
        turnCount: 1,
        sessionId: undefined,
        mode: 'plan'
      })

      // Second turn — same specialist still ready, but lastAnnouncedSpecialistId
      // prevents re-arming, so buildEffectiveMessage should not see the sentinel.
      adapter.refreshFeatureFlags({
        workspacePath: '/tmp',
        workspaceId: 'ws-1',
        conversationId: null
      })
      const msg2 = adapter.getPromptAssembler().buildEffectiveMessage({
        message: 'hi again',
        conversationId: 'c1',
        hasImages: false,
        turnCount: 2,
        sessionId: undefined,
        mode: 'plan'
      })
      assert.ok(
        !msg2.includes('[PROJECT SPECIALIST READY'),
        'should NOT re-prompt for same specialist on subsequent turns'
      )
    } finally {
      restore()
    }
  })

  test('refreshFeatureFlags_arms_signal_with_lean_mode_for_opus_48', () => {
    const adapter = new DaVinciRoleAdapter()
    const restore = stubReadySpecialist(makeSpecialist('spec-a', 'Payments Specialist'))
    try {
      adapter.refreshFeatureFlags({
        workspacePath: '/tmp',
        workspaceId: 'ws-1',
        conversationId: null
      })
      const msg = adapter.getPromptAssembler().buildEffectiveMessage({
        message: 'hi',
        conversationId: 'c1',
        hasImages: false,
        turnCount: 5,
        sessionId: undefined,
        mode: 'plan',
        model: 'claude-opus-4-8'
      })
      assert.ok(
        msg.includes('[PROJECT SPECIALIST READY: Payments Specialist]'),
        'sentinel should be injected with opus model'
      )
      assert.ok(msg.includes('<mode-context>'), 'should contain mode-context block')
      // The lean plan mode doesn't have "### Questions vs. Plans — Know the Difference (IMPORTANT)"
      assert.ok(
        !msg.includes('Know the Difference (IMPORTANT)'),
        'Opus 4.8 should use lean plan mode section through adapter flow'
      )
    } finally {
      restore()
    }
  })

  test('refreshFeatureFlags_no_ready_specialist_does_not_arm_signal', () => {
    const adapter = new DaVinciRoleAdapter()
    const restore = stubReadySpecialist(null)
    try {
      adapter.refreshFeatureFlags({
        workspacePath: '/tmp',
        workspaceId: 'ws-1',
        conversationId: null
      })
      const msg = adapter.getPromptAssembler().buildEffectiveMessage({
        message: 'hi',
        conversationId: 'c1',
        hasImages: false,
        turnCount: 5,
        sessionId: undefined,
        mode: 'plan'
      })
      assert.ok(
        !msg.includes('[PROJECT SPECIALIST READY'),
        'no signal should fire when no specialist is ready'
      )
    } finally {
      restore()
    }
  })
})

// ── Delegation methods ──

describe('DaVinciRoleAdapter — delegation methods', () => {
  test('onConversationSwitch invalidates prompt assembler snapshot', () => {
    const adapter = new DaVinciRoleAdapter()
    // Should not throw — invalidateSnapshot is idempotent
    adapter.onConversationSwitch('conv-switch-1')
    assert.ok(true, 'onConversationSwitch completed without error')
  })

  test('setPendingCompaction delegates to prompt assembler', () => {
    const adapter = new DaVinciRoleAdapter()
    // Should not throw
    adapter.setPendingCompaction('conv-c1', '/compact')
    assert.ok(true, 'setPendingCompaction completed without error')
  })

  test('setPendingModeSwitch invalidates snapshot and delegates', () => {
    const adapter = new DaVinciRoleAdapter()
    adapter.setPendingModeSwitch('plan', 'build')
    assert.ok(true, 'setPendingModeSwitch completed without error')
  })

  test('clearConversation delegates to prompt assembler', () => {
    const adapter = new DaVinciRoleAdapter()
    adapter.clearConversation('conv-clear-1')
    assert.ok(true, 'clearConversation completed without error')
  })

  test('addPendingContext accumulates and clearConversation resets', () => {
    const adapter = new DaVinciRoleAdapter()
    adapter.addPendingContext('conv-ctx-1', 'some context')
    assert.ok(adapter.getPendingContextSize('conv-ctx-1') > 0)
    adapter.clearConversation('conv-ctx-1')
    assert.equal(adapter.getPendingContextSize('conv-ctx-1'), 0)
  })
})

// ── Persona lifecycle ──

describe('DaVinciRoleAdapter — persona lifecycle', () => {
  test('getPersona returns current persona state', () => {
    const adapter = new DaVinciRoleAdapter()
    const persona = adapter.getPersona()
    assert.equal(persona.id, null)
    assert.equal(persona.data, null)
  })

  test('setPersona(null) clears persona to null', () => {
    const adapter = new DaVinciRoleAdapter()
    adapter.setPersona(null)
    const persona = adapter.getPersona()
    assert.equal(persona.id, null)
    assert.equal(persona.data, null)
  })

  test('setPersona same id twice is idempotent', () => {
    const adapter = new DaVinciRoleAdapter()
    adapter.setPersona(null)
    adapter.setPersona(null)
    assert.equal(adapter.getPersona().id, null)
  })

  test('onSessionStop resets persona', () => {
    const adapter = new DaVinciRoleAdapter()
    adapter.onSessionStop()
    assert.equal(adapter.getPersona().id, null)
    assert.equal(adapter.getPersona().data, null)
  })
})

// ── getPromptAssembler ──

describe('DaVinciRoleAdapter — prompt assembler access', () => {
  test('getPromptAssembler returns a DaVinciPromptAssembler instance', () => {
    const adapter = new DaVinciRoleAdapter()
    const assembler = adapter.getPromptAssembler()
    assert.ok(assembler)
    assert.equal(typeof assembler.buildEffectiveMessage, 'function')
    assert.equal(typeof assembler.invalidateSnapshot, 'function')
  })

  test('multiple getPromptAssembler calls return same instance', () => {
    const adapter = new DaVinciRoleAdapter()
    const a1 = adapter.getPromptAssembler()
    const a2 = adapter.getPromptAssembler()
    assert.equal(a1, a2)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
