/**
 * Unit tests for MCP server modules — verifies exports, tool constants, and
 * pure functions available from the MCP server files.
 *
 * Strategy: Import modules and test their pure exported functions.
 * The tool registration (server.tool()) requires MCP SDK stubs — we test
 * what's accessible without SDK dependency.
 *
 * Covers: code-analysis-server (parseComplexityMessage), output-cap (truncateToolOutput),
 * and import verification for remaining server files.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './../../services/__tests__/test-harness'

// ── Pure function imports ──

import { parseComplexityMessage } from '../code-analysis-server'
import { truncateToolOutput } from '../output-cap'

// ── parseComplexityMessage tests ──

describe('parseComplexityMessage', () => {
  test('extracts_complexity_from_valid_message', () => {
    const result = parseComplexityMessage(
      { message: "Function 'render' has a complexity of 12. Maximum allowed is 0.", line: 42, column: 1, ruleId: 'complexity' },
      'src/app.ts'
    )
    assert.ok(result)
    assert.equal(result.complexity, 12)
    assert.equal(result.function, 'render')
    assert.equal(result.line, 42)
    assert.equal(result.file, 'src/app.ts')
  })

  test('extracts_method_name', () => {
    const result = parseComplexityMessage(
      { message: "Method 'processData' has a complexity of 8. Maximum allowed is 0.", line: 10, column: 3, ruleId: 'complexity' },
      'src/service.ts'
    )
    assert.ok(result)
    assert.equal(result.function, 'processData')
    assert.equal(result.complexity, 8)
  })

  test('returns_null_for_non_complexity_rule', () => {
    const result = parseComplexityMessage(
      { message: "Unexpected var", line: 1, column: 1, ruleId: 'no-var' },
      'src/app.ts'
    )
    assert.equal(result, null)
  })

  test('returns_null_for_null_ruleId', () => {
    const result = parseComplexityMessage(
      { message: "Some error", line: 1, column: 1, ruleId: null },
      'src/app.ts'
    )
    assert.equal(result, null)
  })

  test('returns_null_when_no_complexity_number', () => {
    const result = parseComplexityMessage(
      { message: "Function has no complexity", line: 1, column: 1, ruleId: 'complexity' },
      'src/app.ts'
    )
    assert.equal(result, null)
  })

  test('anonymous_function_when_no_name_match', () => {
    const result = parseComplexityMessage(
      { message: "Arrow function has a complexity of 15. Maximum allowed is 0.", line: 5, column: 1, ruleId: 'complexity' },
      'src/utils.ts'
    )
    assert.ok(result)
    assert.equal(result.function, 'anonymous')
    assert.equal(result.complexity, 15)
  })

  test('preserves_file_path', () => {
    const result = parseComplexityMessage(
      { message: "Function 'x' has a complexity of 3. Maximum allowed is 0.", line: 1, column: 1, ruleId: 'complexity' },
      'deep/nested/path/file.ts'
    )
    assert.ok(result)
    assert.equal(result.file, 'deep/nested/path/file.ts')
  })

  test('preserves_column', () => {
    const result = parseComplexityMessage(
      { message: "Function 'x' has a complexity of 3. Maximum allowed is 0.", line: 1, column: 15, ruleId: 'complexity' },
      'src/app.ts'
    )
    assert.ok(result)
    assert.equal(result.column, 15)
  })
})

// ── truncateToolOutput tests ──

describe('truncateToolOutput', () => {
  test('short_output_passes_through', () => {
    const result = truncateToolOutput('Hello world', 100)
    assert.equal(result, 'Hello world')
  })

  test('long_output_truncated', () => {
    const longText = 'A'.repeat(50000)
    // Default max is 30_000, HEAD_SIZE is 5000 — use a budget above HEAD_SIZE
    const result = truncateToolOutput(longText, 10000)
    // Result should be roughly maxChars (head portion + separator + tail)
    assert.ok(result.includes('truncated'), 'Should include truncation notice')
    // The original 50K is not passed through unchanged
    assert.ok(result !== longText, 'Should not equal original')
  })

  test('empty_string_passes_through', () => {
    const result = truncateToolOutput('', 100)
    assert.equal(result, '')
  })

  test('exact_limit_passes_through', () => {
    const text = 'A'.repeat(100)
    const result = truncateToolOutput(text, 100)
    assert.equal(result, text)
  })

  test('default_max_chars_applied', () => {
    // Default is high enough that short strings pass through
    const result = truncateToolOutput('short text')
    assert.equal(result, 'short text')
  })
})

// ── MCP tool name constants from shared/constants ──

import { MCP_TOOLS } from '../../../shared/constants'

describe('MCP_TOOLS registry', () => {
  test('code_graph_server_has_tools', () => {
    assert.ok(MCP_TOOLS.CODE_GRAPH._SERVER)
    assert.ok(MCP_TOOLS.CODE_GRAPH._ALL_NAMES.length > 0)
  })

  test('semantic_search_server_has_tools', () => {
    assert.ok(MCP_TOOLS.SEMANTIC_SEARCH._SERVER)
    assert.ok(MCP_TOOLS.SEMANTIC_SEARCH._ALL_NAMES.length > 0)
  })

  test('control_actions_server_has_tools', () => {
    assert.ok(MCP_TOOLS.CONTROL_ACTIONS._SERVER)
    assert.ok(MCP_TOOLS.CONTROL_ACTIONS._ALL_NAMES.length > 0)
  })

  test('git_context_server_has_tools', () => {
    assert.ok(MCP_TOOLS.GIT_CONTEXT._SERVER)
    assert.ok(MCP_TOOLS.GIT_CONTEXT._ALL_NAMES.length > 0)
  })

  test('code_analysis_server_has_tools', () => {
    assert.ok(MCP_TOOLS.CODE_ANALYSIS._SERVER)
    assert.ok(MCP_TOOLS.CODE_ANALYSIS._ALL_NAMES.length > 0)
  })

  test('all_tool_names_follow_mcp_convention', () => {
    for (const name of MCP_TOOLS.CODE_GRAPH._ALL_NAMES) {
      assert.ok(name.startsWith('mcp__'), `Tool name should start with mcp__: ${name}`)
    }
    for (const name of MCP_TOOLS.CONTROL_ACTIONS._ALL_NAMES) {
      assert.ok(name.startsWith('mcp__'), `Tool name should start with mcp__: ${name}`)
    }
  })

  test('code_graph_prefix_matches_server', () => {
    assert.equal(MCP_TOOLS.CODE_GRAPH._PREFIX, `mcp__${MCP_TOOLS.CODE_GRAPH._SERVER}__`)
  })

  test('semantic_search_prefix_matches_server', () => {
    assert.equal(MCP_TOOLS.SEMANTIC_SEARCH._PREFIX, `mcp__${MCP_TOOLS.SEMANTIC_SEARCH._SERVER}__`)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
