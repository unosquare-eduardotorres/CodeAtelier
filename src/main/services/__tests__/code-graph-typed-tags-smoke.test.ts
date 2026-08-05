/**
 * Smoke test for subtype-preserving Tree-sitter extraction.
 *
 * `extractTypedTags` returns `null` on ANY infrastructure failure so indexing
 * degrades to untyped tags instead of breaking. That safety net also means a
 * broken query pack, a missing WASM grammar or a renamed capture is completely
 * invisible: the index still builds, every edge is just `references` again.
 * This test is the fallback detector — it asserts the typed path actually runs
 * against a real repo file and yields real subtypes.
 *
 * Skips gracefully when the runtime cannot load the Tree-sitter WASM at all,
 * mirroring native-module-smoke.test.ts.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { extractTypedTags } from '../code-graph-tags'
import { codeGraphService } from '../code-graph.service'
import type { RepomapTag } from '../../db/repositories/code-graph-tag.repository'

/** A real source file from this repo — fixtures cannot catch query-pack drift. */
const FIXTURE_ABS = path.resolve(process.cwd(), 'src/main/services/code-graph-tags.ts')
const FIXTURE_REL = 'src/main/services/code-graph-tags.ts'

/**
 * Probe the WASM runtime once; a failure here is an environment gap, not a bug.
 * Returns the language resolver when the whole typed path can run.
 */
/** Say so loudly — a silently-passing smoke test is exactly what this guards against. */
function unavailable(): void {
  console.log('    (typed extraction skipped: web-tree-sitter unavailable in this runtime)')
}

let runtimePromise: Promise<((f: string) => string | null) | null> | null = null

/** Memoised probe — tests register synchronously and await this inside their body. */
function runtime(): Promise<((f: string) => string | null) | null> {
  runtimePromise ??= loadRuntime()
  return runtimePromise
}

async function loadRuntime(): Promise<((f: string) => string | null) | null> {
  try {
    const { initParser } = await import('repomap-mcp/dist/tags.js')
    await initParser()
    await import('web-tree-sitter')
    const { filenameToLang } = await import('repomap-mcp/dist/languages.js')
    return filenameToLang
  } catch {
    return null
  }
}

/**
 * The harness runs test bodies from all files concurrently, and any suite that
 * exercises indexing calls `releaseTypedParser()`, which clears the shared WASM
 * grammar cache mid-flight. One retry absorbs that collision; a genuinely
 * missing query pack or grammar still fails both attempts.
 */
async function extractStable(
  toLang: (f: string) => string | null
): Promise<Awaited<ReturnType<typeof extractTypedTags>>> {
  const first = await extractTypedTags(FIXTURE_ABS, FIXTURE_REL, toLang)
  if (first !== null && first.length > 0) return first
  return extractTypedTags(FIXTURE_ABS, FIXTURE_REL, toLang)
}

/**
 * Registered synchronously (not inside an async describe) so these tests queue
 * with everything else instead of resolving after the whole suite has drained.
 * Each body probes the runtime itself and reports an environment gap loudly
 * rather than failing.
 */
describe('extractTypedTags — typed path', () => {
  test('returns tags rather than falling back to null', async () => {
    const toLang = await runtime()
    if (!toLang) return unavailable()
    const tags = await extractStable(toLang)
    assert.notEqual(
      tags,
      null,
      'null means the typed extractor fell back — the query pack or grammar is missing'
    )
    assert.ok((tags as unknown[]).length > 0, 'a real source file must yield tags')
  })

  test('preserves the capture subtype the untyped extractor discards', async () => {
    const toLang = await runtime()
    if (!toLang) return unavailable()
    const tags = (await extractStable(toLang)) ?? []
    const typedDefs = tags.filter((t) => t.kind === 'def' && t.symbolKind !== null)
    assert.ok(typedDefs.length > 0, 'at least one definition must carry a symbolKind')

    const callable = tags.filter(
      (t) => t.kind === 'def' && (t.symbolKind === 'function' || t.symbolKind === 'method')
    )
    assert.ok(
      callable.length > 0,
      `expected def.function/def.method captures, saw kinds: ${[
        ...new Set(tags.map((t) => `${t.kind}.${t.symbolKind}`))
      ].join(', ')}`
    )
  })

  test('every tag points back at the file it came from', async () => {
    const toLang = await runtime()
    if (!toLang) return unavailable()
    const tags = (await extractStable(toLang)) ?? []
    assert.ok(tags.length > 0, 'the fixture must yield tags')
    assert.ok(tags.every((t) => t.relFname === FIXTURE_REL))
    assert.ok(tags.every((t) => t.line > 0))
  })

  test('returns null — not [] — when the language has no grammar', async () => {
    if (!(await runtime())) return unavailable()
    // `null` is the fallback signal; `[]` would mean "parsed, found nothing"
    // and would silently strip a file's tags instead of re-parsing untyped.
    assert.equal(await extractTypedTags(FIXTURE_ABS, FIXTURE_REL, () => null), null)
    assert.equal(await extractTypedTags(FIXTURE_ABS, FIXTURE_REL, () => 'not_a_language'), null)
  })
})

// ── Fallback path ───────────────────────────────────────────────────────────

describe('parseFileTags — fallback path', () => {
  test('falls through to getTags when typed extraction cannot run', async () => {
    const stubTags: RepomapTag[] = [
      { relFname: 'a.ts', fname: '/a.ts', line: 1, name: 'X', kind: 'def' }
    ]
    let getTagsCalls = 0
    const getTags = async (): Promise<RepomapTag[]> => {
      getTagsCalls++
      return stubTags
    }

    // parseFileTags is private by design — the fallback contract it guards is
    // exactly what has no other observable surface.
    const service = codeGraphService as unknown as {
      parseFileTags: (
        getTags: () => Promise<RepomapTag[]>,
        fname: string,
        relFname: string,
        filenameToLang: (f: string) => string | null
      ) => Promise<{ tags: RepomapTag[]; typed: boolean }>
    }

    // filenameToLang → null is the cheapest way to force typed extraction to bail.
    const result = await service.parseFileTags(getTags, '/a.ts', 'a.ts', () => null)

    assert.equal(result.typed, false, 'the fallback must be reported, not hidden')
    assert.equal(getTagsCalls, 1, 'untyped getTags must still run')
    assert.deepEqual(result.tags, stubTags, 'tags survive the fallback')
  })
})

// Only print totals and exit when this file is run directly — under run-tests.ts
// the shared harness owns the summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
