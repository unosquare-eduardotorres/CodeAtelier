/**
 * Unit tests for MpaBuilderAdapter — MPA builder phase adapter.
 *
 * Tests: constructor identity, getModelAction, getPhaseMessage branching,
 * buildMcpConfig (full write access), code-graph conditional, semantic search conditional.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { MpaBuilderAdapter } from '../role-adapters/mpa/mpa-builder.adapter'
import type { AdapterMcpContext, AdapterPromptContext } from '../agent-session.types'

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
    workspacePath: '/tmp/builder-test',
    workspaceId: 'ws-b1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {}, onMemory: () => {} },
    ...overrides
  }
}

const basePlan = {
  goalType: 'feature' as const,
  summary: 'test plan',
  items: [],
  risks: [],
  existingPatterns: []
}

describe('MpaBuilderAdapter', () => {
  // ── Constructor + identity ──

  test('role_is_mpa_builder', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build it', plan: basePlan })
    assert.equal(adapter.role, 'mpa-builder')
  })

  test('agentId_includes_workspaceId', () => {
    const adapter = new MpaBuilderAdapter({
      workspaceId: 'ws-77',
      goal: 'Build it',
      plan: basePlan
    })
    assert.equal(adapter.agentId, 'mpa-builder-ws-77')
  })

  // ── getModelAction ──

  test('getModelAction_returns_da_vinci_build', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const action = (adapter as any).getModelAction()
    assert.equal(action, 'da-vinci:build')
  })

  // ── getPhaseMessage branching ──

  test('getPhaseMessage_with_verifierFeedback_returns_fix_issues', () => {
    const adapter = new MpaBuilderAdapter({
      workspaceId: 'ws-1',
      goal: 'Build',
      plan: basePlan,
      verifierFeedback: {
        allComplete: false,
        totalItems: 1,
        implemented: 0,
        partial: 0,
        missing: 1,
        issues: [{ planItemId: 'item-1', status: 'missing' as const, detail: 'Missing test', filesChecked: [] }],
        crossCutting: { frontendBackendConnected: false, backendDatabaseConnected: false, routesRegistered: false, testsPass: false },
        testOutput: ''
      }
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.ok(result.effectiveMessage.includes('Fix all issues reported by the verifier'))
  })

  test('getPhaseMessage_without_verifierFeedback_returns_begin_implementation', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.ok(result.effectiveMessage.includes('Begin implementation'))
    assert.ok(result.effectiveMessage.includes('Follow the plan'))
  })

  // ── buildMcpConfig (full write access) ──

  test('buildMcpConfig_allowedTools_includes_write_edit_bash', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.includes('Write'))
    assert.ok(allowedTools.includes('Edit'))
    assert.ok(allowedTools.includes('Bash'))
    assert.ok(allowedTools.includes('ListDir'))
  })

  test('buildMcpConfig_allowedTools_includes_read_search', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.includes('Read'))
    assert.ok(allowedTools.includes('Glob'))
    assert.ok(allowedTools.includes('Grep'))
    assert.ok(allowedTools.includes('WebSearch'))
    assert.ok(allowedTools.includes('WebFetch'))
  })

  test('buildMcpConfig_disallowedTools_includes_agent_toolsearch', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { disallowedTools } = result
    assert.ok(disallowedTools, 'disallowedTools should be defined')
    assert.ok(disallowedTools.includes('Agent'))
    assert.ok(disallowedTools.includes('ToolSearch'))
    assert.ok(disallowedTools.includes('AskUserQuestion'))
    assert.ok(disallowedTools.includes('TodoWrite'))
  })

  test('buildMcpConfig_includes_code_graph_when_repomapEnabled_and_workspaceId', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    // repomapEnabled defaults to true in BaseRoleAdapter
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      allowedTools.some((t) => t.startsWith('mcp__code-graph__')),
      'Should include code-graph tools when repomapEnabled and workspaceId set'
    )
  })

  test('buildMcpConfig_excludes_code_graph_without_workspaceId', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      !allowedTools.some((t) => t.startsWith('mcp__code-graph__')),
      'Should exclude code-graph tools when workspaceId is null'
    )
  })

  test('buildMcpConfig_includes_semantic_search_when_enabled_and_workspaceId', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    // semanticSearchEnabled defaults to true in BaseRoleAdapter
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      allowedTools.some((t) => t.startsWith('mcp__semantic-search__')),
      'Should include semantic-search tools when enabled and workspaceId set'
    )
  })

  test('buildMcpConfig_excludes_semantic_search_without_workspaceId', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      !allowedTools.some((t) => t.startsWith('mcp__semantic-search__')),
      'Should exclude semantic-search tools when workspaceId is null'
    )
  })

  test('buildMcpConfig_includes_git_context_tools', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      allowedTools.some((t) => t.startsWith('mcp__git-context__')),
      'Should include git context tools'
    )
  })

  test('buildMcpConfig_includes_code_analysis_tools', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      allowedTools.some((t) => t.startsWith('mcp__code-analysis__')),
      'Should include code analysis tools'
    )
  })

  // ── buildPrompts guard ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    assert.throws(
      () => adapter.buildPrompts(makePromptCtx()),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
