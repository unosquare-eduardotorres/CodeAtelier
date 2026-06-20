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
  phases: [],
  summary: 'test plan',
  planId: 'p1',
  estimatedEffort: 'medium' as const,
  riskAssessment: 'low' as const
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
        status: 'needs-fixes',
        issues: [{ description: 'Missing test', severity: 'major' }],
        summary: 'Issues found'
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
    assert.ok(result.allowedTools.includes('Write'))
    assert.ok(result.allowedTools.includes('Edit'))
    assert.ok(result.allowedTools.includes('Bash'))
    assert.ok(result.allowedTools.includes('ListDir'))
  })

  test('buildMcpConfig_allowedTools_includes_read_search', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.allowedTools.includes('Glob'))
    assert.ok(result.allowedTools.includes('Grep'))
    assert.ok(result.allowedTools.includes('WebSearch'))
    assert.ok(result.allowedTools.includes('WebFetch'))
  })

  test('buildMcpConfig_disallowedTools_includes_agent_toolsearch', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(result.disallowedTools.includes('Agent'))
    assert.ok(result.disallowedTools.includes('ToolSearch'))
    assert.ok(result.disallowedTools.includes('AskUserQuestion'))
    assert.ok(result.disallowedTools.includes('TodoWrite'))
  })

  test('buildMcpConfig_includes_code_graph_when_repomapEnabled_and_workspaceId', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    // repomapEnabled defaults to true in BaseRoleAdapter
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    assert.ok(
      result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')),
      'Should include code-graph tools when repomapEnabled and workspaceId set'
    )
  })

  test('buildMcpConfig_excludes_code_graph_without_workspaceId', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    assert.ok(
      !result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')),
      'Should exclude code-graph tools when workspaceId is null'
    )
  })

  test('buildMcpConfig_includes_semantic_search_when_enabled_and_workspaceId', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    // semanticSearchEnabled defaults to true in BaseRoleAdapter
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    assert.ok(
      result.allowedTools.some((t) => t.startsWith('mcp__semantic-search__')),
      'Should include semantic-search tools when enabled and workspaceId set'
    )
  })

  test('buildMcpConfig_excludes_semantic_search_without_workspaceId', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    assert.ok(
      !result.allowedTools.some((t) => t.startsWith('mcp__semantic-search__')),
      'Should exclude semantic-search tools when workspaceId is null'
    )
  })

  test('buildMcpConfig_includes_git_context_tools', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(
      result.allowedTools.some((t) => t.startsWith('mcp__git-context__')),
      'Should include git context tools'
    )
  })

  test('buildMcpConfig_includes_code_analysis_tools', () => {
    const adapter = new MpaBuilderAdapter({ workspaceId: 'ws-1', goal: 'Build', plan: basePlan })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(
      result.allowedTools.some((t) => t.startsWith('mcp__code-analysis__')),
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
