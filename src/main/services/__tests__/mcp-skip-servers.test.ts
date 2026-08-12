/**
 * Unit tests for deriveSkipServers — determines which MCP servers can be
 * omitted from the CLI config based on the adapter's allowedTools list.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { deriveSkipServers } from '../mcp-skip-servers'

describe('deriveSkipServers', () => {
  test('returns_undefined_when_allowedTools_undefined', () => {
    const result = deriveSkipServers(undefined)
    assert.equal(result, undefined, 'undefined allowedTools = all tools allowed, skip nothing')
  })

  test('returns_all_skippable_servers_when_allowedTools_empty', () => {
    const result = deriveSkipServers([])
    assert.ok(result, 'Should return skip list')
    assert.ok(result.includes('control-actions'), 'Should skip control-actions')
    assert.ok(result.includes('semantic-search'), 'Should skip semantic-search')
    assert.ok(result.includes('code-analysis'), 'Should skip code-analysis')
  })

  test('skips_control_actions_when_no_control_tools_in_allowed', () => {
    // Simulate blueprint allowedTools (no control-actions tools)
    const result = deriveSkipServers([
      'Read',
      'Glob',
      'mcp__code-graph__search_identifiers',
      'mcp__memory__memory_search'
    ])
    assert.ok(result, 'Should return skip list')
    assert.ok(result.includes('control-actions'), 'Should skip control-actions')
  })

  test('does_not_skip_control_actions_when_emit_plan_in_allowed', () => {
    const result = deriveSkipServers(['Read', 'mcp__control-actions__emit_plan'])
    // control-actions should NOT be skipped
    assert.ok(
      !result || !result.includes('control-actions'),
      'Should not skip control-actions when emit_plan is allowed'
    )
  })

  test('does_not_skip_code_analysis_when_its_tools_in_allowed', () => {
    const result = deriveSkipServers(['Read', 'mcp__code-analysis__audit_scan'])
    assert.ok(
      !result || !result.includes('code-analysis'),
      'Should not skip code-analysis when its tools are allowed'
    )
  })

  test('returns_undefined_when_all_skippable_servers_have_tools', () => {
    const result = deriveSkipServers([
      'mcp__control-actions__emit_plan',
      'mcp__semantic-search__semantic_search',
      'mcp__code-analysis__eslint_check'
    ])
    assert.equal(result, undefined, 'No servers to skip when all have tools allowed')
  })

  test('blueprint_typical_allowedTools_skips_correct_servers', () => {
    // Simulates the actual blueprint allowedTools (full mode, not lean)
    const blueprintTools = [
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      'mcp__code-graph__search_identifiers',
      'mcp__code-graph__file_outline',
      'mcp__semantic-search__semantic_search',
      'mcp__git-context__git_log',
      'mcp__code-analysis__eslint_check',
      'mcp__memory__memory_search',
      'mcp__memory__memory_record',
      'mcp__memory__memory_flag'
    ]
    const result = deriveSkipServers(blueprintTools)
    assert.ok(result, 'Should return skip list for blueprint')
    // Blueprint doesn't use control-actions
    assert.ok(result.includes('control-actions'), 'Skip control-actions')
    // semantic-search and code-analysis are in allowedTools — NOT skipped
    assert.ok(!result.includes('semantic-search'), 'Keep semantic-search')
    assert.ok(!result.includes('code-analysis'), 'Keep code-analysis')
    assert.equal(result.length, 1, 'Exactly 1 server skipped')
  })

  // Phase 1.3: Lean build MCP removes semantic-search + code-analysis
  test('lean_build_allowedTools_skips_semantic_search_and_code_analysis', () => {
    // Simulates build allowedTools with leanBuildMcp=true (no semantic-search, no code-analysis)
    const leanBuildTools = [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash',
      'WebSearch',
      'WebFetch',
      'ListDir',
      'mcp__code-graph__search_identifiers',
      'mcp__code-graph__file_outline',
      'mcp__git-context__git_log',
      'mcp__memory__memory_search'
    ]
    const result = deriveSkipServers(leanBuildTools)
    assert.ok(result, 'Should return skip list for lean build')
    assert.ok(result.includes('semantic-search'), 'Lean: skip semantic-search')
    assert.ok(result.includes('code-analysis'), 'Lean: skip code-analysis')
    assert.ok(result.includes('control-actions'), 'Lean: skip control-actions')
    assert.equal(result.length, 3, 'All 3 skippable servers absent from lean build')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
