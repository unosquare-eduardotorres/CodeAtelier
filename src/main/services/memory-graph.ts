/**
 * memory-graph.ts — Pure edge-derivation logic for the memory knowledge graph.
 *
 * Extracted from memory.ipc.ts so the graph-building algorithm is:
 *   1. Unit-testable without repository or IPC mocks
 *   2. Workspace-scoped — contradiction/supersede edges are filtered against
 *      the node set, preventing cross-workspace edge leaks over IPC
 *
 * The IPC handler calls `buildMemoryGraph` which reads from repositories,
 * then delegates to `deriveGraphEdges` (pure, exported for tests).
 */

import type {
  MemoryFact,
  MemoryContradiction,
  MemoryGraphData,
  MemoryGraphEdge,
  MemoryGraphNode
} from '../../shared/types'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import { cosineSimilarity } from './memory-engine.service'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Similarity threshold for graph edges — lower than dedup (0.90) to show related-but-distinct facts. */
export const GRAPH_SIMILARITY_THRESHOLD = 0.65
/** Max similarity edges per node to keep the graph readable. */
export const GRAPH_MAX_EDGES_PER_NODE = 3

// ── Pure edge derivation ──────────────────────────────────────────────────────

export interface DeriveGraphEdgesInput {
  facts: MemoryFact[]
  embeddings: Array<{ factId: string; embedding: Float32Array }>
  contradictions: MemoryContradiction[]
}

/**
 * Derive graph edges from facts, embeddings, and contradictions.
 *
 * Pure function — no side effects, no repository calls.
 * Edges are workspace-scoped: only edges where both source and target
 * exist in the node set are included.
 */
export function deriveGraphEdges(input: DeriveGraphEdgesInput): MemoryGraphData {
  const { facts, embeddings, contradictions } = input

  // Build node list
  const nodes: MemoryGraphNode[] = facts.map((f) => ({
    id: f.id,
    title: f.title,
    category: f.category,
    tier: f.tier,
    status: f.status,
    confidence: f.confidence
  }))

  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges: MemoryGraphEdge[] = []
  const edgeSet = new Set<string>() // dedup "a-b" / "b-a"

  // 1. Similarity edges from embeddings
  const embeddingMap = new Map(embeddings.map(({ factId, embedding }) => [factId, embedding]))
  const embeddedIds = [...embeddingMap.keys()].filter((id) => nodeIds.has(id))

  for (let i = 0; i < embeddedIds.length; i++) {
    const idA = embeddedIds[i]
    const vecA = embeddingMap.get(idA)!
    const scored: Array<{ id: string; sim: number }> = []

    for (let j = i + 1; j < embeddedIds.length; j++) {
      const idB = embeddedIds[j]
      const sim = cosineSimilarity(vecA, embeddingMap.get(idB)!)
      if (sim >= GRAPH_SIMILARITY_THRESHOLD) {
        scored.push({ id: idB, sim })
      }
    }

    // Keep top-N per node
    scored.sort((a, b) => b.sim - a.sim)
    for (const { id: idB, sim } of scored.slice(0, GRAPH_MAX_EDGES_PER_NODE)) {
      const key = [idA, idB].sort().join('-')
      if (!edgeSet.has(key)) {
        edgeSet.add(key)
        edges.push({ source: idA, target: idB, kind: 'similarity', weight: sim })
      }
    }
  }

  // 2. Supersede edges — scoped to nodeIds
  for (const fact of facts) {
    if (fact.supersededBy && nodeIds.has(fact.supersededBy)) {
      const key = [fact.id, fact.supersededBy].sort().join('-')
      if (!edgeSet.has(key)) {
        edgeSet.add(key)
        edges.push({ source: fact.id, target: fact.supersededBy, kind: 'superseded', weight: 1.0 })
      }
    }
  }

  // 3. Contradiction edges — scoped to nodeIds
  for (const c of contradictions) {
    if (!nodeIds.has(c.oldFactId) || !nodeIds.has(c.newFactId)) continue
    const key = [c.oldFactId, c.newFactId].sort().join('-')
    if (!edgeSet.has(key)) {
      edgeSet.add(key)
      edges.push({ source: c.oldFactId, target: c.newFactId, kind: 'contradiction', weight: 1.0 })
    }
  }

  return { nodes, edges }
}

// ── Orchestrator (reads from repositories) ────────────────────────────────────

/**
 * Build a knowledge graph from the workspace's memory facts.
 * Reads from repositories, delegates to `deriveGraphEdges` for pure logic.
 */
export function buildMemoryGraph(workspaceId: string): MemoryGraphData {
  const allFacts = memoryFactRepository.findAllByWorkspace(workspaceId)
  const withEmbeddings = memoryFactRepository.findWithEmbeddings(workspaceId)
  const contradictions = memoryFactRepository.findContradictions()

  return deriveGraphEdges({
    facts: allFacts,
    embeddings: withEmbeddings.map(({ fact, embedding }) => ({
      factId: fact.id,
      embedding
    })),
    contradictions
  })
}
