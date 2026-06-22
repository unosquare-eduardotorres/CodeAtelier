/**
 * Unit tests for ipc/tool-result-summarizer.ts — registry-based tool result
 * summarization (short result + optional ~8K detail).
 *
 * Pure logic — no Electron deps — runs from the main-process harness.
 *
 * Coverage:
 *  - Global pre-checks: <persisted-output>, <tool_use_error> classification.
 *  - SDK builtins: Write/Edit, Bash (exit code + first-line), Read, Grep, Glob.
 *  - MCP prefix handlers: code-graph, code-analysis, git-context, semantic-search.
 *  - Detail truncation at DETAIL_CAP (8192).
 *  - Malformed JSON / empty content → fallback or undefined.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { extractResultSummary } from '../tool-result-summarizer'
import { MCP_TOOLS } from '../../../shared/constants'

describe('extractResultSummary — guards', () => {
  test('undefined content returns undefined', () => {
    assert.equal(extractResultSummary('Bash', undefined), undefined)
  })

  test('persisted-output marker short-circuits', () => {
    const out = extractResultSummary('Read', 'foo <persisted-output> bar')
    assert.equal(out?.result, 'Result too large to display')
    assert.ok(out?.resultDetail?.includes('persisted'))
  })

  test('tool_use_error — stale read classification', () => {
    const out = extractResultSummary(
      'Edit',
      '<tool_use_error>File has been modified since read</tool_use_error>'
    )
    assert.equal(out?.result, 'Stale read — re-read needed')
  })

  test('tool_use_error — string not found classification', () => {
    const out = extractResultSummary(
      'Edit',
      '<tool_use_error>String to replace not found in file</tool_use_error>'
    )
    assert.equal(out?.result, 'String not found — re-read needed')
  })

  test('tool_use_error — permission denied classification', () => {
    const out = extractResultSummary(
      'Bash',
      '<tool_use_error>EACCES: permission denied</tool_use_error>'
    )
    assert.equal(out?.result, 'Permission denied')
  })

  test('tool_use_error — generic one-line error', () => {
    const out = extractResultSummary('Bash', '<tool_use_error>something broke</tool_use_error>')
    assert.equal(out?.result, 'Error: something broke')
  })

  test('tool_use_error — long error truncated to 80 chars in result', () => {
    const long = 'x'.repeat(200)
    const out = extractResultSummary('Bash', `<tool_use_error>${long}</tool_use_error>`)
    assert.ok(out!.result.startsWith('Error: '))
    assert.ok(out!.result.endsWith('…'))
  })
})

describe('extractResultSummary — SDK builtins', () => {
  test('Write — short content returns Done with no detail', () => {
    const out = extractResultSummary('Write', 'ok')
    assert.equal(out?.result, 'Done')
    assert.equal(out?.resultDetail, undefined)
  })

  test('Write — long content returns Done with detail', () => {
    const out = extractResultSummary('Write', 'wrote a long file body here')
    assert.equal(out?.result, 'Done')
    assert.ok(out?.resultDetail)
  })

  test('Edit shares the Write handler', () => {
    const out = extractResultSummary('Edit', 'short')
    assert.equal(out?.result, 'Done')
  })

  test('Bash — success exit code', () => {
    const out = extractResultSummary('Bash', 'running...\nexit code: 0')
    assert.equal(out?.result, 'Success (exit 0)')
    assert.ok(out?.resultDetail)
  })

  test('Bash — failure exit code', () => {
    const out = extractResultSummary('Bash', 'boom\nexit code: 2')
    assert.equal(out?.result, 'Failed (exit 2)')
  })

  test('Bash — no output', () => {
    const out = extractResultSummary('Bash', '   \n  ')
    assert.equal(out?.result, 'No output')
  })

  test('Bash — first line summary without exit code', () => {
    const out = extractResultSummary('Bash', 'hello world')
    assert.equal(out?.result, 'hello world')
    assert.equal(out?.resultDetail, undefined)
  })

  test('Read — line count', () => {
    const out = extractResultSummary('Read', 'a\nb\nc')
    assert.equal(out?.result, '3 lines read')
  })

  test('Read — single line uses singular', () => {
    const out = extractResultSummary('Read', 'single')
    assert.equal(out?.result, '1 line read')
  })

  test('Grep — match count plural', () => {
    const out = extractResultSummary('Grep', 'file1:1: a\nfile2:2: b')
    assert.equal(out?.result, '2 matches')
  })

  test('Grep — single match singular', () => {
    const out = extractResultSummary('Grep', 'file1:1: a')
    assert.equal(out?.result, '1 match')
  })

  test('Glob — file count', () => {
    const out = extractResultSummary('Glob', 'a.ts\nb.ts\nc.ts')
    assert.equal(out?.result, '3 files found')
  })
})

describe('extractResultSummary — MCP prefix handlers', () => {
  const cg = MCP_TOOLS.CODE_GRAPH._PREFIX + 'FindSymbol'
  const ca = MCP_TOOLS.CODE_ANALYSIS._PREFIX + 'TodoScanner'
  const git = MCP_TOOLS.GIT_CONTEXT._PREFIX + 'GitLog'
  const sem = MCP_TOOLS.SEMANTIC_SEARCH._PREFIX + 'SemanticSearch'

  test('code-graph — symbols array count', () => {
    const out = extractResultSummary(cg, JSON.stringify({ symbols: [1, 2, 3] }))
    assert.equal(out?.result, '3 symbols')
  })

  test('code-graph — callers singular', () => {
    const out = extractResultSummary(cg, JSON.stringify({ callers: [1] }))
    assert.equal(out?.result, '1 caller')
  })

  test('code-graph — generic first-array fallback', () => {
    const out = extractResultSummary(cg, JSON.stringify({ widgets: [1, 2] }))
    assert.equal(out?.result, '2 widgets')
  })

  test('code-analysis — totalCount markers', () => {
    const out = extractResultSummary(ca, JSON.stringify({ totalCount: 5 }))
    assert.equal(out?.result, '5 markers found')
  })

  test('git-context — commit count', () => {
    const out = extractResultSummary(git, JSON.stringify({ commits: [1, 2] }))
    assert.equal(out?.result, '2 commits')
  })

  test('semantic-search — results count', () => {
    const out = extractResultSummary(sem, JSON.stringify({ results: [1] }))
    assert.equal(out?.result, '1 result')
  })

  test('malformed JSON falls through to default summary', () => {
    const out = extractResultSummary(cg, 'not json at all')
    assert.equal(out?.result, 'not json at all')
  })
})

describe('extractResultSummary — default + truncation', () => {
  test('unknown tool uses first-line default', () => {
    const out = extractResultSummary('SomeUnknownTool', 'first line\nsecond line')
    assert.equal(out?.result, 'first line')
    assert.ok(out?.resultDetail)
  })

  test('detail is capped at the 8K limit with truncation marker', () => {
    const big = 'a'.repeat(9000)
    const out = extractResultSummary('Write', big)
    assert.ok(out?.resultDetail!.includes('truncated'))
    assert.ok(out!.resultDetail!.length < big.length)
  })

  test('empty string returns undefined (falsy guard)', () => {
    assert.equal(extractResultSummary('Bash', ''), undefined)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
