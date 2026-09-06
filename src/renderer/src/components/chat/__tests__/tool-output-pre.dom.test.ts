/**
 * ToolOutputPre — component-level coverage (jsdom harness).
 *
 * Primary claim under test (regression guard): the highlighted branch renders
 * one <span> per line, and a <pre> only preserves newlines that are present in
 * its text content. Before the fix no separator was emitted between those
 * spans, so every file-typed tool output collapsed onto a single wrapped line.
 * `pre.textContent` must therefore still contain the original '\n's.
 *
 * Also covers: the plain branch is byte-identical to its input, Read gutters
 * render in a muted span outside the tokenized content, and blank lines survive.
 *
 * `@renderer/store` (heavy zustand graph) and `use-prism-grammar` (dynamic
 * prismjs chunk imports) are stubbed — ToolOutputPre's own line logic and the
 * real prism-react-renderer <Highlight> still run.
 *
 * Run: tsx src/renderer/src/components/chat/__tests__/tool-output-pre.dom.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../../main/services/__tests__/test-harness'
import {
  render,
  restoreResolver,
  stubModule,
  teardownGlobals
} from '../../streaming/__tests__/component-harness'

const React = require('react') as typeof import('react')

// ── Stubs ───────────────────────────────────────────────────────────────────

stubModule('@renderer/store', { useAppTheme: () => 'code-atelier' })

/** Grammar readiness is flipped per-test; false → <Highlight> uses 'text'. */
let grammarReady = false
stubModule('@renderer/hooks/use-prism-grammar', { usePrismGrammar: () => grammarReady })

const ToolOutputPre = require('../ToolOutputPre').default as React.ComponentType<{
  text: string
  language?: string
  className?: string
}>

/**
 * The rendered <pre>, scoped to this render's own container. A document-wide
 * query would pick up a leaked <pre> from an earlier test whose assertion threw
 * before its unmount() ran, masking the real failure.
 */
function pre(h: { container: HTMLElement }): HTMLElement {
  const el = h.container.querySelector('pre')
  assert.ok(el, 'pre rendered')
  return el as HTMLElement
}

// ── Plain branch ────────────────────────────────────────────────────────────

describe('ToolOutputPre — plain branch', () => {
  test('no language → textContent is byte-identical to the input', () => {
    const text = 'line1\nline2\nline3'
    const h = render(React.createElement(ToolOutputPre, { text }))
    assert.equal(pre(h).textContent, text)
    h.unmount()
  })

  test("language 'text' is treated as plain", () => {
    const text = 'a\nb'
    const h = render(React.createElement(ToolOutputPre, { text, language: 'text' }))
    assert.equal(pre(h).textContent, text)
    h.unmount()
  })
})

// ── Highlight branch — the regression guard ─────────────────────────────────

describe('ToolOutputPre — highlighted branch preserves newlines', () => {
  test('multi-line text keeps its separators (3 lines, not 1)', () => {
    const text = 'const a = 1\nconst b = 2\nconst c = 3'
    const h = render(React.createElement(ToolOutputPre, { text, language: 'ts' }))
    const content = pre(h).textContent ?? ''
    assert.ok(content.includes('const a = 1\nconst b = 2'), 'newline survives between lines')
    assert.equal(content.split('\n').length, 3, 'three rendered lines, not one blob')
    h.unmount()
  })

  test('no trailing newline is appended after the last line', () => {
    const h = render(React.createElement(ToolOutputPre, { text: 'a\nb', language: 'ts' }))
    assert.ok(!(pre(h).textContent ?? '').endsWith('\n'))
    h.unmount()
  })

  test('blank lines survive as empty lines', () => {
    const text = 'a\n\nb'
    const h = render(React.createElement(ToolOutputPre, { text, language: 'ts' }))
    assert.equal((pre(h).textContent ?? '').split('\n').length, 3, 'blank line preserved')
    h.unmount()
  })

  test('holds when the grammar is ready and content is really tokenized', () => {
    grammarReady = true
    const h = render(React.createElement(ToolOutputPre, { text: 'a\nb\nc', language: 'ts' }))
    assert.equal((pre(h).textContent ?? '').split('\n').length, 3)
    grammarReady = false
    h.unmount()
  })
})

// ── Line prefixes ───────────────────────────────────────────────────────────

describe('ToolOutputPre — prefix decoration', () => {
  test('Read gutter renders in a muted span, outside the tokenized content', () => {
    const h = render(
      React.createElement(ToolOutputPre, { text: '  12→const x = 1', language: 'ts' })
    )
    const muted = pre(h).querySelector('span.text-text-muted')
    assert.ok(muted, 'gutter span rendered')
    assert.equal(muted.textContent, '  12→', 'gutter kept verbatim, separator re-attached')
    assert.match(pre(h).textContent ?? '', /const x = 1/)
    h.unmount()
  })

  test('gutter lines still emit their newline separator', () => {
    const h = render(React.createElement(ToolOutputPre, { text: '1→a\n2→b', language: 'ts' }))
    const content = pre(h).textContent ?? ''
    assert.equal(content.split('\n').length, 2, 'two gutter lines stay on two lines')
    assert.ok(content.includes('a\n2→b'))
    h.unmount()
  })

  test('grep locator renders as a muted path prefix', () => {
    const h = render(
      React.createElement(ToolOutputPre, { text: 'src/app.ts:12:const y = 2', language: 'ts' })
    )
    assert.equal(pre(h).querySelector('span.text-text-muted')?.textContent, 'src/app.ts:12:')
    h.unmount()
  })
})

restoreResolver()
teardownGlobals()
// Only exit when run standalone — in the shared runner the harness's own
// summaryAsync() owns the totals.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
