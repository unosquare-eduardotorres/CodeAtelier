/**
 * Component-test harness — jsdom DOM + React 19 rendering under tsx/CJS.
 *
 * Renderer tests in this repo are pure-logic (node:test-style via
 * test-harness, no DOM). This harness adds the missing DOM layer so
 * component-level claims (segment bubble rendering, transform application,
 * suppressLiveBubble) can be covered without a browser or Playwright.
 *
 * jsdom ^29 is already a production dependency (used by memory-bootstrap doc
 * reading) — no new deps.
 *
 * Constraints handled here:
 *  - tsx runs CJS; jsdom is required (not imported) and its globals are
 *    installed onto globalThis BEFORE requiring any component that reads
 *    `document`/`window` at module scope.
 *  - `@renderer/*` alias imports are mapped via a temporary _resolveFilename
 *    patch (same pattern as safety-timeout-orphan.test.ts).
 *  - React 19 `act()` requires IS_REACT_ACT_ENVIRONMENT = true.
 *  - CSS imports would crash under CJS — components under test must not
 *    import styles (StreamingTranscript doesn't).
 *
 * Usage:
 *   const { render, cleanup, screen } = require('./component-harness')
 *   const { unmount } = render(<StreamingTranscript ... />)
 *   ... assert on screen() ...
 *   cleanup()
 */

import { JSDOM } from 'jsdom'
import Module from 'node:module'
import path from 'node:path'

// ── jsdom globals ───────────────────────────────────────────────────────────

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
})

/**
 * Install the jsdom globals onto globalThis. MUST be undone via
 * `teardownGlobals()` at the end of the test file: renderer modules guard
 * side effects with `typeof window !== 'undefined'`, so a leaked window
 * flips later test files in the shared runner onto their browser path
 * (observed: 122 failures across chat-stream files after this harness ran).
 */
function installGlobals(): void {
  ;(globalThis as any).window = dom.window
  ;(globalThis as any).document = dom.window.document
  ;(globalThis as any).navigator = dom.window.navigator
  ;(globalThis as any).HTMLElement = dom.window.HTMLElement
  ;(globalThis as any).Element = dom.window.Element
  ;(globalThis as any).Node = dom.window.Node
  ;(globalThis as any).getComputedStyle = dom.window.getComputedStyle
  ;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback): number =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number
  ;(globalThis as any).cancelAnimationFrame = (id: number): void => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
  }
  // React 19 act() environment flag — must be set before react-dom is required.
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
}

/** Remove the jsdom globals installed by installGlobals(). */
export function teardownGlobals(): void {
  for (const key of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT'
  ]) {
    delete (globalThis as any)[key]
  }
}

installGlobals()

// ── @renderer alias mapping ─────────────────────────────────────────────────

const RENDERER_SRC = path.resolve(__dirname, '../../../')
const origResolve = (Module as any)._resolveFilename
;(Module as any)._resolveFilename = function (request: string, ...rest: any[]): any {
  const mapped = request.startsWith('@renderer/')
    ? path.join(RENDERER_SRC, request.slice('@renderer/'.length))
    : request
  return origResolve.call(this, mapped, ...rest)
}

// ── Module stubbing ─────────────────────────────────────────────────────────

/**
 * Stub a module for the duration of the harness. `match` is matched against
 * the request string (e.g. '@renderer/components/chat'). Use for modules whose
 * real implementation pulls Vite-only globals (import.meta.env) or heavy store
 * graphs that cannot load under tsx/CJS — the component under test's OWN logic
 * still runs for real.
 */
const moduleStubs = new Map<string, any>()
const origLoad = (Module as any)._load
;(Module as any)._load = function (request: string, parent: any, isMain: boolean): any {
  for (const [match, stub] of moduleStubs) {
    if (request === match || request.endsWith(match)) return stub
  }
  return origLoad.call(this, request, parent, isMain)
}

export function stubModule(match: string, exports: any): void {
  // __esModule marker: esbuild's __toESM interop treats a CJS module without
  // it as "the whole exports object IS the default export", so
  // `import X from 'stub'` would hand the component an object, not `exports.default`.
  if (exports && typeof exports === 'object' && !exports.__esModule) {
    exports.__esModule = true
  }
  moduleStubs.set(match, exports)
}

// ── React plumbing (required AFTER globals exist) ───────────────────────────

// React 19: act() exists only in the development build — NODE_ENV must be
// 'development' BEFORE react is first required (the production build throws
// "React.act is not a function").
if (!process.env.NODE_ENV || process.env.NODE_ENV === 'production') {
  process.env.NODE_ENV = 'development'
}

const React = require('react') as typeof import('react')
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client')
const { act } = require('react') as typeof import('react')

// tsx compiles .tsx with the classic JSX runtime under CJS — components that
// use JSX without importing React need the global pragma.
;(globalThis as any).React = React

export { act }

// ── Public API ──────────────────────────────────────────────────────────────

export interface RenderHandle {
  /** Unmount the tree and clear the root container. */
  unmount: () => void
  /** The root container element. */
  container: HTMLElement
  /** Re-render with new props (same root). */
  rerender: (node: React.ReactNode) => void
}

/**
 * Render a React node into the shared #root container inside act().
 * Call `handle.unmount()` (or `cleanup()`) when done — the harness does NOT
 * auto-cleanup between tests.
 */
export function render(node: React.ReactNode): RenderHandle {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(node)
  })
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
    rerender: (next: React.ReactNode) => {
      act(() => {
        root.render(next)
      })
    }
  }
}

/** The shared jsdom document (typed for assertions). */
export const screen = document as Document

/** Query helpers over the container's text content. */
export function textOf(el: Element | null): string {
  return el?.textContent ?? ''
}

/** All elements matching a [data-testid] value. */
export function byTestId(id: string): Element[] {
  return Array.from(document.querySelectorAll(`[data-testid="${id}"]`))
}

/**
 * Restore the resolver patch. Call this at the very end of a test file so a
 * later file's requires are not affected (mirrors safety-timeout-orphan).
 */
export function restoreResolver(): void {
  ;(Module as any)._resolveFilename = origResolve
  ;(Module as any)._load = origLoad
  moduleStubs.clear()
}
