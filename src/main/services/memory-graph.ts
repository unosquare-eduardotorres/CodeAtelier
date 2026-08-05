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
  MemoryEdge,
  MemoryGraphData,
  MemoryGraphEdge,
  MemoryGraphEdgeKind,
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
  /**
   * Typed relationships from `memory_edges` (migration 137).
   *
   * When present these are authoritative for supersede/contradict/derive
   * links. The legacy derivation from `superseded_by` and the contradictions
   * table is kept as a fallback so a database that has not been migrated, or
   * one whose backfill found nothing, still renders a useful graph.
   */
  edges?: MemoryEdge[]
}

/** memory_edges edge_type → the kind the graph UI renders. */
const EDGE_KIND: Record<string, MemoryGraphEdgeKind | undefined> = {
  supersedes: 'superseded',
  contradicts: 'contradiction',
  derived_from: 'derived',
  relates_to: 'similarity'
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

  // 2. Typed edges from memory_edges — the single source of truth once the
  //    backfill has run.
  const typedEdges = input.edges ?? []
  for (const edge of typedEdges) {
    if (!nodeIds.has(edge.fromId) || !nodeIds.has(edge.toId)) continue
    const kind = EDGE_KIND[edge.edgeType]
    if (!kind) continue
    const key = [edge.fromId, edge.toId].sort().join('-')
    if (edgeSet.has(key)) continue
    edgeSet.add(key)
    edges.push({ source: edge.fromId, target: edge.toId, kind, weight: edge.confidence })
  }

  // 3. Legacy derivation — only fills gaps the edge table did not cover.
  for (const fact of facts) {
    if (fact.supersededBy && nodeIds.has(fact.supersededBy)) {
      const key = [fact.id, fact.supersededBy].sort().join('-')
      if (!edgeSet.has(key)) {
        edgeSet.add(key)
        edges.push({ source: fact.id, target: fact.supersededBy, kind: 'superseded', weight: 1.0 })
      }
    }
  }

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

  let edges: MemoryEdge[] = []
  try {
    edges = memoryFactRepository.findEdgesByWorkspace(workspaceId)
  } catch {
    // Database predates migration 137 — the legacy derivation still applies.
  }

  return deriveGraphEdges({
    facts: allFacts,
    embeddings: withEmbeddings.map(({ fact, embedding }) => ({
      factId: fact.id,
      embedding
    })),
    contradictions,
    edges
  })
}
