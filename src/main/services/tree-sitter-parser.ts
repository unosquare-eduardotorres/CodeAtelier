/**
 * Shared web-tree-sitter lifecycle: one `Parser.init()`, one grammar cache.
 *
 * Extracted verbatim from code-graph-tags.ts so the complexity analyzer can
 * reuse the already-loaded WASM grammars instead of initialising a second
 * Emscripten module. `Parser.init()` must run on the *instance* we hand back —
 * in the packaged app a second dynamic import can resolve to a different module
 * copy whose Emscripten `Module` is still undefined, which is how typed tags
 * silently fell back for every language once before.
 */

import path from 'node:path'

type WebTreeSitter = typeof import('web-tree-sitter')
export type TsLanguage = InstanceType<WebTreeSitter['Language']>
export type TsParser = InstanceType<WebTreeSitter['Parser']>
export type TsNode = InstanceType<WebTreeSitter['Node']>

// Both caches hold PROMISES, not resolved values. Two concurrent callers that
// both miss a value cache would each run Language.load() on the same wasm; the
// second load replaces the first module instance, and every Language handle
// already handed out then reads back as version 0 (Incompatible language
// version 0). Caching the in-flight promise means one load per grammar, ever.
let treeSitterPromise: Promise<WebTreeSitter> | null = null
const languageCache = new Map<string, Promise<TsLanguage>>()

/**
 * Grammar loads are serialised through this chain.
 *
 * Measured, not defensive: two OVERLAPPING Language.load() calls corrupt
 * Emscripten's side-module load state, and the grammar that finishes first
 * afterwards reads back as version 0 — `Incompatible language version 0`
 * at setLanguage(), which callers can only see as a total parse failure.
 * Loads are one-time and rare, so a queue costs nothing.
 */
let loadChain: Promise<unknown> = Promise.resolve()

/** Absolute path of a shipped grammar, e.g. `tree-sitter-c_sharp.wasm`. */
export function getWasmPath(lang: string): string {
  const wasmsDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'))
  return path.join(wasmsDir, 'out', `tree-sitter-${lang}.wasm`)
}

/** Load (and memoise) the web-tree-sitter module, initialised exactly once. */
export function getTreeSitter(): Promise<WebTreeSitter> {
  treeSitterPromise ??= (async () => {
    // web-tree-sitter memoises its own binding, so re-initialising the same
    // instance is a no-op rather than a second Emscripten module.
    const mod = await import('web-tree-sitter')
    await mod.Parser.init()
    return mod
  })()
  return treeSitterPromise
}

/** Load (and memoise) a grammar by its wasm language id (e.g. `c_sharp`). */
export function loadLanguage(lang: string): Promise<TsLanguage> {
  let pending = languageCache.get(lang)
  if (!pending) {
    pending = loadChain.then(async () => {
      const { Language } = await getTreeSitter()
      return Language.load(getWasmPath(lang))
    })
    loadChain = pending.catch(() => undefined)
    // A failed load must not stay cached, or one transient error poisons the
    // grammar for the rest of the process.
    pending.catch(() => languageCache.delete(lang))
    languageCache.set(lang, pending)
  }
  return pending
}

/** Drop cached grammars and the module handle — callers re-acquire lazily. */
export function releaseParserRuntime(): void {
  languageCache.clear()
  treeSitterPromise = null
}
