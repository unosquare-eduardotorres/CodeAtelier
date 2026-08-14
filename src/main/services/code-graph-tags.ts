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
import {
  getTreeSitter,
  loadLanguage,
  releaseParserRuntime,
  type TsLanguage
} from './tree-sitter-parser'
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

// ── Parser lifecycle ────────────────────────────────────────────────────────
//
// Grammar loading and `Parser.init()` live in ./tree-sitter-parser so indexing
// and complexity analysis share ONE Emscripten module and one grammar cache.

type WebTreeSitter = typeof import('web-tree-sitter')
type TsQuery = InstanceType<WebTreeSitter['Query']>

const queryCache = new Map<string, TsQuery | null>()

/**
 * What happened when a language's `.scm` was compiled.
 *
 * A query that compiles to nothing is indistinguishable from a file with no
 * symbols, which is how seven languages stayed silently dead. Recording the
 * outcome per language is what makes that visible.
 */
export interface QueryDiagnostic {
  lang: string
  /** Top-level patterns found in the `.scm`. */
  totalPatterns: number
  /** Patterns that failed to compile against the shipped grammar. */
  droppedPatterns: number
  /** Compile error from the whole-file attempt — why the split was needed. */
  error: string
}

/** Languages whose query pack did not fully compile, keyed by language. */
const queryDiagnostics = new Map<string, QueryDiagnostic>()

/** One-shot guard so a runtime-wide WASM failure logs once, not once per file. */
let unavailableLogged = false

/** Degraded/dead query packs seen since the last parser release. */
export function getQueryDiagnostics(): QueryDiagnostic[] {
  return [...queryDiagnostics.values()]
}

/** Reset cached grammars/queries — called after indexing releases the parser. */
export function releaseTypedParser(): void {
  queryCache.clear()
  queryDiagnostics.clear()
  unavailableLogged = false
  releaseParserRuntime()
}

/**
 * Split a `.scm` query pack into its top-level patterns.
 *
 * Tree-sitter compiles a `.scm` as a unit, so a single pattern referencing a
 * node the grammar renamed invalidates the *entire* query. Splitting lets us
 * keep the patterns that still match the shipped grammar.
 *
 * A top-level pattern is one balanced `(...)`/`[...]` form plus any trailing
 * `@captures` and quantifiers. Comments and strings are skipped so a `;` or a
 * paren inside them cannot desynchronise the scan. Pure — the unit-testable
 * core of the recovery path.
 */
export function splitTopLevelPatterns(source: string): string[] {
  const patterns: string[] = []
  const n = source.length
  let i = 0

  while (i < n) {
    const ch = source[i]
    if (ch === ';') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (ch !== '(' && ch !== '[') {
      i++
      continue
    }

    const start = i
    let depth = 0
    let inString = false
    while (i < n) {
      const c = source[i]
      if (inString) {
        if (c === '\\') i++
        else if (c === '"') inString = false
        i++
        continue
      }
      if (c === '"') {
        inString = true
        i++
        continue
      }
      if (c === ';') {
        while (i < n && source[i] !== '\n') i++
        continue
      }
      if (c === '(' || c === '[') depth++
      else if (c === ')' || c === ']') {
        depth--
        if (depth === 0) {
          i++
          break
        }
      }
      i++
    }

    // Trailing `@capture` names and quantifiers belong to the form just closed.
    let end = i
    for (;;) {
      let k = end
      while (k < n && /\s/.test(source[k])) k++
      if (k < n && (source[k] === '?' || source[k] === '*' || source[k] === '+')) {
        end = k + 1
        continue
      }
      if (k < n && source[k] === '@') {
        k++
        while (k < n && /[\w.-]/.test(source[k])) k++
        end = k
        continue
      }
      break
    }

    patterns.push(source.slice(start, end).trim())
    i = end
  }

  return patterns
}

/**
 * Compile a language's query pack, salvaging what the grammar still accepts.
 *
 * Fast path: compile the whole file — unchanged for every language whose pack
 * matches its grammar. Only when that fails do we split and compile pattern by
 * pattern, keeping the survivors. C# recovers 11 of 12 patterns this way
 * (classes, interfaces, methods, namespaces); only the stale generic-constraint
 * reference is lost. Self-healing across grammar bumps, rather than pinning a
 * package-version pair we do not control.
 */
function compileQuery(
  Query: WebTreeSitter['Query'],
  language: TsLanguage,
  lang: string,
  source: string
): TsQuery | null {
  try {
    return new Query(language, source)
  } catch (error) {
    const message = (error as Error).message
    const patterns = splitTopLevelPatterns(source)
    const kept: string[] = []
    for (const pattern of patterns) {
      try {
        new Query(language, pattern).delete()
        kept.push(pattern)
      } catch {
        /* pattern no longer matches the shipped grammar — drop just this one */
      }
    }

    let recovered: TsQuery | null = null
    if (kept.length > 0) {
      try {
        recovered = new Query(language, kept.join('\n\n'))
      } catch {
        recovered = null
      }
    }

    const dropped = recovered ? patterns.length - kept.length : patterns.length
    queryDiagnostics.set(lang, {
      lang,
      totalPatterns: patterns.length,
      droppedPatterns: dropped,
      error: message
    })
    if (recovered) {
      log.warn(
        `[CodeGraph] Query pack for '${lang}' does not fully match its grammar: ` +
          `${dropped}/${patterns.length} pattern(s) dropped (${message}). ` +
          `Indexing continues with the remaining ${kept.length}.`
      )
    } else {
      log.error(
        `[CodeGraph] Query pack for '${lang}' is unusable — 0/${patterns.length} pattern(s) ` +
          `compile against the shipped grammar (${message}). ` +
          `Files of this language will produce NO tags.`
      )
    }
    return recovered
  }
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
  let query: TsQuery | null = null
  try {
    query = compileQuery(Query, language, lang, readFileSync(queryPath, 'utf-8'))
  } catch (error) {
    log.error(`[CodeGraph] Could not read query pack for '${lang}': ${(error as Error).message}`)
  }
  queryCache.set(lang, query)
  return query
}

// ── Extraction ──────────────────────────────────────────────────────────────

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
