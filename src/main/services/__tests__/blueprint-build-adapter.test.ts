/**
 * Unit tests for BlueprintBuildAdapter — write-mode Blueprint BUILD phase adapter.
 *
 * Tests: constructor identity, getModelAction, getPhaseMessage content,
 * buildMcpConfig (full write access), code-graph/semantic-search conditionals.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BlueprintBuildAdapter } from '../role-adapters/blueprint/blueprint-build.adapter'
import type { AdapterMcpContext, AdapterPromptContext } from '../agent-session.types'
import type { PhaseContext } from '../../../shared/blueprint-types'

const basePhaseContext: PhaseContext = {
  blueprint: {
    id: 'bp-1',
    title: 'Test Blueprint',
    shortName: 'test-bp',
    description: 'A test blueprint',
    priority: 'P2',
    currentPhase: 'build',
    settings: {}
  },
  constitution: null,
  previousArtifacts: [],
  specFilePath: '/tmp/spec.md',
  blueprintDir: '/tmp/blueprint'
}

function makePromptCtx(): AdapterPromptContext {
  return {
    message: 'build',
    conversationId: 'c1',
    hasImages: false,
    turnCount: 1,
    sessionId: undefined,
    mode: 'build',
    workspacePath: '/tmp/test',
    workspaceId: 'ws-1',
    costPreference: 'balanced'
  }
}

function makeMcpCtx(overrides: Partial<AdapterMcpContext> = {}): AdapterMcpContext {
  return {
    mode: 'build',
    workspacePath: '/tmp/bp-build-test',
    workspaceId: 'ws-bb1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {} },
    ...overrides
  }
}

describe('BlueprintBuildAdapter', () => {
  // ── Constructor + identity ──

  test('role_is_blueprint_build', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Implement the auth service'
    })
    assert.equal(adapter.role, 'blueprint-build')
  })

  test('agentId_includes_blueprintId', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-42',
      phaseContext: basePhaseContext,
      taskContext: 'Build something'
    })
    assert.equal(adapter.agentId, 'blueprint-build-bp-42')
  })

  // ── getModelAction ──

  test('getModelAction_returns_blueprint_build', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build task'
    })
    const action = (adapter as any).getModelAction()
    assert.equal(action, 'blueprint:build')
  })

  // ── getPhaseMessage ──

  test('getPhaseMessage_contains_implement_the_task', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build the component'
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    // Pass empty message so buildPrompts falls through to getPhaseMessage()
    const result = adapter.buildPrompts({ ...makePromptCtx(), message: '' })
    assert.ok(result.effectiveMessage.includes('Implement the task'))
  })

  test('getPhaseMessage_contains_commit_protocol', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build the component'
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts({ ...makePromptCtx(), message: '' })
    assert.ok(result.effectiveMessage.includes('commit protocol'))
  })

  test('getPhaseMessage_contains_blueprint_phase_complete', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build the component'
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts({ ...makePromptCtx(), message: '' })
    assert.ok(result.effectiveMessage.includes('blueprint-phase-complete'))
  })

  // ── buildMcpConfig (write-mode override) ──

  test('buildMcpConfig_allowedTools_includes_write_edit_bash_listdir', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build'
    })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.includes('Write'))
    assert.ok(allowedTools.includes('Edit'))
    assert.ok(allowedTools.includes('Bash'))
    assert.ok(allowedTools.includes('ListDir'))
  })

  test('buildMcpConfig_disallowedTools_includes_agent_toolsearch_askuser', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build'
    })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { disallowedTools } = result
    assert.ok(disallowedTools, 'disallowedTools should be defined')
    assert.ok(disallowedTools.includes('Agent'))
    assert.ok(disallowedTools.includes('ToolSearch'))
    assert.ok(disallowedTools.includes('AskUserQuestion'))
  })

  test('buildMcpConfig_includes_code_graph_when_repomapEnabled_and_workspaceId', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build'
    })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })

  test('buildMcpConfig_excludes_code_graph_without_workspaceId', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build'
    })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(!allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })

  test('buildMcpConfig_includes_semantic_search_when_enabled_and_workspaceId', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build'
    })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.some((t) => t.startsWith('mcp__semantic-search__')))
  })

  // ── buildPrompts guard ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build'
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
