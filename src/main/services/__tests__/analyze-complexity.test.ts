/**
 * Unit tests for analyze_complexity tool — message parsing, extension gating,
 * and output formatting.
 *
 * Mirrors the parseComplexityMessage() and SUPPORTED_EXTENSIONS logic
 * from code-analysis-server.ts (same pattern as eslint-mcp-tools.test.ts).
 * No actual ESLint invocations — tests the pure parsing/filtering logic.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  ESLINT_EXTENSIONS,
  ALL_SUPPORTED_EXTENSIONS,
  complexityEngineFor
} from '../complexity-analyzer'

// ── Mirror of server types/logic (avoids importing the server, which calls main()) ──

interface ComplexityResult {
  file: string
  function: string
  line: number
  column: number
  complexity: number
}

/**
 * Identical to parseComplexityMessage in code-analysis-server.ts.
 * Kept in sync manually — changes to the server function must be reflected here.
 */
function parseComplexityMessage(
  msg: { message: string; line: number; column: number; ruleId: string | null },
  filePath: string
): ComplexityResult | null {
  if (msg.ruleId !== 'complexity') return null
  const scoreMatch = msg.message.match(/complexity of (\d+)/)
  if (!scoreMatch) return null
  const complexity = parseInt(scoreMatch[1], 10)

  const nameMatch = msg.message.match(/(?:Function|Method)\s+'([^']+)'/)
  const funcName = nameMatch ? nameMatch[1] : 'anonymous'

  return { file: filePath, function: funcName, line: msg.line, column: msg.column, complexity }
}

// Imported from the module the handler itself uses — a local copy could stay
// green while the real routing table diverged, which is how these tests kept
// asserting `.py` was unsupported.
const SUPPORTED_EXTENSIONS = ESLINT_EXTENSIONS

// ── Tests ──

describe('parseComplexityMessage', () => {
  test('extracts named function with complexity score', () => {
    const result = parseComplexityMessage(
      {
        ruleId: 'complexity',
        message: "Function 'handleRequest' has a complexity of 12. Maximum allowed is 0.",
        line: 42,
        column: 1
      },
      'src/server.ts'
    )
    assert.deepEqual(result, {
      file: 'src/server.ts',
      function: 'handleRequest',
      line: 42,
      column: 1,
      complexity: 12
    })
  })

  test('extracts arrow function as anonymous', () => {
    const result = parseComplexityMessage(
      {
        ruleId: 'complexity',
        message: 'Arrow function has a complexity of 5. Maximum allowed is 0.',
        line: 10,
        column: 14
      },
      'src/utils.ts'
    )
    assert.deepEqual(result, {
      file: 'src/utils.ts',
      function: 'anonymous',
      line: 10,
      column: 14,
      complexity: 5
    })
  })

  test('extracts method with complexity score', () => {
    const result = parseComplexityMessage(
      {
        ruleId: 'complexity',
        message: "Method 'render' has a complexity of 8. Maximum allowed is 0.",
        line: 55,
        column: 3
      },
      'src/component.tsx'
    )
    assert.deepEqual(result, {
      file: 'src/component.tsx',
      function: 'render',
      line: 55,
      column: 3,
      complexity: 8
    })
  })

  test('ignores non-complexity rules', () => {
    const result = parseComplexityMessage(
      {
        ruleId: '@typescript-eslint/no-unused-vars',
        message: "'foo' is defined but never used.",
        line: 10,
        column: 7
      },
      'src/app.ts'
    )
    assert.equal(result, null)
  })

  test('ignores null ruleId', () => {
    const result = parseComplexityMessage(
      {
        ruleId: null,
        message: 'Some random error',
        line: 1,
        column: 1
      },
      'src/app.ts'
    )
    assert.equal(result, null)
  })

  test('ignores complexity rule with non-matching message format', () => {
    const result = parseComplexityMessage(
      {
        ruleId: 'complexity',
        message: 'Some unrecognized complexity message without the expected pattern.',
        line: 1,
        column: 1
      },
      'src/app.ts'
    )
    assert.equal(result, null)
  })

  test('handles high complexity values', () => {
    const result = parseComplexityMessage(
      {
        ruleId: 'complexity',
        message: "Function 'processData' has a complexity of 47. Maximum allowed is 0.",
        line: 100,
        column: 1
      },
      'src/processor.ts'
    )
    assert.ok(result)
    assert.equal(result.complexity, 47)
    assert.equal(result.function, 'processData')
  })

  test('handles complexity of 1 (minimum)', () => {
    const result = parseComplexityMessage(
      {
        ruleId: 'complexity',
        message: "Function 'simple' has a complexity of 1. Maximum allowed is 0.",
        line: 5,
        column: 1
      },
      'src/simple.ts'
    )
    assert.ok(result)
    assert.equal(result.complexity, 1)
  })
})

describe('SUPPORTED_EXTENSIONS', () => {
  test('includes all JS/TS extensions', () => {
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']) {
      assert.ok(SUPPORTED_EXTENSIONS.has(ext), `Expected ${ext} to be supported`)
    }
  })

  test('JS/TS extensions still route to the ESLint engine', () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      assert.equal(complexityEngineFor(`src/app${ext}`), 'eslint')
    }
  })

  test('C#, Java and Python are supported now — by tree-sitter, not ESLint', () => {
    for (const ext of ['.cs', '.java', '.py']) {
      assert.ok(!SUPPORTED_EXTENSIONS.has(ext), `${ext} must NOT go through ESLint`)
      assert.equal(complexityEngineFor(`src/main${ext}`), 'tree-sitter')
      assert.ok(ALL_SUPPORTED_EXTENSIONS.includes(ext), `${ext} must be advertised as supported`)
    }
  })

  test('rejects languages neither engine handles', () => {
    for (const ext of ['.rs', '.go', '.rb', '.c', '.cpp']) {
      assert.equal(complexityEngineFor(`src/main${ext}`), null, `Expected ${ext} to be unsupported`)
      assert.ok(!ALL_SUPPORTED_EXTENSIONS.includes(ext))
    }
  })

  test('unsupported file produces clear error message', () => {
    // Mirrors the extension check in handleAnalyzeComplexity
    const filePath = 'src/main.rs'
    const ext = '.' + filePath.split('.').pop()!.toLowerCase()
    assert.equal(complexityEngineFor(filePath), null)

    const message = `[analyze_complexity] Language not supported: ${ext}\nCurrently supports: ${ALL_SUPPORTED_EXTENSIONS.join(', ')}`
    assert.ok(message.includes('.rs'))
    assert.ok(message.includes('Currently supports:'))
    assert.ok(message.includes('.ts'))
    assert.ok(message.includes('.cs'), 'the message must advertise the new languages')
  })
})

// ── Standalone summary ──

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('analyze-complexity.test.ts')

if (isDirectRun) {
  void summaryAsync()
}
