/**
 * Unit tests for extracted pure functions from code-graph.service.ts.
 * Tests edge building from tags, rank boosting, and rank sorting/filtering — zero DB deps.
 */
import assert from 'node:assert/strict'
import {
  buildEdgesFromTags,
  applyRankBoosts,
  sortAndFilterByRank,
  pickHealthCheckSamples
} from '../code-graph.service'
import { filterRankedFiles } from '../code-graph-exclusions'
import type { RepomapTag } from '../../db/repositories/code-graph-tag.repository'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

/** Helper to create a minimal RepomapTag */
function tag(name: string, kind: 'def' | 'ref', relFname: string, line = 1): RepomapTag {
  return { relFname, fname: `/abs/${relFname}`, line, name, kind }
}

// ── buildEdgesFromTags ──

describe('buildEdgesFromTags', () => {
  test('creates edge from ref file to def file for same symbol', () => {
    const tags = [tag('MyClass', 'def', 'src/myclass.ts'), tag('MyClass', 'ref', 'src/consumer.ts')]
    const edges = buildEdgesFromTags(tags)
    assert.equal(edges.length, 1)
    assert.equal(edges[0].from, 'src/consumer.ts')
    assert.equal(edges[0].to, 'src/myclass.ts')
    assert.equal(edges[0].name, 'MyClass')
  })

  test('ignores self-references (ref and def in same file)', () => {
    const tags = [tag('helper', 'def', 'src/utils.ts'), tag('helper', 'ref', 'src/utils.ts')]
    const edges = buildEdgesFromTags(tags)
    assert.equal(edges.length, 0, 'Self-references should produce no edges')
  })

  test('creates cross-product edges for multi-file defs/refs', () => {
    // Symbol defined in 2 files, referenced in 2 files → 2×2 - self-refs = some edges
    const tags = [
      tag('render', 'def', 'src/a.ts'),
      tag('render', 'def', 'src/b.ts'),
      tag('render', 'ref', 'src/c.ts'),
      tag('render', 'ref', 'src/d.ts')
    ]
    const edges = buildEdgesFromTags(tags)
    // c→a, c→b, d→a, d→b = 4 edges
    assert.equal(edges.length, 4)
    const edgeKeys = edges.map((e) => `${e.from}->${e.to}`)
    assert.ok(edgeKeys.includes('src/c.ts->src/a.ts'))
    assert.ok(edgeKeys.includes('src/c.ts->src/b.ts'))
    assert.ok(edgeKeys.includes('src/d.ts->src/a.ts'))
    assert.ok(edgeKeys.includes('src/d.ts->src/b.ts'))
  })

  test('symbols with only definitions produce no edges', () => {
    const tags = [tag('orphanDef', 'def', 'src/a.ts'), tag('orphanDef', 'def', 'src/b.ts')]
    const edges = buildEdgesFromTags(tags)
    assert.equal(edges.length, 0)
  })

  test('symbols with only references produce no edges', () => {
    const tags = [tag('missing', 'ref', 'src/a.ts'), tag('missing', 'ref', 'src/b.ts')]
    const edges = buildEdgesFromTags(tags)
    assert.equal(edges.length, 0)
  })

  test('empty tags return empty edges', () => {
    const edges = buildEdgesFromTags([])
    assert.equal(edges.length, 0)
  })

  test('handles multiple symbols independently', () => {
    const tags = [
      tag('Foo', 'def', 'src/foo.ts'),
      tag('Foo', 'ref', 'src/main.ts'),
      tag('Bar', 'def', 'src/bar.ts'),
      tag('Bar', 'ref', 'src/main.ts')
    ]
    const edges = buildEdgesFromTags(tags)
    assert.equal(edges.length, 2)
    const names = edges.map((e) => e.name).sort()
    assert.deepEqual(names, ['Bar', 'Foo'])
  })

  test('handles large tag sets without explosion', () => {
    // 100 files, each with 1 def and 1 ref for unique symbols → 100 edges max
    const tags: RepomapTag[] = []
    for (let i = 0; i < 100; i++) {
      tags.push(tag(`sym${i}`, 'def', `src/def${i}.ts`))
      tags.push(tag(`sym${i}`, 'ref', `src/ref${i}.ts`))
    }
    const edges = buildEdgesFromTags(tags)
    assert.equal(edges.length, 100)
  })
})

// ── applyRankBoosts ──

describe('applyRankBoosts', () => {
  test('focus files get 20x boost', () => {
    const ranks = new Map([['src/important.ts', 0.5]])
    const result = applyRankBoosts(ranks, ['src/important.ts'], [], [], [])
    assert.equal(result.get('src/important.ts'), 10.0) // 0.5 * 20
  })

  test('priority files get 5x boost', () => {
    const ranks = new Map([['src/priority.ts', 0.4]])
    const result = applyRankBoosts(ranks, [], ['src/priority.ts'], [], [])
    assert.equal(result.get('src/priority.ts'), 2.0) // 0.4 * 5
  })

  test('priority identifiers boost files containing them by 3x', () => {
    const ranks = new Map([['src/auth.ts', 0.3]])
    const tags = [tag('validateJwt', 'def', 'src/auth.ts')]
    const result = applyRankBoosts(ranks, [], [], ['validateJwt'], tags)
    assert.ok(
      Math.abs(result.get('src/auth.ts')! - 0.9) < 1e-10,
      `Expected 0.9, got ${result.get('src/auth.ts')}`
    ) // 0.3 * 3
  })

  test('priority identifier matching is case-insensitive', () => {
    const ranks = new Map([['src/auth.ts', 0.3]])
    const tags = [tag('ValidateJWT', 'def', 'src/auth.ts')]
    const result = applyRankBoosts(ranks, [], [], ['validatejwt'], tags)
    assert.ok(
      Math.abs(result.get('src/auth.ts')! - 0.9) < 1e-10,
      `Case-insensitive match failed: got ${result.get('src/auth.ts')}`
    )
  })

  test('unknown files get default rank of 0', () => {
    const ranks = new Map<string, number>()
    const result = applyRankBoosts(ranks, ['src/new-file.ts'], [], [], [])
    assert.equal(result.get('src/new-file.ts'), 0) // 0 * 20 = 0
  })

  test('combined boosts multiply correctly', () => {
    // Focus (20x) applied first, then if same file has priority identifier (3x)
    const ranks = new Map([['src/core.ts', 1.0]])
    const tags = [tag('CoreService', 'def', 'src/core.ts')]
    const result = applyRankBoosts(
      ranks,
      ['src/core.ts'], // 20x
      [],
      ['CoreService'], // 3x
      tags
    )
    // focus: 1.0 * 20 = 20, then identifier: 20 * 3 = 60
    assert.equal(result.get('src/core.ts'), 60)
  })

  test('empty focus/priority returns unchanged ranks', () => {
    const ranks = new Map([
      ['a.ts', 0.5],
      ['b.ts', 0.3]
    ])
    const result = applyRankBoosts(ranks, [], [], [], [])
    assert.equal(result.get('a.ts'), 0.5)
    assert.equal(result.get('b.ts'), 0.3)
  })

  test('does not mutate input ranks map', () => {
    const ranks = new Map([['src/file.ts', 0.5]])
    applyRankBoosts(ranks, ['src/file.ts'], [], [], [])
    assert.equal(ranks.get('src/file.ts'), 0.5, 'Original map should not be mutated')
  })
})

// ── sortAndFilterByRank ──

describe('sortAndFilterByRank', () => {
  test('excludeUnranked filters zero-rank files', () => {
    const ranks = new Map([
      ['a.ts', 0.5],
      ['b.ts', 0],
      ['c.ts', 0.1]
    ])
    const result = sortAndFilterByRank(ranks, true)
    assert.equal(result.length, 2)
    assert.equal(result[0][0], 'a.ts')
    assert.equal(result[1][0], 'c.ts')
  })

  test('files sorted by boosted rank descending', () => {
    const ranks = new Map([
      ['low.ts', 0.1],
      ['high.ts', 0.9],
      ['mid.ts', 0.5]
    ])
    const result = sortAndFilterByRank(ranks, false)
    assert.equal(result[0][0], 'high.ts')
    assert.equal(result[1][0], 'mid.ts')
    assert.equal(result[2][0], 'low.ts')
  })

  test('excludeUnranked=false keeps zero-rank files', () => {
    const ranks = new Map([
      ['a.ts', 0],
      ['b.ts', 0.1]
    ])
    const result = sortAndFilterByRank(ranks, false)
    assert.equal(result.length, 2)
  })

  test('empty map returns empty array', () => {
    const result = sortAndFilterByRank(new Map(), true)
    assert.equal(result.length, 0)
  })
})

// ── filterRankedFiles ──

describe('filterRankedFiles — keeps vendored code out of LLM extraction', () => {
  test('drops built-in excluded directories', () => {
    const result = filterRankedFiles(['src/app.ts', 'BuildSystem/Tools/nunit.cs', 'obj/gen.cs'], [])
    assert.deepEqual(result, ['src/app.ts'])
  })

  test('drops paths matched by workspace ignore patterns', () => {
    const result = filterRankedFiles(
      ['Content/js/lib/angular.js', 'src/app.ts'],
      ['**/Content/js/lib/**']
    )
    assert.deepEqual(result, ['src/app.ts'])
  })

  test('handles Windows backslash paths', () => {
    const result = filterRankedFiles(['src\\bin\\gen.cs', 'src\\app.ts'], [])
    assert.deepEqual(result, ['src\\app.ts'])
  })

  test('no patterns and no excluded dirs is a pass-through', () => {
    const files = ['a.ts', 'b/c.ts']
    assert.deepEqual(filterRankedFiles(files, []), files)
  })

  test('a filename resembling an excluded dir is not dropped', () => {
    assert.deepEqual(filterRankedFiles(['src/binary-utils.ts'], []), ['src/binary-utils.ts'])
  })
})

// The parse health check used to probe allFiles[0] alone. On .NET repos that is
// Common/AssemblyVersion.cs — attributes only, legitimately zero tags — so it
// printed "Tree-sitter parsing may be broken" on every single index run.
describe('pickHealthCheckSamples', () => {
  test('spreads across the list instead of taking the head', () => {
    const files = Array.from({ length: 100 }, (_, i) => `f${i}.cs`)
    const samples = pickHealthCheckSamples(files, 8)
    assert.equal(samples.length, 8)
    assert.equal(samples[0], 'f0.cs')
    assert.equal(new Set(samples).size, 8, 'samples must be distinct')
    assert.notDeepEqual(samples, files.slice(0, 8), 'must not just be the first N files')
  })

  test('returns everything when the workspace is smaller than the sample size', () => {
    assert.deepEqual(pickHealthCheckSamples(['a.ts', 'b.ts'], 8), ['a.ts', 'b.ts'])
    assert.deepEqual(pickHealthCheckSamples([]), [])
  })
})

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`)
console.log(`code-graph-logic: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
