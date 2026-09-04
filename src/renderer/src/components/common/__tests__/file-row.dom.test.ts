/**
 * FileRow + FileListSection — component-level coverage (jsdom harness).
 *
 * Covers the audit's file-list unification claims:
 *  - FileRow full variant: truncated path, status chip labels/colors,
 *    `+N −M` counts when passed, hidden when both omitted
 *  - FileRow compact variant: static span without onClick, button with
 *  - onClick absent → span (no dead button); disabled → button[disabled]
 *    + opacity class; selected → bg-surface-overlay
 *  - FileListSection: `label (count)` header, rows call
 *    fileViewerStore.openFile(path, ctx), selection follows the global
 *    viewer activeFile, collapsible toggle hides/shows rows,
 *    status 'D' rows disabled, duplicate paths deduped (last wins)
 *
 * The real file-viewer store pulls a Vite-only workspace graph — it is stubbed
 * with a zustand-shaped fake (selector hook + subscription); the components
 * under test run their real logic.
 *
 * Run: tsx src/renderer/src/components/common/__tests__/file-row.dom.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../../main/services/__tests__/test-harness'
import {
  render,
  act,
  restoreResolver,
  stubModule,
  teardownGlobals
} from '../../streaming/__tests__/component-harness'

const React = require('react') as typeof import('react')

// ── Fake file-viewer store (zustand-shaped) ─────────────────────────────────

function makeFakeViewerStore(initial: Record<string, unknown>) {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    state: () => state,
    setState: (patch: Record<string, unknown>): void => {
      state = { ...state, ...patch }
      listeners.forEach((l) => l())
    },
    useStore: (sel?: (s: Record<string, unknown>) => unknown): unknown => {
      const [, force] = React.useReducer((x: number): number => x + 1, 0)
      React.useEffect(() => {
        listeners.add(force)
        return () => {
          listeners.delete(force)
        }
      }, [force])
      return sel ? sel(state) : state
    }
  }
}

const viewer = makeFakeViewerStore({
  activeFile: null,
  openFileCalls: [] as Array<{ path: string; ctx: Record<string, unknown> }>,
  openFile: (path: string, ctx: Record<string, unknown>): Promise<void> => {
    viewer.setState({
      activeFile: path,
      openFileCalls: [...(viewer.state().openFileCalls as any[]), { path, ctx }]
    })
    return Promise.resolve()
  }
})

stubModule('@renderer/store/file-viewer.store', {
  useFileViewerStore: viewer.useStore
})

const FileRow = require('../FileRow').default as React.ComponentType<Record<string, unknown>>
const { FileListSection } = require('../FileListSection') as {
  FileListSection: React.ComponentType<Record<string, unknown>>
}

/** Rows currently in the document. */
function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[data-testid="file-row"]')) as HTMLElement[]
}

/** Token-precise class check — `hover:bg-surface-overlay/50` must not count. */
const hasClass = (el: Element, token: string): boolean => el.className.split(/\s+/).includes(token)

const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
}

// ── FileRow — full variant ───────────────────────────────────────────────────

describe('FileRow — full variant', () => {
  test('renders the path with mono/truncate classes', () => {
    const h = render(React.createElement(FileRow, { path: 'src/main/index.ts' }))
    const row = rows()[0]
    assert.ok(row, 'row rendered')
    assert.match(row.textContent ?? '', /src\/main\/index\.ts/)
    const pathSpan = row.querySelector('span.font-mono')
    assert.ok(pathSpan, 'path uses the mono/truncate span')
    assert.match(pathSpan.className, /truncate/)
    h.unmount()
  })

  test('status chips: Modified/Added/Deleted with their color classes', () => {
    const h = render(
      React.createElement('div', null, [
        React.createElement(FileRow, { key: 'm', path: 'a.ts', status: 'M' }),
        React.createElement(FileRow, { key: 'a', path: 'b.ts', status: 'A' }),
        React.createElement(FileRow, { key: 'd', path: 'c.ts', status: 'D' })
      ])
    )
    const [m, a, d] = rows()
    assert.match(m.textContent ?? '', /Modified/)
    assert.match(m.querySelector('span.text-amber-400')?.textContent ?? '', /Modified/)
    assert.match(a.querySelector('span.text-emerald-400')?.textContent ?? '', /Added/)
    assert.match(d.querySelector('span.text-danger')?.textContent ?? '', /Deleted/)
    h.unmount()
  })

  test('`+N −M` shown when counts passed, hidden when both omitted', () => {
    const h = render(
      React.createElement('div', null, [
        React.createElement(FileRow, { key: 'c', path: 'a.ts', additions: 12, deletions: 3 }),
        React.createElement(FileRow, { key: 'n', path: 'b.ts' })
      ])
    )
    const [withCounts, without] = rows()
    assert.match(withCounts.textContent ?? '', /\+12/)
    assert.match(withCounts.textContent ?? '', /−3/) // U+2212 minus
    assert.doesNotMatch(without.textContent ?? '', /\+/)
    assert.doesNotMatch(without.textContent ?? '', /−/)
    h.unmount()
  })

  test('no onClick → static span, never a dead button', () => {
    const h = render(React.createElement(FileRow, { path: 'a.ts' }))
    const row = rows()[0]
    assert.equal(row.tagName, 'SPAN', 'static row is a span')
    h.unmount()
  })

  test('onClick present → button; disabled → button[disabled] + opacity class', () => {
    const h = render(
      React.createElement('div', null, [
        React.createElement(FileRow, { key: 'ok', path: 'a.ts', onClick: () => {} }),
        React.createElement(FileRow, {
          key: 'no',
          path: 'b.ts',
          onClick: () => {},
          disabled: true
        })
      ])
    )
    const [enabled, disabled] = rows()
    assert.equal(enabled.tagName, 'BUTTON', 'clickable row is a button')
    assert.equal(disabled.tagName, 'BUTTON', 'disabled row stays a button (disabled attr)')
    assert.equal((disabled as HTMLButtonElement).disabled, true)
    assert.match(disabled.className, /opacity-50/)
    h.unmount()
  })

  test('selected → bg-surface-overlay', () => {
    const h = render(React.createElement(FileRow, { path: 'a.ts', selected: true }))
    assert.match(rows()[0].className, /bg-surface-overlay/)
    h.unmount()
  })
})

// ── FileRow — compact variant ────────────────────────────────────────────────

describe('FileRow — compact variant', () => {
  test('no onClick → static span chip with mono text', () => {
    const h = render(React.createElement(FileRow, { path: 'src/a.tsx', compact: true }))
    const chip = rows()[0]
    assert.equal(chip.tagName, 'SPAN', 'static compact chip is a span')
    assert.match(chip.className, /font-mono/)
    assert.match(chip.textContent ?? '', /src\/a\.tsx/)
    h.unmount()
  })

  test('onClick present → button', () => {
    const h = render(
      React.createElement(FileRow, { path: 'src/a.tsx', compact: true, onClick: () => {} })
    )
    assert.equal(rows()[0].tagName, 'BUTTON')
    h.unmount()
  })
})

// ── FileListSection ──────────────────────────────────────────────────────────

describe('FileListSection', () => {
  test('renders label with (count) and one row per file', () => {
    const h = render(
      React.createElement(FileListSection, {
        label: 'Files Modified',
        files: ['a.ts', 'b.ts', 'c.css']
      })
    )
    assert.match(document.body.textContent ?? '', /Files Modified \(3\)/)
    assert.equal(rows().length, 3)
    h.unmount()
  })

  test('rows are clickable → calls openFile(path, ctx)', () => {
    const h = render(
      React.createElement(FileListSection, {
        label: 'Files Created',
        files: ['src/new.ts'],
        ctx: { blueprintId: 'bp-1' }
      })
    )
    const row = rows()[0]
    assert.equal(row.tagName, 'BUTTON')
    click(row)
    const calls = viewer.state().openFileCalls as Array<{
      path: string
      ctx: Record<string, unknown>
    }>
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, 'src/new.ts')
    assert.deepEqual(calls[0].ctx, { blueprintId: 'bp-1' })
    viewer.setState({ openFileCalls: [] })
    h.unmount()
  })

  test('selected row follows the global viewer activeFile', () => {
    act(() => {
      viewer.setState({ activeFile: 'b.ts' })
    })
    const h = render(
      React.createElement(FileListSection, {
        label: 'Files',
        files: ['a.ts', 'b.ts']
      })
    )
    const [a, b] = rows()
    assert.ok(!hasClass(a, 'bg-surface-overlay'))
    assert.ok(hasClass(b, 'bg-surface-overlay'), 'viewer-active row highlighted')
    act(() => {
      viewer.setState({ activeFile: null, openFileCalls: [] })
    })
    h.unmount()
  })

  test('collapsible renders a toggle and hides rows when closed', () => {
    const h = render(
      React.createElement(FileListSection, {
        label: 'Files Modified',
        files: ['a.ts'],
        collapsible: true
      })
    )
    const toggle = document.querySelector('[data-testid="file-list-toggle"]') as HTMLElement
    assert.ok(toggle, 'toggle rendered')
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'starts collapsed')
    assert.equal(rows().length, 0, 'rows hidden while collapsed')
    click(toggle)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(rows().length, 1, 'rows visible after toggle')
    h.unmount()
  })

  test("status 'D' row renders disabled", () => {
    const h = render(
      React.createElement(FileListSection, {
        label: 'Files',
        files: [{ path: 'gone.ts', status: 'D' }]
      })
    )
    const row = rows()[0] as HTMLButtonElement
    assert.equal(row.disabled, true)
    assert.ok(hasClass(row, 'opacity-50'))
    h.unmount()
  })

  test('dedupes repeated paths — last entry wins, first-appearance order kept', () => {
    const h = render(
      React.createElement(FileListSection, {
        label: 'Files',
        files: [
          { path: 'a.ts', additions: 1 },
          { path: 'b.ts', additions: 2 },
          { path: 'a.ts', additions: 9 }
        ]
      })
    )
    const rs = rows()
    assert.equal(rs.length, 2, 'duplicate a.ts collapsed')
    assert.equal(
      document.querySelectorAll('[data-testid="file-list-section"] h3')[0].textContent,
      'Files (2)'
    )
    assert.match(rs[0].textContent ?? '', /a\.ts/)
    assert.match(rs[0].textContent ?? '', /\+9/, 'last duplicate entry won')
    assert.match(rs[1].textContent ?? '', /b\.ts/)
    h.unmount()
  })
})

restoreResolver()
teardownGlobals()
// Only exit when run standalone — in the shared runner the harness's own
// summaryAsync() owns the totals (an unconditional call would exit mid-suite
// and silently truncate every later file).
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
