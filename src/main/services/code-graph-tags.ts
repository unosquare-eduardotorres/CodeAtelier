/**
 * Subtype-preserving Tree-sitter tag extraction.
 *
 * `repomap-mcp`'s `getTags()` collapses every capture to `def` | `ref` and
 * throws the subtype away (`dist/tags.js`: `captureName.startsWith("name.definition")`).
 * The `.scm` queries actually carry much richer information —
 * `@name.definition.method`, `@name.reference.call`, `@name.definition.interface` …
 * — which is exactly what we need to emit typed edges instead of one
 * undifferentiated `references` blob.
 *
 * This module mirrors repomap-mcp's loading logic (same queries, same WASM
 * grammars, same dedup) but keeps the capture tail. Everything is best-effort:
 * on ANY infrastructure failure it returns `null` so the caller can fall back
 * to `getTags()` — losing subtypes, not losing the index.
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import log from 'electron-log/main'
import type { RepomapTag } from '../db/repositories/code-graph-tag.repository'

/** A tag that remembers which `.scm` capture produced it. */
export interface TypedTag extends RepomapTag {
  /**
   * Capture subtype parsed from the capture name tail:
   *   defs — 'function' | 'method' | 'class' | 'type' | 'interface' | 'enum' | 'module' | 'constant' | …
   *   refs — 'call' | 'type' | 'class' | …
   * `null` when the grammar's query has no subtype.
   */
  symbolKind: string | null
}

/**
 * Set to `false` (env `CODE_GRAPH_TYPED_TAGS=0`) to fall back to repomap-mcp's
 * untyped `getTags()` for a release, per the rollback plan.
 */
export const TYPED_TAGS_ENABLED = process.env.CODE_GRAPH_TYPED_TAGS !== '0'

/**
 * Parse a Tree-sitter capture name into (kind, symbolKind).
 * Pure — the unit-testable core of this module.
 *
 * 'name.definition.method'  → { kind: 'def', symbolKind: 'method' }
 * 'name.reference.call'     → { kind: 'ref', symbolKind: 'call' }
 * 'name.definition'         → { kind: 'def', symbolKind: null }
 * 'definition.function'     → null  (repomap only accepts `name.`-prefixed captures)
 */
export function parseCaptureName(
  captureName: string
): { kind: 'def' | 'ref'; symbolKind: string | null } | null {
  const parts = captureName.split('.')
  if (parts[0] !== 'name') return null
  const kindWord = parts[1]
  const kind = kindWord === 'definition' ? 'def' : kindWord === 'reference' ? 'ref' : null
  if (!kind) return null
  const tail = parts.slice(2).join('.')
  return { kind, symbolKind: tail.length > 0 ? tail : null }
}

// ── Query / grammar resolution (mirrors repomap-mcp) ────────────────────────

const QUERY_NAME_ALIASES: Record<string, string[]> = {
  c_sharp: ['csharp', 'c_sharp'],
  tsx: ['typescript']
}

let queriesDirCache: string | null | undefined

/**
 * Locate the `.scm` query pack.
 *
 * Two layouts, checked in the order they occur in production:
 *  1. Bundled app — Vite copies `repomap-mcp/queries` to `out/queries`, and the
 *     bundled code lives in `out/main` or `out/mcp-servers`, so `../queries`
 *     resolves. This is the same path repomap-mcp's own bundled code uses.
 *  2. Source/tests — resolve through `repomap-mcp/package.json` in node_modules.
 */
function resolveQueriesDir(): string | null {
  if (queriesDirCache !== undefined) return queriesDirCache

  const candidates: string[] = []
  try {
    candidates.push(path.resolve(__dirname, '..', 'queries'))
  } catch {
    /* __dirname unavailable — skip */
  }
  try {
    candidates.push(path.join(path.dirname(require.resolve('repomap-mcp/package.json')), 'queries'))
  } catch {
    /* not resolvable from here — skip */
  }

  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'tree-sitter-language-pack'))) {
      queriesDirCache = dir
      return dir
    }
  }
  queriesDirCache = null
  return null
}

function getQueryPath(lang: string): string | null {
  const queriesDir = resolveQueriesDir()
  if (!queriesDir) return null
  const names = QUERY_NAME_ALIASES[lang] ?? [lang]
  for (const subdir of ['tree-sitter-language-pack', 'tree-sitter-languages']) {
    for (const name of names) {
      const p = path.join(queriesDir, subdir, `${name}-tags.scm`)
      if (existsSync(p)) return p
    }
  }
  return null
}

function getWasmPath(lang: string): string {
  const wasmsDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'))
  return path.join(wasmsDir, 'out', `tree-sitter-${lang}.wasm`)
}

// ── Parser lifecycle ────────────────────────────────────────────────────────

type WebTreeSitter = typeof import('web-tree-sitter')
type TsLanguage = InstanceType<WebTreeSitter['Language']>
type TsQuery = InstanceType<WebTreeSitter['Query']>

let treeSitterModule: WebTreeSitter | null = null
const languageCache = new Map<string, TsLanguage>()
const queryCache = new Map<string, TsQuery | null>()

/** Reset cached grammars/queries — called after indexing releases the parser. */
export function releaseTypedParser(): void {
  languageCache.clear()
  queryCache.clear()
  treeSitterModule = null
}

async function getTreeSitter(): Promise<WebTreeSitter> {
  if (!treeSitterModule) {
    // repomap-mcp's initParser() owns Parser.init() and is idempotent; reusing it
    // avoids creating a second Emscripten instance.
    const { initParser } = await import('repomap-mcp/dist/tags.js')
    await initParser()
    treeSitterModule = await import('web-tree-sitter')
  }
  return treeSitterModule
}

async function loadLanguage(lang: string): Promise<TsLanguage> {
  const cached = languageCache.get(lang)
  if (cached) return cached
  const { Language } = await getTreeSitter()
  const language = await Language.load(getWasmPath(lang))
  languageCache.set(lang, language)
  return language
}

async function loadQuery(language: TsLanguage, lang: string): Promise<TsQuery | null> {
  const cached = queryCache.get(lang)
  if (cached !== undefined) return cached
  const queryPath = getQueryPath(lang)
  if (!queryPath) {
    queryCache.set(lang, null)
    return null
  }
  const { Query } = await getTreeSitter()
  try {
    const query = new Query(language, readFileSync(queryPath, 'utf-8'))
    queryCache.set(lang, query)
    return query
  } catch {
    queryCache.set(lang, null)
    return null
  }
}

// ── Extraction ──────────────────────────────────────────────────────────────

let unavailableLogged = false

/**
 * Extract typed tags for a single file.
 *
 * Returns `null` when typed extraction cannot run for this file (unsupported
 * language, missing grammar/query, parser failure) — the caller should fall
 * back to `getTags()`. Returns `[]` only when the file genuinely has no tags.
 */
export async function extractTypedTags(
  fname: string,
  relFname: string,
  filenameToLang: (f: string) => string | null
): Promise<TypedTag[] | null> {
  if (!TYPED_TAGS_ENABLED) return null

  const lang = filenameToLang(fname)
  if (!lang) return null

  let language: TsLanguage
  let query: TsQuery | null
  try {
    language = await loadLanguage(lang)
    query = await loadQuery(language, lang)
  } catch (error) {
    if (!unavailableLogged) {
      unavailableLogged = true
      log.warn(
        `[CodeGraph] Typed tag extraction unavailable (lang=${lang}): ` +
          `${(error as Error).message} — falling back to untyped tags`
      )
    }
    return null
  }
  if (!query) return null

  let code: string
  try {
    code = readFileSync(fname, 'utf-8')
  } catch {
    return null
  }

  const { Parser } = await getTreeSitter()
  const parser = new Parser()
  const tags: TypedTag[] = []
  let tree: ReturnType<InstanceType<WebTreeSitter['Parser']>['parse']> = null
  try {
    parser.setLanguage(language)
    tree = parser.parse(code)
    if (!tree) return null

    for (const capture of query.captures(tree.rootNode)) {
      const parsed = parseCaptureName(capture.name)
      if (!parsed) continue
      tags.push({
        relFname,
        fname,
        line: capture.node.startPosition.row + 1,
        name: capture.node.text,
        kind: parsed.kind,
        symbolKind: parsed.symbolKind
      })
    }
  } catch (error) {
    if (!unavailableLogged) {
      unavailableLogged = true
      log.warn(
        `[CodeGraph] Typed parse failed for ${relFname}: ${(error as Error).message} — ` +
          `falling back to untyped tags`
      )
    }
    return null
  } finally {
    try {
      tree?.delete()
    } catch {
      /* best-effort */
    }
    try {
      parser.delete()
    } catch {
      /* best-effort */
    }
  }

  return dedupeTags(tags)
}

/**
 * Drop duplicate captures — same file/line/name/kind. Mirrors repomap-mcp's
 * dedup key so tag counts stay comparable; `symbolKind` is deliberately NOT
 * part of the key (first capture wins) to preserve the UNIQUE constraint on
 * `code_graph_tags(workspace_id, rel_fname, line, name, kind)`.
 */
export function dedupeTags(tags: TypedTag[]): TypedTag[] {
  const seen = new Set<string>()
  return tags.filter((tag) => {
    const key = `${tag.relFname}:${tag.line}:${tag.name}:${tag.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
