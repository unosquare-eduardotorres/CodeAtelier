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
import { MCP_TOOLS } from '../../../shared/constants'

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

  // ── Memory tools ──

  test('buildMcpConfig_includes_memory_tools_when_workspaceId_present', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build'
    })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    for (const name of MCP_TOOLS.MEMORY._ALL_NAMES) {
      assert.ok(allowedTools.includes(name), `should include ${name}`)
    }
  })

  test('buildMcpConfig_excludes_memory_tools_without_workspaceId', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Build'
    })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(!allowedTools.some((t) => t.startsWith('mcp__memory__')))
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

  // ── Phase 1.2: Prompt reorder dedup ──

  test('buildPhaseSystemPrompt_contains_tool_priority_and_finalization_checklist', () => {
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: 'Implement auth module'
    })
    const prompt = (adapter as any).buildPhaseSystemPrompt() as string
    // Template has comprehensive Tool Priority table; TOOL_PRIORITY_DIRECTIVE_BUILDER adds
    // a condensed reminder + Finalization Checklist. Both are expected.
    assert.ok(prompt.includes('## Tool Priority'), 'should contain ## Tool Priority')
    assert.ok(prompt.includes('## Finalization Checklist'), 'should contain Finalization Checklist')
    // The appendToolGuidance dedup should NOT add a third one
    // (verified by the base class's includes check)
  })

  test('buildPhaseSystemPrompt_task_section_at_end_after_tool_priority', () => {
    const taskCtx = 'UNIQUE_TASK_MARKER_XYZ'
    const adapter = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext: basePhaseContext,
      taskContext: taskCtx
    })
    const prompt = (adapter as any).buildPhaseSystemPrompt() as string
    const toolPriorityIdx = prompt.indexOf('## Tool Priority')
    const taskSectionIdx = prompt.indexOf('## Current Task')
    assert.ok(toolPriorityIdx > -1, 'Tool Priority must be in prompt')
    assert.ok(taskSectionIdx > -1, 'Current Task must be in prompt')
    // Phase 1.2: Task section comes AFTER Tool Priority for prefix cache optimization
    assert.ok(
      taskSectionIdx > toolPriorityIdx,
      `Current Task (idx=${taskSectionIdx}) must come after Tool Priority (idx=${toolPriorityIdx})`
    )
    // Task context appears in the prompt
    assert.ok(prompt.includes(taskCtx), 'task context must be in prompt')
  })

  // ── Phase 1.3: Lean MCP config ──

  test('buildMcpConfig_lean_mode_excludes_semantic_search_and_code_analysis', async () => {
    // Mock the preference to return leanBuildMcp: true
    const { appPreferenceRepository } =
      await import('../../../main/db/repositories/app-preference.repository')
    const originalGetPrefs = appPreferenceRepository.getAppPreferences.bind(appPreferenceRepository)
    appPreferenceRepository.getAppPreferences = () => ({
      ...originalGetPrefs(),
      leanBuildMcp: true
    })
    try {
      const adapter = new BlueprintBuildAdapter({
        workspaceId: 'ws-1',
        blueprintId: 'bp-1',
        phaseContext: basePhaseContext,
        taskContext: 'Build'
      })
      const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
      const { allowedTools } = result
      assert.ok(allowedTools, 'allowedTools should be defined')
      // Should NOT have semantic-search tools
      assert.ok(
        !allowedTools.some((t) => t.startsWith('mcp__semantic-search__')),
        'lean mode should exclude semantic-search'
      )
      // Should NOT have code-analysis tools
      assert.ok(
        !allowedTools.some((t) => t.startsWith('mcp__code-analysis__')),
        'lean mode should exclude code-analysis'
      )
      // Should still have code-graph
      assert.ok(
        allowedTools.some((t) => t.startsWith('mcp__code-graph__')),
        'lean mode should keep code-graph'
      )
      // Should still have git-context
      assert.ok(
        allowedTools.some((t) => t.startsWith('mcp__git-context__')),
        'lean mode should keep git-context'
      )
    } finally {
      appPreferenceRepository.getAppPreferences = originalGetPrefs
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
