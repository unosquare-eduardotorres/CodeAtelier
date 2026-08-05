/**
 * Unit tests for schema-v130 typed edges (Phase 1) and subsystem detection (Phase 4).
 *
 * Covers the pure core only — capture-name parsing, the deriveEdgeType truth
 * table, resolution/fan-out tagging in buildEdgesFromTags, and label propagation.
 * Zero DB, zero Tree-sitter.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  buildEdgesFromTags,
  deriveEdgeType,
  AMBIGUOUS_FANOUT,
  AMBIGUITY_THRESHOLD
} from '../code-graph.service'
import { parseCaptureName, dedupeTags } from '../code-graph-tags'
import type { TypedTag } from '../code-graph-tags'
import {
  detectCommunities,
  findGodNodes,
  commonDirectoryPrefix,
  dominantDirectory
} from '../code-graph-communities'
import type { RepomapTag } from '../../db/repositories/code-graph-tag.repository'

function tag(
  name: string,
  kind: 'def' | 'ref',
  relFname: string,
  symbolKind: string | null = null
): RepomapTag {
  return { relFname, fname: `/abs/${relFname}`, line: 1, name, kind, symbolKind }
}

// ── parseCaptureName ──

describe('parseCaptureName', () => {
  test('keeps the subtype tail that repomap-mcp discards', () => {
    assert.deepEqual(parseCaptureName('name.definition.method'), {
      kind: 'def',
      symbolKind: 'method'
    })
    assert.deepEqual(parseCaptureName('name.reference.call'), {
      kind: 'ref',
      symbolKind: 'call'
    })
  })

  test('subtype is null when the capture has no tail', () => {
    assert.deepEqual(parseCaptureName('name.definition'), { kind: 'def', symbolKind: null })
  })

  test('rejects captures that are not name.definition / name.reference', () => {
    assert.equal(parseCaptureName('definition.function'), null)
    assert.equal(parseCaptureName('reference.call'), null)
    assert.equal(parseCaptureName('local.scope'), null)
    assert.equal(parseCaptureName('name.something.else'), null)
  })
})

// ── dedupeTags ──

describe('dedupeTags', () => {
  test('collapses repeated captures on the same file/line/name/kind', () => {
    const typed: TypedTag[] = [
      { relFname: 'a.ts', fname: '/a.ts', line: 3, name: 'Foo', kind: 'def', symbolKind: 'class' },
      { relFname: 'a.ts', fname: '/a.ts', line: 3, name: 'Foo', kind: 'def', symbolKind: 'type' },
      { relFname: 'a.ts', fname: '/a.ts', line: 9, name: 'Foo', kind: 'ref', symbolKind: 'call' }
    ]
    const deduped = dedupeTags(typed)
    assert.equal(deduped.length, 2)
    assert.equal(deduped[0].symbolKind, 'class', 'first capture wins')
  })
})

// ── deriveEdgeType truth table ──

describe('deriveEdgeType', () => {
  test('call-like references become calls', () => {
    assert.equal(deriveEdgeType('call', 'function'), 'calls')
    assert.equal(deriveEdgeType('call', 'method'), 'calls')
    assert.equal(deriveEdgeType('call', 'class'), 'calls')
    assert.equal(deriveEdgeType('send', 'method'), 'calls')
    assert.equal(deriveEdgeType('constructor', 'class'), 'calls')
  })

  test('implementation and interface references become implements', () => {
    assert.equal(deriveEdgeType('implementation', 'interface'), 'implements')
    assert.equal(deriveEdgeType('interface', 'interface'), 'implements')
  })

  test('module references become imports only when the target is a module', () => {
    assert.equal(deriveEdgeType('module', 'module'), 'imports')
    assert.equal(deriveEdgeType('module', null), 'imports')
    assert.equal(deriveEdgeType('module', 'function'), 'references')
  })

  test('never emits extends — reference.class is overloaded across grammars', () => {
    // Java uses reference.class for BOTH (superclass) and (object_creation_expression);
    // C# adds base lists, generic constraints and variable types. A wrong type is
    // worse than a generic one.
    assert.equal(deriveEdgeType('class', 'class'), 'references')
  })

  test('unknown and missing subtypes fall back to references', () => {
    assert.equal(deriveEdgeType('type', 'interface'), 'references')
    assert.equal(deriveEdgeType(null, null), 'references')
    assert.equal(deriveEdgeType(undefined, undefined), 'references')
    assert.equal(deriveEdgeType('slot', 'resource'), 'references')
  })
})

// ── buildEdgesFromTags: typing, provenance, cut-off ──

describe('buildEdgesFromTags — typing and provenance', () => {
  test('types the edge from the ref/def subtype pair', () => {
    const edges = buildEdgesFromTags([
      tag('doWork', 'def', 'src/worker.ts', 'function'),
      tag('doWork', 'ref', 'src/caller.ts', 'call')
    ])
    assert.equal(edges.length, 1)
    assert.equal(edges[0].edgeType, 'calls')
    assert.equal(edges[0].from, 'src/caller.ts')
    assert.equal(edges[0].to, 'src/worker.ts')
  })

  test('a single definition site is resolution=extracted, fanout=1', () => {
    const edges = buildEdgesFromTags([
      tag('Unique', 'def', 'src/a.ts', 'class'),
      tag('Unique', 'ref', 'src/b.ts', 'type')
    ])
    assert.equal(edges[0].resolution, 'extracted')
    assert.equal(edges[0].defFanout, 1)
  })

  test('several definition sites are resolution=inferred', () => {
    const edges = buildEdgesFromTags([
      tag('handle', 'def', 'src/a.ts', 'function'),
      tag('handle', 'def', 'src/b.ts', 'function'),
      tag('handle', 'ref', 'src/c.ts', 'call')
    ])
    assert.equal(edges.length, 2, 'one edge per candidate definition')
    for (const e of edges) {
      assert.equal(e.resolution, 'inferred')
      assert.equal(e.defFanout, 2)
    }
  })

  test('fan-out above AMBIGUOUS_FANOUT is labelled ambiguous but still stored', () => {
    const tags: RepomapTag[] = []
    for (let i = 0; i <= AMBIGUOUS_FANOUT; i++) {
      tags.push(tag('get', 'def', `src/def${i}.ts`, 'method'))
    }
    tags.push(tag('get', 'ref', 'src/user.ts', 'call'))
    const edges = buildEdgesFromTags(tags)
    assert.equal(edges.length, AMBIGUOUS_FANOUT + 1)
    assert.equal(edges[0].resolution, 'ambiguous')
  })

  test('fan-out above AMBIGUITY_THRESHOLD is dropped entirely', () => {
    const tags: RepomapTag[] = []
    for (let i = 0; i <= AMBIGUITY_THRESHOLD; i++) {
      tags.push(tag('T', 'def', `src/def${i}.ts`, 'type'))
    }
    tags.push(tag('T', 'ref', 'src/user.ts', 'type'))
    assert.equal(buildEdgesFromTags(tags).length, 0)
  })

  test('the cut-off is overridable so recall can be restored', () => {
    const tags: RepomapTag[] = []
    for (let i = 0; i <= AMBIGUITY_THRESHOLD; i++) {
      tags.push(tag('T', 'def', `src/def${i}.ts`, 'type'))
    }
    tags.push(tag('T', 'ref', 'src/user.ts', 'type'))
    assert.equal(buildEdgesFromTags(tags, Infinity).length, AMBIGUITY_THRESHOLD + 1)
  })

  test('the strongest role wins when one file uses a name several ways', () => {
    // consumer.ts both calls Foo() and annotates `: Foo` — the call is the
    // stronger evidence, so the edge is typed as a call.
    const edges = buildEdgesFromTags([
      tag('Foo', 'def', 'src/foo.ts', 'function'),
      tag('Foo', 'ref', 'src/consumer.ts', 'type'),
      tag('Foo', 'ref', 'src/consumer.ts', 'call')
    ])
    assert.equal(edges.length, 1)
    assert.equal(edges[0].edgeType, 'calls')
  })

  test('untyped tags still produce edges (pre-v130 index, or fallback parse)', () => {
    const edges = buildEdgesFromTags([
      { relFname: 'src/a.ts', fname: '/a', line: 1, name: 'X', kind: 'def' },
      { relFname: 'src/b.ts', fname: '/b', line: 1, name: 'X', kind: 'ref' }
    ])
    assert.equal(edges.length, 1)
    assert.equal(edges[0].edgeType, 'references')
  })

  test('self-references inside one file never become edges', () => {
    const edges = buildEdgesFromTags([
      tag('local', 'def', 'src/a.ts', 'function'),
      tag('local', 'ref', 'src/a.ts', 'call')
    ])
    assert.equal(edges.length, 0)
  })
})

// ── Communities + god nodes ──

describe('commonDirectoryPrefix', () => {
  test('names a group by its deepest shared directory', () => {
    assert.equal(
      commonDirectoryPrefix(['src/main/services/a.ts', 'src/main/services/b.ts']),
      'src/main/services'
    )
    assert.equal(commonDirectoryPrefix(['src/main/a.ts', 'src/renderer/b.ts']), 'src')
    assert.equal(commonDirectoryPrefix(['a.ts', 'b.ts']), 'root')
    assert.equal(commonDirectoryPrefix([]), 'root')
  })
})

describe('dominantDirectory', () => {
  test('one outlier no longer collapses the name to a useless prefix', () => {
    const files = [
      'src/main/services/a.ts',
      'src/main/services/b.ts',
      'src/main/services/c.ts',
      'src/renderer/odd.ts'
    ]
    // The shared prefix would be a bare 'src' — true, but useless.
    assert.equal(commonDirectoryPrefix(files), 'src')
    assert.equal(dominantDirectory(files), 'src/main/services')
  })

  test('falls back to the shared prefix when no directory holds a plurality', () => {
    const files = ['src/a/one.ts', 'src/b/two.ts', 'src/c/three.ts']
    assert.equal(dominantDirectory(files), 'src')
  })

  test('empty input is named root', () => {
    assert.equal(dominantDirectory([]), 'root')
  })
})

describe('detectCommunities', () => {
  const pairs = [
    // cluster one
    { sourceFile: 'src/api/a.ts', targetFile: 'src/api/b.ts', edgeCount: 5 },
    { sourceFile: 'src/api/b.ts', targetFile: 'src/api/c.ts', edgeCount: 5 },
    { sourceFile: 'src/api/c.ts', targetFile: 'src/api/a.ts', edgeCount: 5 },
    // cluster two
    { sourceFile: 'src/ui/x.ts', targetFile: 'src/ui/y.ts', edgeCount: 5 },
    { sourceFile: 'src/ui/y.ts', targetFile: 'src/ui/z.ts', edgeCount: 5 },
    { sourceFile: 'src/ui/z.ts', targetFile: 'src/ui/x.ts', edgeCount: 5 },
    // one weak bridge between them
    { sourceFile: 'src/api/a.ts', targetFile: 'src/ui/x.ts', edgeCount: 1 }
  ]

  test('separates two densely-linked clusters', () => {
    const communities = detectCommunities(pairs, { minSize: 3 })
    assert.equal(communities.length, 2)
    const names = communities.map((c) => c.name).sort()
    assert.deepEqual(names, ['src/api', 'src/ui'])
  })

  test('names each community by its most-connected member', () => {
    const communities = detectCommunities(pairs, { minSize: 3 })
    const hubs = communities.map((c) => c.hubFile).sort()
    // a.ts and x.ts each carry the extra bridge edge, so they are the hubs.
    assert.deepEqual(hubs, ['src/api/a.ts', 'src/ui/x.ts'])
  })

  test('hub files are kept out of propagation so they cannot merge everything', () => {
    // A barrel file that every module imports would otherwise flood one label
    // across the whole graph.
    const barrel = { sourceFile: 'src/shared/types.ts', edgeCount: 1 }
    const flooded = [
      ...pairs,
      ...[
        'src/api/a.ts',
        'src/api/b.ts',
        'src/api/c.ts',
        'src/ui/x.ts',
        'src/ui/y.ts',
        'src/ui/z.ts'
      ].map((targetFile) => ({ ...barrel, targetFile }))
    ]
    const communities = detectCommunities(flooded, { minSize: 3, hubDegree: 5 })
    assert.equal(communities.length, 2, 'still two subsystems, not one blob')
    for (const c of communities) {
      assert.ok(!c.files.includes('src/shared/types.ts'), 'the hub joins no community')
    }
  })

  test('counts internal edges per community', () => {
    const communities = detectCommunities(pairs, { minSize: 3 })
    for (const c of communities) {
      assert.equal(c.internalEdges, 15, 'three internal pairs of weight 5')
    }
  })

  test('is deterministic across runs', () => {
    const first = detectCommunities(pairs, { minSize: 3 })
    const second = detectCommunities(pairs, { minSize: 3 })
    assert.deepEqual(first, second)
  })

  test('drops groups below minSize', () => {
    assert.equal(detectCommunities(pairs, { minSize: 4 }).length, 0)
  })

  test('an empty graph yields no communities', () => {
    assert.deepEqual(detectCommunities([]), [])
  })
})

describe('findGodNodes', () => {
  test('ranks by distinct neighbours, not edge weight', () => {
    const godNodes = findGodNodes(
      [
        { sourceFile: 'hub.ts', targetFile: 'a.ts', edgeCount: 1 },
        { sourceFile: 'hub.ts', targetFile: 'b.ts', edgeCount: 1 },
        { sourceFile: 'c.ts', targetFile: 'hub.ts', edgeCount: 1 },
        // heavy but narrow — one neighbour, many edges
        { sourceFile: 'a.ts', targetFile: 'b.ts', edgeCount: 99 }
      ],
      2
    )
    assert.equal(godNodes[0].file, 'hub.ts')
    assert.equal(godNodes[0].degree, 3)
  })
})

// Only print totals and exit when this file is run directly — under run-tests.ts
// the shared harness owns the summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
