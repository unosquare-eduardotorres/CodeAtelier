/**
 * Unit tests for evaluation-mcp-config.ts — shared read-only MCP tool
 * configuration used by Grill, Greenfield Grill, and Council adapters.
 *
 * Two pure functions: buildReadOnlyToolConfig() and buildNoToolsConfig().
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  buildReadOnlyToolConfig,
  buildNoToolsConfig,
  type EvaluationToolFlags
} from '../role-adapters/evaluation-mcp-config'

// ── Helpers ──

function allFlags(overrides: Partial<EvaluationToolFlags> = {}): EvaluationToolFlags {
  return {
    repomapEnabled: true,
    semanticSearchEnabled: true,
    hasWorkspace: true,
    includeGitContext: true,
    ...overrides
  }
}

describe('buildReadOnlyToolConfig', () => {
  test('all_flags_true_includes_code_graph_semantic_git_analysis_tools', () => {
    const result = buildReadOnlyToolConfig(allFlags())
    // Base tools always present
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.allowedTools.includes('Glob'))
    assert.ok(result.allowedTools.includes('Grep'))
    assert.ok(result.allowedTools.includes('WebSearch'))
    assert.ok(result.allowedTools.includes('WebFetch'))
    // Code graph tools
    assert.ok(result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
    // Semantic search tools
    assert.ok(result.allowedTools.some((t) => t.startsWith('mcp__semantic-search__')))
    // Git context tools
    assert.ok(result.allowedTools.some((t) => t.startsWith('mcp__git-context__')))
    // Code analysis tools
    assert.ok(result.allowedTools.some((t) => t.startsWith('mcp__code-analysis__')))
  })

  test('repomapEnabled_false_excludes_code_graph_tools', () => {
    const result = buildReadOnlyToolConfig(allFlags({ repomapEnabled: false }))
    assert.ok(!result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
    // Semantic search still present
    assert.ok(result.allowedTools.some((t) => t.startsWith('mcp__semantic-search__')))
  })

  test('semanticSearchEnabled_false_excludes_semantic_search_tools', () => {
    const result = buildReadOnlyToolConfig(allFlags({ semanticSearchEnabled: false }))
    assert.ok(!result.allowedTools.some((t) => t.startsWith('mcp__semantic-search__')))
    // Code graph still present
    assert.ok(result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })

  test('includeGitContext_false_excludes_git_context_tools', () => {
    const result = buildReadOnlyToolConfig(allFlags({ includeGitContext: false }))
    assert.ok(!result.allowedTools.some((t) => t.startsWith('mcp__git-context__')))
    // Other tools still present
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })

  test('hasWorkspace_false_excludes_code_graph_and_semantic_even_if_enabled', () => {
    const result = buildReadOnlyToolConfig(
      allFlags({ hasWorkspace: false, repomapEnabled: true, semanticSearchEnabled: true })
    )
    assert.ok(!result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
    assert.ok(!result.allowedTools.some((t) => t.startsWith('mcp__semantic-search__')))
    // Base tools still present
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.allowedTools.includes('WebFetch'))
  })

  test('all_flags_false_only_base_and_analysis_tools', () => {
    const result = buildReadOnlyToolConfig({
      repomapEnabled: false,
      semanticSearchEnabled: false,
      hasWorkspace: false,
      includeGitContext: false
    })
    // Only base + code-analysis
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.allowedTools.includes('Glob'))
    assert.ok(result.allowedTools.includes('Grep'))
    assert.ok(result.allowedTools.includes('WebSearch'))
    assert.ok(result.allowedTools.includes('WebFetch'))
    assert.ok(result.allowedTools.some((t) => t.startsWith('mcp__code-analysis__')))
    // No code-graph, semantic, or git
    assert.ok(!result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
    assert.ok(!result.allowedTools.some((t) => t.startsWith('mcp__semantic-search__')))
    assert.ok(!result.allowedTools.some((t) => t.startsWith('mcp__git-context__')))
  })

  test('disallowedTools_always_includes_write_edit_bash_agent', () => {
    const result = buildReadOnlyToolConfig(allFlags())
    assert.ok(result.disallowedTools.includes('Write'))
    assert.ok(result.disallowedTools.includes('Edit'))
    assert.ok(result.disallowedTools.includes('Bash'))
    assert.ok(result.disallowedTools.includes('Agent'))
  })

  test('disallowedTools_also_includes_control_tools', () => {
    const result = buildReadOnlyToolConfig(allFlags())
    assert.ok(result.disallowedTools.includes('ToolSearch'))
    assert.ok(result.disallowedTools.includes('ExitPlanMode'))
    assert.ok(result.disallowedTools.includes('AskUserQuestion'))
    assert.ok(result.disallowedTools.includes('TodoWrite'))
    assert.ok(result.disallowedTools.includes('TaskCreate'))
    assert.ok(result.disallowedTools.includes('TaskUpdate'))
  })

  test('code_analysis_tools_always_included_regardless_of_flags', () => {
    const result = buildReadOnlyToolConfig({
      repomapEnabled: false,
      semanticSearchEnabled: false,
      hasWorkspace: false,
      includeGitContext: false
    })
    assert.ok(result.allowedTools.includes('mcp__code-analysis__todo_scanner'))
    assert.ok(result.allowedTools.includes('mcp__code-analysis__dependency_health'))
    assert.ok(result.allowedTools.includes('mcp__code-analysis__test_coverage_map'))
  })
})

describe('buildNoToolsConfig', () => {
  test('allowedTools_is_empty', () => {
    const result = buildNoToolsConfig()
    assert.deepEqual(result.allowedTools, [])
  })

  test('disallowedTools_includes_all_common_tools', () => {
    const result = buildNoToolsConfig()
    const expected = [
      'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
      'Agent', 'ToolSearch', 'WebSearch', 'WebFetch',
      'ExitPlanMode', 'AskUserQuestion', 'TodoWrite',
      'TaskCreate', 'TaskUpdate'
    ]
    for (const tool of expected) {
      assert.ok(result.disallowedTools.includes(tool), `Expected ${tool} in disallowedTools`)
    }
  })

  test('returns_fresh_arrays_on_each_call', () => {
    const a = buildNoToolsConfig()
    const b = buildNoToolsConfig()
    assert.notEqual(a.allowedTools, b.allowedTools)
    assert.notEqual(a.disallowedTools, b.disallowedTools)
    assert.deepEqual(a, b)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
