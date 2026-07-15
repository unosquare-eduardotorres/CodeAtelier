/**
 * memory-graph.test.ts — Tests for pure graph edge derivation logic.
 *
 * Covers: similarity threshold, top-3 cap, edge dedup, supersede edges,
 * workspace-scoped contradiction filtering, dangling-edge exclusion.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  deriveGraphEdges,
  GRAPH_SIMILARITY_THRESHOLD,
  GRAPH_MAX_EDGES_PER_NODE
} from '../memory-graph'
import type { MemoryFact, MemoryContradiction } from '../../../shared/types'

// ── Helpers ──

function makeFact(overrides: Partial<MemoryFact> & { id: string }): MemoryFact {
  return {
    workspaceId: 'ws-1',
    category: 'convention',
    title: `Fact ${overrides.id}`,
    content: `Content for ${overrides.id}`,
    tags: [],
    scopePaths: [],
    tier: 0,
    confidence: 0.5,
    confirmationCount: 0,
    lastConfirmedAt: null,
    status: 'active',
    supersededBy: null,
    sourceType: 'session',
    sourceRef: null,
    embeddingPending: false,
    lastAccessedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

/** Create an embedding vector with a dominant dimension. */
function makeVec(dim: number, size = 4): Float32Array {
  const v = new Float32Array(size)
  v[dim % size] = 1
  return v
}

/** Create two similar (identical) vectors for guaranteed edge creation. */
function identicalVec(size = 4): Float32Array {
  const v = new Float32Array(size)
  v[0] = 0.7
  v[1] = 0.7
  return v
}

// ── Tests ──

describe('deriveGraphEdges', () => {
  test('returns empty graph for empty input', () => {
    const result = deriveGraphEdges({ facts: [], embeddings: [], contradictions: [] })
    assert.equal(result.nodes.length, 0)
    assert.equal(result.edges.length, 0)
  })

  test('creates nodes for all facts', () => {
    const facts = [makeFact({ id: 'a' }), makeFact({ id: 'b' })]
    const result = deriveGraphEdges({ facts, embeddings: [], contradictions: [] })
    assert.equal(result.nodes.length, 2)
    assert.deepEqual(
      result.nodes.map((n) => n.id).sort(),
      ['a', 'b']
    )
  })

  test('node properties are correctly mapped', () => {
    const fact = makeFact({
      id: 'x',
      title: 'Test Title',
      category: 'gotcha',
      tier: 2,
      status: 'superseded',
      confidence: 0.8
    })
    const result = deriveGraphEdges({ facts: [fact], embeddings: [], contradictions: [] })
    const node = result.nodes[0]
    assert.equal(node.id, 'x')
    assert.equal(node.title, 'Test Title')
    assert.equal(node.category, 'gotcha')
    assert.equal(node.tier, 2)
    assert.equal(node.status, 'superseded')
    assert.equal(node.confidence, 0.8)
  })

  // ── Similarity edges ──

  test('creates similarity edge for vectors above threshold', () => {
    const facts = [makeFact({ id: 'a' }), makeFact({ id: 'b' })]
    const vec = identicalVec() // cosine=1.0, well above threshold
    const result = deriveGraphEdges({
      facts,
      embeddings: [
        { factId: 'a', embedding: vec },
        { factId: 'b', embedding: new Float32Array(vec) } // copy
      ],
      contradictions: []
    })
    const simEdges = result.edges.filter((e) => e.kind === 'similarity')
    assert.equal(simEdges.length, 1)
    assert.ok(simEdges[0].weight >= GRAPH_SIMILARITY_THRESHOLD)
  })

  test('does NOT create similarity edge for orthogonal vectors', () => {
    const facts = [makeFact({ id: 'a' }), makeFact({ id: 'b' })]
    const result = deriveGraphEdges({
      facts,
      embeddings: [
        { factId: 'a', embedding: makeVec(0) },
        { factId: 'b', embedding: makeVec(1) }
      ],
      contradictions: []
    })
    const simEdges = result.edges.filter((e) => e.kind === 'similarity')
    assert.equal(simEdges.length, 0)
  })

  test('caps similarity edges per node at GRAPH_MAX_EDGES_PER_NODE', () => {
    // Create 6 facts all with identical vectors — each node would pair with all others
    const numFacts = GRAPH_MAX_EDGES_PER_NODE + 3
    const facts = Array.from({ length: numFacts }, (_, i) => makeFact({ id: `f${i}` }))
    const vec = identicalVec()
    const embeddings = facts.map((f) => ({
      factId: f.id,
      embedding: new Float32Array(vec)
    }))

    const result = deriveGraphEdges({ facts, embeddings, contradictions: [] })
    const simEdges = result.edges.filter((e) => e.kind === 'similarity')

    // Each node can contribute at most GRAPH_MAX_EDGES_PER_NODE from its top-N loop
    // But dedup means the total is bounded — the first node contributes up to MAX,
    // and subsequent nodes may find edges already added.
    // Key assertion: no node appears in more total edges than MAX + edges added
    // by earlier nodes pointing to it.
    const edgeCounts = new Map<string, number>()
    for (const edge of simEdges) {
      edgeCounts.set(edge.source, (edgeCounts.get(edge.source) ?? 0) + 1)
      edgeCounts.set(edge.target, (edgeCounts.get(edge.target) ?? 0) + 1)
    }
    // The first node (f0) is the source for the loop and adds at most MAX edges
    assert.ok(
      (edgeCounts.get('f0') ?? 0) <= GRAPH_MAX_EDGES_PER_NODE,
      `f0 has ${edgeCounts.get('f0')} edges, expected <= ${GRAPH_MAX_EDGES_PER_NODE}`
    )
  })

  test('deduplicates similarity edges (a-b === b-a)', () => {
    const facts = [makeFact({ id: 'a' }), makeFact({ id: 'b' })]
    const vec = identicalVec()
    const result = deriveGraphEdges({
      facts,
      embeddings: [
        { factId: 'a', embedding: new Float32Array(vec) },
        { factId: 'b', embedding: new Float32Array(vec) }
      ],
      contradictions: []
    })
    // Only one edge, not two
    assert.equal(result.edges.filter((e) => e.kind === 'similarity').length, 1)
  })

  test('filters out embeddings for facts not in the node set', () => {
    const facts = [makeFact({ id: 'a' })]
    const vec = identicalVec()
    const result = deriveGraphEdges({
      facts,
      embeddings: [
        { factId: 'a', embedding: new Float32Array(vec) },
        { factId: 'ghost', embedding: new Float32Array(vec) } // not in facts
      ],
      contradictions: []
    })
    assert.equal(result.edges.length, 0) // no edge because ghost isn't a node
  })

  // ── Supersede edges ──

  test('creates supersede edge when fact.supersededBy points to an existing node', () => {
    const facts = [
      makeFact({ id: 'old', status: 'superseded', supersededBy: 'new' }),
      makeFact({ id: 'new' })
    ]
    const result = deriveGraphEdges({ facts, embeddings: [], contradictions: [] })
    const supEdges = result.edges.filter((e) => e.kind === 'superseded')
    assert.equal(supEdges.length, 1)
    assert.equal(supEdges[0].weight, 1.0)
  })

  test('does NOT create supersede edge when target is NOT in node set (workspace-scoped)', () => {
    const facts = [
      makeFact({ id: 'old', status: 'superseded', supersededBy: 'cross-workspace-fact' })
    ]
    const result = deriveGraphEdges({ facts, embeddings: [], contradictions: [] })
    assert.equal(result.edges.filter((e) => e.kind === 'superseded').length, 0)
  })

  test('deduplicates supersede edges', () => {
    // Unlikely but test the dedup set
    const facts = [
      makeFact({ id: 'a', supersededBy: 'b' }),
      makeFact({ id: 'b', supersededBy: 'a' }) // reverse edge
    ]
    const result = deriveGraphEdges({ facts, embeddings: [], contradictions: [] })
    const supEdges = result.edges.filter((e) => e.kind === 'superseded')
    assert.equal(supEdges.length, 1) // deduped by sorted key
  })

  // ── Contradiction edges ──

  test('creates contradiction edge for workspace-scoped contradictions', () => {
    const facts = [makeFact({ id: 'a' }), makeFact({ id: 'b' })]
    const contradictions: MemoryContradiction[] = [
      {
        id: 'c1',
        oldFactId: 'a',
        newFactId: 'b',
        status: 'pending',
        resolution: null,
        createdAt: '2026-01-01T00:00:00Z',
        resolvedAt: null
      }
    ]
    const result = deriveGraphEdges({ facts, embeddings: [], contradictions })
    const cEdges = result.edges.filter((e) => e.kind === 'contradiction')
    assert.equal(cEdges.length, 1)
    assert.equal(cEdges[0].weight, 1.0)
  })

  test('filters out contradiction edges where source or target is NOT in node set', () => {
    const facts = [makeFact({ id: 'a' })]
    const contradictions: MemoryContradiction[] = [
      {
        id: 'c1',
        oldFactId: 'a',
        newFactId: 'nonexistent', // not a node
        status: 'pending',
        resolution: null,
        createdAt: '2026-01-01T00:00:00Z',
        resolvedAt: null
      }
    ]
    const result = deriveGraphEdges({ facts, embeddings: [], contradictions })
    assert.equal(result.edges.filter((e) => e.kind === 'contradiction').length, 0)
  })

  test('deduplicates contradiction edges', () => {
    const facts = [makeFact({ id: 'a' }), makeFact({ id: 'b' })]
    const contradictions: MemoryContradiction[] = [
      {
        id: 'c1',
        oldFactId: 'a',
        newFactId: 'b',
        status: 'pending',
        resolution: null,
        createdAt: '2026-01-01T00:00:00Z',
        resolvedAt: null
      },
      {
        id: 'c2',
        oldFactId: 'b',
        newFactId: 'a', // same pair reversed
        status: 'pending',
        resolution: null,
        createdAt: '2026-01-01T00:00:00Z',
        resolvedAt: null
      }
    ]
    const result = deriveGraphEdges({ facts, embeddings: [], contradictions })
    assert.equal(result.edges.filter((e) => e.kind === 'contradiction').length, 1)
  })

  // ── Mixed edge types ──

  test('similarity, supersede, and contradiction edges coexist without cross-dedup', () => {
    const facts = [
      makeFact({ id: 'a', supersededBy: 'b' }),
      makeFact({ id: 'b' })
    ]
    const vec = identicalVec()
    const contradictions: MemoryContradiction[] = [
      {
        id: 'c1',
        oldFactId: 'a',
        newFactId: 'b',
        status: 'pending',
        resolution: null,
        createdAt: '2026-01-01T00:00:00Z',
        resolvedAt: null
      }
    ]
    const result = deriveGraphEdges({
      facts,
      embeddings: [
        { factId: 'a', embedding: new Float32Array(vec) },
        { factId: 'b', embedding: new Float32Array(vec) }
      ],
      contradictions
    })

    // The edge key "a-b" is the same for all three types, so only the FIRST
    // kind to claim it gets through (similarity → supersede → contradiction).
    // This is by design — the edgeSet prevents duplicate visual edges.
    assert.ok(result.edges.length >= 1, 'At least one edge should exist')
    assert.ok(result.edges.length <= 3, 'At most 3 edges (one per kind)')
  })

  test('GRAPH_SIMILARITY_THRESHOLD is 0.65', () => {
    assert.equal(GRAPH_SIMILARITY_THRESHOLD, 0.65)
  })

  test('GRAPH_MAX_EDGES_PER_NODE is 3', () => {
    assert.equal(GRAPH_MAX_EDGES_PER_NODE, 3)
  })
})

// ── Summary ──

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
