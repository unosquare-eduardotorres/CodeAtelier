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
    assert.ok(result.includes('checkpoint-context'), 'Should skip checkpoint-context')
    assert.ok(result.includes('control-actions'), 'Should skip control-actions')
    assert.ok(result.includes('github-context'), 'Should skip github-context')
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
    const result = deriveSkipServers([
      'Read',
      'mcp__control-actions__emit_plan'
    ])
    // control-actions should NOT be skipped
    assert.ok(
      !result || !result.includes('control-actions'),
      'Should not skip control-actions when emit_plan is allowed'
    )
  })

  test('does_not_skip_checkpoint_context_when_its_tools_in_allowed', () => {
    const result = deriveSkipServers([
      'Read',
      'mcp__checkpoint-context__list_checkpoints'
    ])
    assert.ok(
      !result || !result.includes('checkpoint-context'),
      'Should not skip checkpoint-context when its tools are allowed'
    )
  })

  test('returns_undefined_when_all_skippable_servers_have_tools', () => {
    const result = deriveSkipServers([
      'mcp__checkpoint-context__list_checkpoints',
      'mcp__control-actions__emit_plan',
      'mcp__github-context__get_pr_status'
    ])
    assert.equal(result, undefined, 'No servers to skip when all have tools allowed')
  })

  test('blueprint_typical_allowedTools_skips_correct_servers', () => {
    // Simulates the actual blueprint allowedTools after W1 changes
    const blueprintTools = [
      'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
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
    // Blueprint doesn't use checkpoint-context, control-actions, or github-context
    assert.ok(result.includes('checkpoint-context'), 'Skip checkpoint-context')
    assert.ok(result.includes('control-actions'), 'Skip control-actions')
    assert.ok(result.includes('github-context'), 'Skip github-context')
    assert.equal(result.length, 3, 'Exactly 3 servers skipped')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
