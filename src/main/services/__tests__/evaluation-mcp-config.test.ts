/**
 * Unit tests for role-adapters/evaluation-mcp-config.ts — evaluation tool configs.
 *
 * Phase 6A Coverage Improvement — lines 83-99, 106-126 (currently 69% → 80%+).
 * Covers: buildReadOnlyToolConfig flag permutations, buildNoToolsConfig shape.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  buildReadOnlyToolConfig,
  buildNoToolsConfig,
  type EvaluationToolFlags
} from '../role-adapters/evaluation-mcp-config'

// ── buildReadOnlyToolConfig ──

describe('buildReadOnlyToolConfig', () => {
  function makeFlags(overrides: Partial<EvaluationToolFlags> = {}): EvaluationToolFlags {
    return {
      repomapEnabled: false,
      semanticSearchEnabled: false,
      hasWorkspace: false,
      includeGitContext: false,
      ...overrides
    }
  }

  test('all flags false → base tools + code-analysis only', () => {
    const result = buildReadOnlyToolConfig(makeFlags())
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.allowedTools.includes('Glob'))
    assert.ok(result.allowedTools.includes('Grep'))
    assert.ok(result.allowedTools.includes('WebSearch'))
    assert.ok(result.allowedTools.includes('WebFetch'))
    // Code analysis always included
    assert.ok(result.allowedTools.some((t) => t.includes('code-analysis')))
    // No code-graph, semantic-search, or git tools
    assert.ok(!result.allowedTools.some((t) => t.includes('code-graph')))
    assert.ok(!result.allowedTools.some((t) => t.includes('semantic-search')))
    assert.ok(!result.allowedTools.some((t) => t.includes('git-context')))
  })

  test('repomapEnabled + hasWorkspace → includes code-graph tools', () => {
    const result = buildReadOnlyToolConfig(makeFlags({ repomapEnabled: true, hasWorkspace: true }))
    const cgTools = result.allowedTools.filter((t) => t.includes('code-graph'))
    assert.ok(cgTools.length >= 10, `expected ≥10 code-graph tools, got ${cgTools.length}`)
    assert.ok(result.allowedTools.includes('mcp__code-graph__graph_map'))
    assert.ok(result.allowedTools.includes('mcp__code-graph__find_callers'))
  })

  test('repomapEnabled but !hasWorkspace → no code-graph tools', () => {
    const result = buildReadOnlyToolConfig(
      makeFlags({ repomapEnabled: true, hasWorkspace: false })
    )
    assert.ok(!result.allowedTools.some((t) => t.includes('code-graph')))
  })

  test('semanticSearchEnabled + hasWorkspace → includes semantic-search tools', () => {
    const result = buildReadOnlyToolConfig(
      makeFlags({ semanticSearchEnabled: true, hasWorkspace: true })
    )
    assert.ok(result.allowedTools.includes('mcp__semantic-search__semantic_search'))
    assert.ok(result.allowedTools.includes('mcp__semantic-search__similar_code'))
    assert.ok(result.allowedTools.includes('mcp__semantic-search__codebase_concepts'))
  })

  test('semanticSearchEnabled but !hasWorkspace → no semantic-search tools', () => {
    const result = buildReadOnlyToolConfig(
      makeFlags({ semanticSearchEnabled: true, hasWorkspace: false })
    )
    assert.ok(!result.allowedTools.some((t) => t.includes('semantic-search')))
  })

  test('includeGitContext → includes git-context tools (no workspace dependency)', () => {
    const result = buildReadOnlyToolConfig(
      makeFlags({ includeGitContext: true, hasWorkspace: false })
    )
    assert.ok(result.allowedTools.includes('mcp__git-context__git_log'))
    assert.ok(result.allowedTools.includes('mcp__git-context__git_diff'))
    assert.ok(result.allowedTools.includes('mcp__git-context__git_blame'))
  })

  test('all flags true → includes all optional tool sets', () => {
    const result = buildReadOnlyToolConfig(
      makeFlags({
        repomapEnabled: true,
        semanticSearchEnabled: true,
        hasWorkspace: true,
        includeGitContext: true
      })
    )
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.allowedTools.some((t) => t.includes('code-graph')))
    assert.ok(result.allowedTools.some((t) => t.includes('semantic-search')))
    assert.ok(result.allowedTools.some((t) => t.includes('git-context')))
    assert.ok(result.allowedTools.some((t) => t.includes('code-analysis')))
  })

  test('disallowedTools always contains write/agent tools', () => {
    const result = buildReadOnlyToolConfig(makeFlags())
    assert.ok(result.disallowedTools.includes('Write'))
    assert.ok(result.disallowedTools.includes('Edit'))
    assert.ok(result.disallowedTools.includes('Bash'))
    assert.ok(result.disallowedTools.includes('Agent'))
    assert.ok(result.disallowedTools.includes('AskUserQuestion'))
    assert.equal(result.disallowedTools.length, 10)
  })
})

// ── buildNoToolsConfig ──

describe('buildNoToolsConfig', () => {
  test('returns empty allowedTools', () => {
    const result = buildNoToolsConfig()
    assert.deepEqual(result.allowedTools, [])
  })

  test('disallowedTools includes all read + write + agent tools', () => {
    const result = buildNoToolsConfig()
    assert.ok(result.disallowedTools.includes('Read'))
    assert.ok(result.disallowedTools.includes('Write'))
    assert.ok(result.disallowedTools.includes('Edit'))
    assert.ok(result.disallowedTools.includes('Bash'))
    assert.ok(result.disallowedTools.includes('Glob'))
    assert.ok(result.disallowedTools.includes('Grep'))
    assert.ok(result.disallowedTools.includes('Agent'))
    assert.ok(result.disallowedTools.includes('WebSearch'))
    assert.ok(result.disallowedTools.includes('WebFetch'))
    assert.ok(result.disallowedTools.includes('TaskCreate'))
    assert.ok(result.disallowedTools.includes('TaskUpdate'))
    assert.equal(result.disallowedTools.length, 15)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
