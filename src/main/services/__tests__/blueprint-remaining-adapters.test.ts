/**
 * Unit tests for the remaining Blueprint pipeline adapters:
 *   - BlueprintSpecifyAdapter
 *   - BlueprintClarifyAdapter
 *   - BlueprintPlanAdapter
 *   - BlueprintTasksAdapter
 *
 * All extend BlueprintBaseAdapter — same test pattern as blueprint-base-adapter.test.ts.
 * Tests: role, agentId, getModelAction, getPhaseMessage, buildPrompts guard.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BlueprintSpecifyAdapter } from '../role-adapters/blueprint/blueprint-specify.adapter'
import { BlueprintClarifyAdapter } from '../role-adapters/blueprint/blueprint-clarify.adapter'
import { BlueprintPlanAdapter } from '../role-adapters/blueprint/blueprint-plan.adapter'
import { BlueprintTasksAdapter } from '../role-adapters/blueprint/blueprint-tasks.adapter'
import type { AdapterPromptContext } from '../agent-session.types'

// ── Helpers ──

function makePromptCtx(): AdapterPromptContext {
  return {
    message: 'hello',
    conversationId: 'c1',
    hasImages: false,
    turnCount: 1,
    sessionId: undefined,
    mode: 'plan',
    workspacePath: '/tmp/test',
    workspaceId: 'ws-1',
    costPreference: 'balanced'
  }
}

const dummyPhaseContext = {
  blueprint: {
    id: 'bp-1',
    title: 'TestProject',
    shortName: 'test',
    description: 'Test blueprint',
    priority: 'medium' as any,
    currentPhase: 'specify' as any,
    settings: {} as Record<string, unknown>
  },
  constitution: null as string | null,
  previousArtifacts: [] as any[],
  specFilePath: '/tmp/spec.md',
  blueprintDir: '/tmp/blueprints',
  grillDecisions: []
}

// ── BlueprintSpecifyAdapter ──────────────────────────────────────────

describe('BlueprintSpecifyAdapter', () => {
  test('role_is_blueprint-specify', () => {
    const a = new BlueprintSpecifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-42',
      description: 'Add login page',
      phaseContext: dummyPhaseContext
    })
    assert.equal(a.role, 'blueprint-specify')
  })

  test('agentId_is_blueprint-specify-{blueprintId}', () => {
    const a = new BlueprintSpecifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-99',
      description: 'Feature X',
      phaseContext: dummyPhaseContext
    })
    assert.equal(a.agentId, 'blueprint-specify-bp-99')
  })

  test('getModelAction_returns_blueprint:specify', () => {
    const a = new BlueprintSpecifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      description: 'x',
      phaseContext: dummyPhaseContext
    })
    assert.equal((a as any).getModelAction(), 'blueprint:specify')
  })

  test('getPhaseMessage_includes_description', () => {
    const a = new BlueprintSpecifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      description: 'Build a REST API',
      phaseContext: dummyPhaseContext
    })
    const msg = a.getPhaseMessage()
    assert.ok(msg.includes('Build a REST API'))
    assert.ok(msg.includes('Generate a detailed specification'))
  })

  test('getPhaseMessage_includes_grill_decisions_when_provided', () => {
    const a = new BlueprintSpecifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      description: 'Add auth',
      grillDecisions: [
        { header: 'Auth Method', selectedOption: 'OAuth2', reason: 'Industry standard' }
      ],
      phaseContext: dummyPhaseContext
    })
    const msg = a.getPhaseMessage()
    assert.ok(msg.includes('Grill Decisions'))
    assert.ok(msg.includes('Auth Method'))
    assert.ok(msg.includes('OAuth2'))
    assert.ok(msg.includes('Industry standard'))
  })

  test('getPhaseMessage_excludes_grill_section_when_empty', () => {
    const a = new BlueprintSpecifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      description: 'Simple feature',
      grillDecisions: [],
      phaseContext: dummyPhaseContext
    })
    const msg = a.getPhaseMessage()
    assert.ok(!msg.includes('Grill Decisions'))
  })

  test('buildPrompts_throws_before_onSessionStart', () => {
    const a = new BlueprintSpecifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      description: 'x',
      phaseContext: dummyPhaseContext
    })
    assert.throws(() => a.buildPrompts(makePromptCtx()), /buildPrompts\(\) called before onSessionStart\(\)/)
  })

  test('buildPrompts_returns_phase_message_after_setup', () => {
    const a = new BlueprintSpecifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      description: 'Build feature',
      phaseContext: dummyPhaseContext
    })
    ;(a as any).systemPrompt = 'Test prompt'
    // Pass empty message so buildPrompts falls through to getPhaseMessage()
    const result = a.buildPrompts({ ...makePromptCtx(), message: '' })
    assert.equal(result.systemPrompt, 'Test prompt')
    assert.ok(result.effectiveMessage.includes('Build feature'))
  })
})

// ── BlueprintClarifyAdapter ──────────────────────────────────────────

describe('BlueprintClarifyAdapter', () => {
  test('role_is_blueprint-clarify', () => {
    const a = new BlueprintClarifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    assert.equal(a.role, 'blueprint-clarify')
  })

  test('agentId_is_blueprint-clarify-{blueprintId}', () => {
    const a = new BlueprintClarifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-77',
      phaseContext: dummyPhaseContext
    })
    assert.equal(a.agentId, 'blueprint-clarify-bp-77')
  })

  test('getModelAction_returns_blueprint:clarify', () => {
    const a = new BlueprintClarifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    assert.equal((a as any).getModelAction(), 'blueprint:clarify')
  })

  test('getPhaseMessage_contains_analyze_instruction', () => {
    const a = new BlueprintClarifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    const msg = a.getPhaseMessage()
    assert.ok(msg.includes('Analyze the specification'))
  })

  test('buildPrompts_throws_before_onSessionStart', () => {
    const a = new BlueprintClarifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    assert.throws(() => a.buildPrompts(makePromptCtx()), /buildPrompts\(\) called before onSessionStart\(\)/)
  })
})

// ── BlueprintPlanAdapter ─────────────────────────────────────────────

describe('BlueprintPlanAdapter', () => {
  test('role_is_blueprint-plan', () => {
    const a = new BlueprintPlanAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    assert.equal(a.role, 'blueprint-plan')
  })

  test('agentId_is_blueprint-plan-{blueprintId}', () => {
    const a = new BlueprintPlanAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-55',
      phaseContext: dummyPhaseContext
    })
    assert.equal(a.agentId, 'blueprint-plan-bp-55')
  })

  test('getModelAction_returns_blueprint:plan', () => {
    const a = new BlueprintPlanAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    assert.equal((a as any).getModelAction(), 'blueprint:plan')
  })

  test('getPhaseMessage_contains_implementation_plan_instruction', () => {
    const a = new BlueprintPlanAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    const msg = a.getPhaseMessage()
    assert.ok(msg.includes('implementation plan'))
    assert.ok(msg.includes('Goal-Backward'))
  })

  test('buildPrompts_throws_before_onSessionStart', () => {
    const a = new BlueprintPlanAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    assert.throws(() => a.buildPrompts(makePromptCtx()), /buildPrompts\(\) called before onSessionStart\(\)/)
  })
})

// ── BlueprintTasksAdapter ────────────────────────────────────────────

describe('BlueprintTasksAdapter', () => {
  test('role_is_blueprint-tasks', () => {
    const a = new BlueprintTasksAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    assert.equal(a.role, 'blueprint-tasks')
  })

  test('agentId_is_blueprint-tasks-{blueprintId}', () => {
    const a = new BlueprintTasksAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-33',
      phaseContext: dummyPhaseContext
    })
    assert.equal(a.agentId, 'blueprint-tasks-bp-33')
  })

  test('getModelAction_returns_blueprint:tasks', () => {
    const a = new BlueprintTasksAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    assert.equal((a as any).getModelAction(), 'blueprint:tasks')
  })

  test('getPhaseMessage_contains_decompose_instruction', () => {
    const a = new BlueprintTasksAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    const msg = a.getPhaseMessage()
    assert.ok(msg.includes('Decompose'))
    assert.ok(msg.includes('wave-ordered'))
    assert.ok(msg.includes('blueprint-tasks'))
  })

  test('buildPrompts_throws_before_onSessionStart', () => {
    const a = new BlueprintTasksAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    assert.throws(() => a.buildPrompts(makePromptCtx()), /buildPrompts\(\) called before onSessionStart\(\)/)
  })

  test('buildPrompts_returns_effectiveMessage_after_setup', () => {
    const a = new BlueprintTasksAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: dummyPhaseContext
    })
    ;(a as any).systemPrompt = 'Test system prompt'
    const result = a.buildPrompts({ ...makePromptCtx(), message: '' })
    assert.ok(result.effectiveMessage.includes('Decompose'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
