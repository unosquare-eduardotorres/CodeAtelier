/**
 * Unit tests for BlueprintVerifyAdapter — read-only + Bash verification adapter.
 *
 * Tests: constructor identity, getModelAction, getPhaseMessage content (4-level methodology),
 * buildMcpConfig (read + Bash, no Write/Edit), code-graph conditional.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BlueprintVerifyAdapter } from '../role-adapters/blueprint/blueprint-verify.adapter'
import type { AdapterMcpContext, AdapterPromptContext } from '../agent-session.types'
import type { PhaseContext } from '../../../shared/blueprint-types'

const basePhaseContext: PhaseContext = {
  blueprint: {
    id: 'bp-1',
    title: 'Test Blueprint',
    shortName: 'test-bp',
    description: 'A test blueprint',
    priority: 'medium',
    currentPhase: 'verify',
    settings: {}
  },
  constitution: null,
  previousArtifacts: [],
  specFilePath: '/tmp/spec.md',
  blueprintDir: '/tmp/blueprint'
}

function makePromptCtx(): AdapterPromptContext {
  return {
    message: 'verify',
    conversationId: 'c1',
    hasImages: false,
    turnCount: 1,
    mode: 'plan',
    workspacePath: '/tmp/test',
    workspaceId: 'ws-1',
    costPreference: 'balanced'
  }
}

function makeMcpCtx(overrides: Partial<AdapterMcpContext> = {}): AdapterMcpContext {
  return {
    mode: 'plan',
    workspacePath: '/tmp/bp-verify-test',
    workspaceId: 'ws-bv1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {}, onMemory: () => {} },
    ...overrides
  }
}

describe('BlueprintVerifyAdapter', () => {
  // ── Constructor + identity ──

  test('role_is_blueprint_verify', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    assert.equal(adapter.role, 'blueprint-verify')
  })

  test('agentId_includes_blueprintId', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-55',
      phaseContext: basePhaseContext
    })
    assert.equal(adapter.agentId, 'blueprint-verify-bp-55')
  })

  // ── getModelAction ──

  test('getModelAction_returns_blueprint_verify', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const action = (adapter as any).getModelAction()
    assert.equal(action, 'blueprint:verify')
  })

  // ── getPhaseMessage ──

  test('getPhaseMessage_contains_4_level_artifact_verification', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.ok(result.effectiveMessage.includes('4-level artifact verification methodology'))
  })

  test('getPhaseMessage_contains_EXISTS_SUBSTANTIVE_WIRED_DATA_FLOWING', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.ok(result.effectiveMessage.includes('EXISTS'))
    assert.ok(result.effectiveMessage.includes('SUBSTANTIVE'))
    assert.ok(result.effectiveMessage.includes('WIRED'))
    assert.ok(result.effectiveMessage.includes('DATA FLOWING'))
  })

  test('getPhaseMessage_contains_blueprint_phase_complete', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.ok(result.effectiveMessage.includes('blueprint-phase-complete'))
  })

  // ── buildMcpConfig (read + Bash, no Write/Edit) ──

  test('buildMcpConfig_allowedTools_includes_Read_Bash_ListDir', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.allowedTools.includes('Bash'))
    assert.ok(result.allowedTools.includes('ListDir'))
    assert.ok(result.allowedTools.includes('Glob'))
    assert.ok(result.allowedTools.includes('Grep'))
  })

  test('buildMcpConfig_allowedTools_does_NOT_include_Write_Edit', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(!result.allowedTools.includes('Write'))
    assert.ok(!result.allowedTools.includes('Edit'))
  })

  test('buildMcpConfig_disallowedTools_includes_Write_Edit_Agent', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(result.disallowedTools.includes('Write'))
    assert.ok(result.disallowedTools.includes('Edit'))
    assert.ok(result.disallowedTools.includes('Agent'))
    assert.ok(result.disallowedTools.includes('ToolSearch'))
  })

  test('buildMcpConfig_includes_code_graph_when_repomapEnabled_and_workspaceId', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    assert.ok(result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })

  test('buildMcpConfig_excludes_code_graph_without_workspaceId', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    assert.ok(!result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })

  // ── buildPrompts guard ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const adapter = new BlueprintVerifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext
    })
    assert.throws(
      () => adapter.buildPrompts(makePromptCtx()),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
