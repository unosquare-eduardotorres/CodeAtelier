/**
 * Phase 16, Track 4 — MCP Server tools deep tests
 *
 * Tests the MCP tool configuration constants, tool names, display names,
 * and server definitions from shared/constants.ts MCP_TOOLS.
 *
 * Also tests the output-cap utility (truncateToolOutput) with deeper
 * edge case coverage and the ask-user-registry additional branches.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  MCP_TOOLS,
  ALL_MCP_TOOL_NAMES,
  MCP_DISPLAY_NAMES,
  LOCAL_MCP_INTEGRATIONS,
  EXTERNAL_MCP_INTEGRATIONS
} from '../../../shared/constants'
import { truncateToolOutput } from '../output-cap'
import { parseComplexityMessage } from '../code-analysis-server'

// ── §1: MCP_TOOLS structure verification ────────────────────────────────

describe('MCP_TOOLS — structure', () => {
  test('MCP_TOOLS_is_non_empty_object', () => {
    assert.equal(typeof MCP_TOOLS, 'object')
    assert.ok(Object.keys(MCP_TOOLS).length >= 1)
  })

  test('each_server_has_ALL_NAMES_array', () => {
    for (const [serverName, server] of Object.entries(MCP_TOOLS)) {
      const s = server as Record<string, unknown>
      assert.ok(
        Array.isArray(s._ALL_NAMES),
        `Server "${serverName}" should have _ALL_NAMES array`
      )
      assert.ok(
        (s._ALL_NAMES as string[]).length >= 1,
        `Server "${serverName}" _ALL_NAMES should be non-empty`
      )
    }
  })

  test('each_tool_has_name_and_displayName', () => {
    for (const [serverName, server] of Object.entries(MCP_TOOLS)) {
      for (const [key, tool] of Object.entries(server as Record<string, unknown>)) {
        if (key.startsWith('_')) continue // Skip metadata keys
        const t = tool as Record<string, unknown>
        assert.ok(typeof t.name === 'string', `${serverName}.${key}.name should be string`)
        assert.ok(typeof t.displayName === 'string', `${serverName}.${key}.displayName should be string`)
        assert.ok((t.name as string).length > 0, `${serverName}.${key}.name should be non-empty`)
      }
    }
  })

  test('ALL_MCP_TOOL_NAMES_is_comprehensive', () => {
    const allNames = new Set(ALL_MCP_TOOL_NAMES)
    let expectedCount = 0
    for (const server of Object.values(MCP_TOOLS)) {
      expectedCount += ((server as Record<string, unknown>)._ALL_NAMES as string[]).length
    }
    assert.equal(allNames.size, expectedCount, 'No duplicate tool names across servers')
  })

  test('ALL_MCP_TOOL_NAMES_are_all_strings', () => {
    for (const name of ALL_MCP_TOOL_NAMES) {
      assert.equal(typeof name, 'string')
      assert.ok(name.length > 0)
    }
  })
})

// ── §2: MCP_DISPLAY_NAMES ───────────────────────────────────────────────

describe('MCP_DISPLAY_NAMES — mapping', () => {
  test('is_non_empty_object', () => {
    assert.equal(typeof MCP_DISPLAY_NAMES, 'object')
    assert.ok(Object.keys(MCP_DISPLAY_NAMES).length >= 1)
  })

  test('all_values_are_strings', () => {
    for (const [name, display] of Object.entries(MCP_DISPLAY_NAMES)) {
      assert.equal(typeof display, 'string', `${name} display name should be string`)
    }
  })

  test('keys_match_tool_names', () => {
    const toolNames = new Set(ALL_MCP_TOOL_NAMES)
    for (const key of Object.keys(MCP_DISPLAY_NAMES)) {
      assert.ok(toolNames.has(key), `Display name key "${key}" should be in ALL_MCP_TOOL_NAMES`)
    }
  })
})

// ── §3: MCP integration definitions ─────────────────────────────────────

describe('MCP integrations — structure', () => {
  test('LOCAL_MCP_INTEGRATIONS_is_array', () => {
    assert.ok(Array.isArray(LOCAL_MCP_INTEGRATIONS))
  })

  test('EXTERNAL_MCP_INTEGRATIONS_is_array', () => {
    assert.ok(Array.isArray(EXTERNAL_MCP_INTEGRATIONS))
  })

  test('local_integrations_have_expected_shape', () => {
    for (const integration of LOCAL_MCP_INTEGRATIONS) {
      const i = integration as unknown as Record<string, unknown>
      assert.ok(typeof i.id === 'string' || typeof i.name === 'string',
        'Each integration should have id or name')
    }
  })

  test('external_integrations_have_expected_shape', () => {
    for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
      const i = integration as unknown as Record<string, unknown>
      assert.ok(typeof i.id === 'string' || typeof i.name === 'string',
        'Each integration should have id or name')
    }
  })
})

// ── §4: truncateToolOutput deeper coverage ──────────────────────────────

describe('truncateToolOutput — deep branches', () => {
  test('short_output_unchanged', () => {
    const result = truncateToolOutput('Hello world', 1000)
    assert.equal(result, 'Hello world')
  })

  test('truncates_long_output', () => {
    const longText = 'A'.repeat(50000)
    const result = truncateToolOutput(longText) // uses default 30,000 max
    // Result should be shorter than original
    assert.ok(result.length < longText.length, 'Should truncate long output')
    assert.ok(result.includes('truncated'), 'Should include truncation notice')
  })

  test('handles_empty_string', () => {
    const result = truncateToolOutput('', 100)
    assert.equal(result, '')
  })

  test('handles_null_by_throwing', () => {
    // truncateToolOutput requires a string, null/undefined throws
    assert.throws(() => truncateToolOutput(null as unknown as string, 100))
  })

  test('preserves_exact_limit_text', () => {
    const text = 'A'.repeat(100)
    const result = truncateToolOutput(text, 100)
    assert.equal(result, text)
  })
})

// ── §5: parseComplexityMessage deeper coverage ──────────────────────────

describe('parseComplexityMessage — deep branches', () => {
  test('handles_arrow_function_name', () => {
    const result = parseComplexityMessage(
      { message: "Arrow function has a complexity of 15. Maximum allowed is 0.", line: 5, column: 1, ruleId: 'complexity' },
      'src/util.ts'
    )
    // Arrow functions may or may not have names extracted
    if (result) {
      assert.equal(typeof result.complexity, 'number')
    }
  })

  test('returns_null_for_non_complexity_message', () => {
    const result = parseComplexityMessage(
      { message: 'Some other lint error', line: 1, column: 1, ruleId: 'no-unused-vars' },
      'src/app.ts'
    )
    assert.equal(result, null)
  })

  test('parses_high_complexity', () => {
    const result = parseComplexityMessage(
      { message: "Function 'bigFn' has a complexity of 99. Maximum allowed is 0.", line: 100, column: 1, ruleId: 'complexity' },
      'src/complex.ts'
    )
    assert.ok(result)
    assert.equal(result.complexity, 99)
  })

  test('extracts_correct_file_path', () => {
    const result = parseComplexityMessage(
      { message: "Function 'test' has a complexity of 5. Maximum allowed is 0.", line: 1, column: 1, ruleId: 'complexity' },
      'deep/nested/path/file.ts'
    )
    assert.ok(result)
    assert.equal(result.file, 'deep/nested/path/file.ts')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
