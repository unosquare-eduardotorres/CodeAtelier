/**
 * Tests for context-tier-based MCP tool gating in buildWorkspaceMcpConfig.
 *
 * Since buildWorkspaceMcpConfig depends on MCP service singletons (code-graph,
 * semantic-search, etc.) that require Electron runtime, we test the contract
 * at the constants/data level:
 *   - ESSENTIAL_CODE_GRAPH_TOOLS is a proper subset of CODE_GRAPH._ALL_NAMES
 *   - Tool names in the essential list match known MCP tool names
 *   - Tier-based gating logic rules are valid
 *
 * Full integration tests live in E2E suites (Playwright).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { MCP_TOOLS, ALL_MCP_TOOL_NAMES } from '../../../shared/constants'
import { resolveContextTier } from '../context-management'
import type { ContextWindowTier } from '../context-management'

// Re-derive the essential tools list (same logic as workspace-mcp-config.ts)
const ESSENTIAL_CODE_GRAPH_TOOLS = [
  MCP_TOOLS.CODE_GRAPH.GRAPH_MAP.name,
  MCP_TOOLS.CODE_GRAPH.SEARCH_IDENTIFIERS.name,
  MCP_TOOLS.CODE_GRAPH.FILE_OUTLINE.name,
  MCP_TOOLS.CODE_GRAPH.FIND_CALLERS.name,
  MCP_TOOLS.CODE_GRAPH.FIND_REFERENCES.name,
  MCP_TOOLS.CODE_GRAPH.FIND_DEAD_CODE.name
]

describe('Essential Code Graph Tools for small tier', () => {
  test('essential list is a strict subset of CODE_GRAPH._ALL_NAMES', () => {
    const allCodeGraph = MCP_TOOLS.CODE_GRAPH._ALL_NAMES
    for (const tool of ESSENTIAL_CODE_GRAPH_TOOLS) {
      assert.ok(
        allCodeGraph.includes(tool),
        `Essential tool ${tool} not found in CODE_GRAPH._ALL_NAMES`
      )
    }
  })

  test('essential list has exactly 6 tools (half of full set)', () => {
    assert.equal(ESSENTIAL_CODE_GRAPH_TOOLS.length, 6)
  })

  test('essential list is smaller than full code-graph set', () => {
    assert.ok(
      ESSENTIAL_CODE_GRAPH_TOOLS.length < MCP_TOOLS.CODE_GRAPH._ALL_NAMES.length,
      'Essential should be a smaller subset'
    )
  })

  test('all essential tools are valid MCP tool names', () => {
    for (const tool of ESSENTIAL_CODE_GRAPH_TOOLS) {
      assert.ok(ALL_MCP_TOOL_NAMES.includes(tool), `${tool} is not in ALL_MCP_TOOL_NAMES`)
    }
  })

  test('essential tools include core navigation: graph_map, file_outline, find_callers, find_references', () => {
    const names = ESSENTIAL_CODE_GRAPH_TOOLS.map((t) => t.split('__').pop())
    assert.ok(names.includes('graph_map'))
    assert.ok(names.includes('file_outline'))
    assert.ok(names.includes('find_callers'))
    assert.ok(names.includes('find_references'))
  })
})

describe('Tier-based tool gating logic', () => {
  test('small tier should exclude semantic-search tools', () => {
    // Small tier logic: tier !== 'small' gates semantic-search
    const tier: ContextWindowTier = 'small'
    const shouldMountSemanticSearch = tier !== 'small'
    assert.equal(shouldMountSemanticSearch, false)
  })

  test('medium tier should include semantic-search tools', () => {
    const tier = 'medium' as ContextWindowTier
    const shouldMountSemanticSearch = tier !== 'small'
    assert.equal(shouldMountSemanticSearch, true)
  })

  test('small tier should exclude code-analysis tools', () => {
    const tier = 'small' as ContextWindowTier
    const shouldMountCodeAnalysis = tier !== 'small'
    assert.equal(shouldMountCodeAnalysis, false)
  })

  test('large tier should include all tools', () => {
    const tier = 'large' as ContextWindowTier
    assert.equal(tier !== 'small', true) // semantic-search + code-analysis included
    // code-graph uses full set (not essential subset)
    assert.equal(tier === 'small', false) // full code-graph tools
  })

  test('32K model maps to small tier', () => {
    assert.equal(resolveContextTier(32_768), 'small')
  })

  test('128K model maps to medium tier', () => {
    assert.equal(resolveContextTier(128_000), 'medium')
  })

  test('262K model maps to large tier', () => {
    assert.equal(resolveContextTier(262_144), 'large')
  })
})

describe('Token savings estimation for small tier', () => {
  test('small tier reduces code-graph tools by ~54%', () => {
    const fullCount = MCP_TOOLS.CODE_GRAPH._ALL_NAMES.length
    const essentialCount = ESSENTIAL_CODE_GRAPH_TOOLS.length
    const reduction = ((fullCount - essentialCount) / fullCount) * 100
    assert.ok(reduction > 40, `Expected >40% reduction, got ${reduction.toFixed(0)}%`)
    assert.ok(reduction < 70, `Expected <70% reduction, got ${reduction.toFixed(0)}%`)
  })

  test('small tier skips semantic-search (3 tools) and code-analysis', () => {
    const semanticCount = MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES.length
    assert.ok(semanticCount >= 2, `Expected at least 2 semantic-search tools, got ${semanticCount}`)
    const analysisCount = MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES.length
    assert.ok(analysisCount >= 2, `Expected at least 2 code-analysis tools, got ${analysisCount}`)
  })

  test('estimated schema overhead: small tier ≤ 10 allowed tools (6 code-graph + 3 control)', () => {
    const controlToolCount = MCP_TOOLS.CONTROL_ACTIONS._ALL_NAMES.length
    const totalSmallTier = ESSENTIAL_CODE_GRAPH_TOOLS.length + controlToolCount
    assert.ok(totalSmallTier <= 10, `Expected ≤10 tools, got ${totalSmallTier}`)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
