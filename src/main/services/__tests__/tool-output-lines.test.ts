/**
 * Unit tests for the pure tool-output line parser (chat tool-activity
 * highlighting). Pins the prefix formats produced by the agents' Read/grep
 * tool results so the expand panel splits gutter/locator from content
 * correctly. Pure string logic — no DOM, no React — runs from the
 * main-process harness.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { parseToolOutputLine } from '../../../renderer/src/utils/tool-output-lines'

describe('parseToolOutputLine (Claude Read gutters)', () => {
  test('splits_gutter_from_content', () => {
    assert.deepEqual(parseToolOutputLine('  42→const x = 1'), {
      gutter: '  42',
      content: 'const x = 1'
    })
  })

  test('no_indent_gutter', () => {
    assert.deepEqual(parseToolOutputLine('7→export default App'), {
      gutter: '7',
      content: 'export default App'
    })
  })

  test('empty_content_after_gutter', () => {
    assert.deepEqual(parseToolOutputLine('  3→'), { gutter: '  3', content: '' })
  })

  test('content_containing_arrow_is_preserved', () => {
    assert.deepEqual(parseToolOutputLine('  5→const f = (a) → b'), {
      gutter: '  5',
      content: 'const f = (a) → b'
    })
  })
})

describe('parseToolOutputLine (grep locators)', () => {
  test('splits_path_locator_from_content', () => {
    assert.deepEqual(parseToolOutputLine('src/app.ts:12:const x = 1'), {
      path: 'src/app.ts:12',
      content: 'const x = 1'
    })
  })

  test('windows_style_path', () => {
    assert.deepEqual(parseToolOutputLine('src\\app.ts:12:const x = 1'), {
      path: 'src\\app.ts:12',
      content: 'const x = 1'
    })
  })

  test('colons_inside_content_are_kept', () => {
    assert.deepEqual(parseToolOutputLine('a.ts:1:x: y: z'), {
      path: 'a.ts:1',
      content: 'x: y: z'
    })
  })

  test('bare_path_without_line_number_is_content', () => {
    // `foo.ts:` has no digits after the colon — not a locator.
    assert.deepEqual(parseToolOutputLine('foo.ts:'), { content: 'foo.ts:' })
  })

  test('leading_whitespace_prevents_grep_match', () => {
    // Indented grep output (context lines) is content, not a locator.
    assert.deepEqual(parseToolOutputLine('  src/app.ts:12:const x = 1'), {
      content: '  src/app.ts:12:const x = 1'
    })
  })
})

describe('parseToolOutputLine (plain lines)', () => {
  test('ordinary_code_line_has_no_prefix', () => {
    assert.deepEqual(parseToolOutputLine('const x = 1'), { content: 'const x = 1' })
  })

  test('empty_line', () => {
    assert.deepEqual(parseToolOutputLine(''), { content: '' })
  })

  test('whitespace_only_line', () => {
    assert.deepEqual(parseToolOutputLine('   '), { content: '   ' })
  })

  test('bare_number_is_content_not_gutter', () => {
    // No arrow separator — a lone number is just content.
    assert.deepEqual(parseToolOutputLine('42'), { content: '42' })
  })

  test('arrow_without_number_is_content', () => {
    assert.deepEqual(parseToolOutputLine('→ done'), { content: '→ done' })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
