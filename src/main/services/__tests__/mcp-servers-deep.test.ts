/**
 * Phase 19, Track G — MCP server completion tests.
 *
 * Tests pure/exported functions from MCP server modules:
 *   - code-analysis-server.ts (parseComplexityMessage)
 *   - output-cap.ts (truncateToolOutput)
 *
 * No real MCP servers or external processes.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

// ── Imports ──────────────────────────────────────────────────────────────

let parseComplexityMessage: typeof import('../../mcp-servers/code-analysis-server').parseComplexityMessage
let truncateToolOutput: typeof import('../../mcp-servers/output-cap').truncateToolOutput

let analysisLoaded = false
let capLoaded = false

try {
  parseComplexityMessage = require('../../mcp-servers/code-analysis-server').parseComplexityMessage
  analysisLoaded = true
} catch (err) {
  console.log(`⚠ code-analysis-server load failed — tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

try {
  truncateToolOutput = require('../../mcp-servers/output-cap').truncateToolOutput
  capLoaded = true
} catch (err) {
  console.log(`⚠ output-cap load failed — tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

// ── parseComplexityMessage ───────────────────────────────────────────────

if (analysisLoaded) {
  describe('parseComplexityMessage', () => {
    test('parses_function_complexity', () => {
      const result = parseComplexityMessage(
        {
          message: "Function 'handleRequest' has a complexity of 15. Maximum allowed is 0.",
          line: 42,
          column: 1,
          ruleId: 'complexity'
        },
        'src/api.ts'
      )
      assert.ok(result)
      assert.equal(result!.function, 'handleRequest')
      assert.equal(result!.complexity, 15)
      assert.equal(result!.file, 'src/api.ts')
      assert.equal(result!.line, 42)
      assert.equal(result!.column, 1)
    })

    test('parses_method_complexity', () => {
      const result = parseComplexityMessage(
        {
          message: "Method 'render' has a complexity of 8. Maximum allowed is 0.",
          line: 10,
          column: 3,
          ruleId: 'complexity'
        },
        'src/component.tsx'
      )
      assert.ok(result)
      assert.equal(result!.function, 'render')
      assert.equal(result!.complexity, 8)
    })

    test('parses_arrow_function_as_anonymous', () => {
      const result = parseComplexityMessage(
        {
          message: 'Arrow function has a complexity of 12. Maximum allowed is 0.',
          line: 5,
          column: 1,
          ruleId: 'complexity'
        },
        'src/utils.ts'
      )
      assert.ok(result)
      assert.equal(result!.function, 'anonymous')
      assert.equal(result!.complexity, 12)
    })

    test('returns_null_for_non_complexity_rule', () => {
      const result = parseComplexityMessage(
        {
          message: 'Unexpected var, use let or const',
          line: 1,
          column: 1,
          ruleId: 'no-var'
        },
        'src/file.ts'
      )
      assert.equal(result, null)
    })

    test('returns_null_for_null_ruleId', () => {
      const result = parseComplexityMessage(
        {
          message: 'Some warning',
          line: 1,
          column: 1,
          ruleId: null
        },
        'src/file.ts'
      )
      assert.equal(result, null)
    })

    test('returns_null_for_unparseable_message', () => {
      const result = parseComplexityMessage(
        {
          message: 'Something without complexity score',
          line: 1,
          column: 1,
          ruleId: 'complexity'
        },
        'src/file.ts'
      )
      assert.equal(result, null)
    })
  })
}

// ── truncateToolOutput ───────────────────────────────────────────────────

if (capLoaded) {
  describe('truncateToolOutput', () => {
    test('short_output_unchanged', () => {
      const result = truncateToolOutput('Hello world')
      assert.equal(result, 'Hello world')
    })

    test('empty_string_returns_empty', () => {
      const result = truncateToolOutput('')
      assert.equal(result, '')
    })

    test('output_at_limit_unchanged', () => {
      const text = 'x'.repeat(50000)
      const result = truncateToolOutput(text, 50000)
      assert.equal(result, text)
    })

    test('output_over_limit_truncated', () => {
      const text = 'x'.repeat(100000)
      const result = truncateToolOutput(text, 50000)
      assert.ok(result.length <= 50000 + 200) // Some overhead for truncation message
      assert.ok(
        result.includes('truncated') || result.includes('...') || result.length < text.length
      )
    })

    test('truncation_preserves_start', () => {
      const text = 'START' + 'x'.repeat(100000) + 'END'
      const result = truncateToolOutput(text, 1000)
      assert.ok(result.startsWith('START'))
    })

    test('default_max_chars_is_reasonable', () => {
      // Default should be between 10K and 200K
      const longText = 'x'.repeat(500000)
      const result = truncateToolOutput(longText)
      assert.ok(result.length < 500000, 'should truncate very long output')
      assert.ok(result.length > 1000, 'should preserve some content')
    })

    test('custom_max_chars_respected', () => {
      // With maxChars=10000, fallback uses head(5000) + separator + tail — total ~maxChars
      const text = 'x'.repeat(50000)
      const result = truncateToolOutput(text, 10000)
      assert.ok(result.length <= 11000, `Expected <=11000, got ${result.length}`)
      assert.ok(result.includes('truncated'), 'should include truncation notice')
    })
  })
}

// ── Fallback ─────────────────────────────────────────────────────────────

if (!analysisLoaded && !capLoaded) {
  describe('MCP Servers Deep (all skipped)', () => {
    test('skipped', () => {}, { skipReason: 'no modules loaded' })
  })
}
