/**
 * Regression guard for the tree-sitter query pack.
 *
 * `csharp-tags.scm` referenced a `type` node the shipped C# grammar no longer
 * has. Tree-sitter compiles a `.scm` as a unit, so that ONE stale pattern
 * invalidated the whole query — and both repomap-mcp and our own loader
 * swallowed the compile error with a bare `catch`. Every `.cs` file indexed to
 * zero tags, silently, for weeks. Six other languages were dead the same way.
 *
 * Nothing tested this, because "query compiles to nothing" and "file has no
 * symbols" are indistinguishable from the outside. These tests close that gap:
 * the query pack must survive grammar drift, and it must be loud when it does
 * not.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test, describe, summaryAsync } from './test-harness'
import {
  splitTopLevelPatterns,
  extractTypedTags,
  getQueryDiagnostics,
  type TypedTag
} from '../code-graph-tags'

const requireFrom = createRequire(import.meta.url)

const CS_FIXTURE_ABS = path.resolve(process.cwd(), 'src/main/services/__tests__/fixtures/sample.cs')
const CS_FIXTURE_REL = 'src/main/services/__tests__/fixtures/sample.cs'

/** Say so loudly — a silently-skipped guard is what let this bug survive. */
function unavailable(): void {
  console.log('    (query-pack guard skipped: web-tree-sitter unavailable in this runtime)')
}

let runtimePromise: Promise<((f: string) => string | null) | null> | null = null

function runtime(): Promise<((f: string) => string | null) | null> {
  runtimePromise ??= loadRuntime()
  return runtimePromise
}

async function loadRuntime(): Promise<((f: string) => string | null) | null> {
  try {
    const mod = await import('web-tree-sitter')
    await mod.Parser.init()
    const { filenameToLang } = await import('repomap-mcp/dist/languages.js')
    return filenameToLang
  } catch {
    return null
  }
}

/**
 * Concurrent suites call `releaseTypedParser()`, which clears the shared
 * grammar cache mid-flight. One retry absorbs that; a genuinely broken query
 * pack still fails both attempts.
 */
async function extractStable(toLang: (f: string) => string | null): Promise<TypedTag[] | null> {
  const first = await extractTypedTags(CS_FIXTURE_ABS, CS_FIXTURE_REL, toLang)
  if (first !== null && first.length > 0) return first
  return extractTypedTags(CS_FIXTURE_ABS, CS_FIXTURE_REL, toLang)
}

// ── The guard that did not exist ────────────────────────────────────────────

describe('csharp query pack', () => {
  test('yields a usable query — C# source produces tags', async () => {
    const toLang = await runtime()
    if (!toLang) return unavailable()
    assert.equal(toLang(CS_FIXTURE_ABS), 'c_sharp', '.cs must resolve to the c_sharp grammar')

    const tags = await extractStable(toLang)
    assert.notEqual(tags, null, 'null means typed extraction fell back — grammar or query missing')
    assert.ok(
      (tags as TypedTag[]).length > 0,
      'a real C# file must yield tags; zero means the query compiled to nothing'
    )
  })

  test('recovers the definition captures, not just references', async () => {
    const toLang = await runtime()
    if (!toLang) return unavailable()
    const tags = (await extractStable(toLang)) ?? []
    const kinds = new Set(tags.filter((t) => t.kind === 'def').map((t) => t.symbolKind))
    for (const expected of ['class', 'interface', 'method']) {
      assert.ok(
        kinds.has(expected),
        `expected a def.${expected} capture, saw: ${[...kinds].join(', ') || '(none)'}`
      )
    }
    const names = new Set(tags.map((t) => t.name))
    assert.ok(names.has('Greeter'), 'the class name must be indexed')
    assert.ok(names.has('IGreeter'), 'the interface name must be indexed')
  })

  test('a partially-broken pack is reported as degraded, never as dead', async () => {
    const toLang = await runtime()
    if (!toLang) return unavailable()
    await extractStable(toLang)

    // The pack currently drops one stale generic-constraint pattern. Upstream
    // may fix it, so absence is fine — what must never happen is a pack that
    // loses every pattern while indexing reports success.
    const diagnostic = getQueryDiagnostics().find((d) => d.lang === 'c_sharp')
    if (!diagnostic) return
    assert.ok(diagnostic.totalPatterns > 0, 'the splitter must find top-level patterns')
    assert.ok(
      diagnostic.droppedPatterns < diagnostic.totalPatterns,
      `every C# pattern was dropped (${diagnostic.error}) — the index would be empty`
    )
  })
})

// ── Splitter — the pure core of the recovery path ───────────────────────────

describe('splitTopLevelPatterns', () => {
  test('splits sibling forms and keeps their trailing captures', () => {
    const parts = splitTopLevelPatterns(
      '(class_declaration name: (identifier) @name.definition.class) @definition.class\n' +
        '(method_declaration name: (identifier) @name.definition.method) @definition.method'
    )
    assert.equal(parts.length, 2)
    assert.ok(parts[0].endsWith('@definition.class'), 'trailing capture belongs to its pattern')
    assert.ok(parts[1].startsWith('(method_declaration'))
  })

  test('ignores comments and parens inside strings', () => {
    const parts = splitTopLevelPatterns(
      '; (this) is a comment @not.a.capture\n' +
        '(call function: (identifier) @name (#eq? @name ")(")) @reference.call\n'
    )
    assert.equal(parts.length, 1, 'a `)` inside a string must not close the form early')
    assert.ok(parts[0].endsWith('@reference.call'))
  })

  test('treats a bracketed alternation as one pattern', () => {
    const parts = splitTopLevelPatterns('[(a) (b)] @definition.thing')
    assert.equal(parts.length, 1)
    assert.equal(parts[0], '[(a) (b)] @definition.thing')
  })

  test('round-trips the real csharp pack into individually-compilable patterns', async () => {
    if (!(await runtime())) return unavailable()
    const packPath = path.join(
      path.dirname(requireFrom.resolve('repomap-mcp/package.json')),
      'queries/tree-sitter-language-pack/csharp-tags.scm'
    )
    const parts = splitTopLevelPatterns(readFileSync(packPath, 'utf-8'))
    assert.ok(
      parts.length > 5,
      `expected the C# pack to split into many patterns, got ${parts.length}`
    )
    assert.ok(
      parts.every((p) => p.startsWith('(') || p.startsWith('[')),
      'every pattern must start at a form boundary'
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
