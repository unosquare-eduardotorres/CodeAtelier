/**
 * MemoryRetrievalService — Hybrid retrieval for per-turn injection and search.
 *
 * Scoring: cosine similarity + keyword overlap + tier bonus + recency +
 * scope_paths boost. Relevance floor filters out irrelevant facts.
 * Keyword-only fallback when embeddings are offline.
 */

import { dbLogger } from '../logger'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import { omlxEmbeddingProvider } from './omlx-embedding.service'
import { sanitizePromptInput } from './sanitize-prompt-input'
import { cosineSimilarity } from './memory-engine.service'
import type {
  MemoryFact,
  MemoryFactCategory,
  MemoryRetrievalResult
} from '../../shared/types'

const log = dbLogger

// ── Retrieval configuration ─────────────────────────────────────────────────

/** Minimum combined score to include in results. */
const RELEVANCE_FLOOR = 0.40

/** Cosine similarity floor — below this, cosine doesn't count. */
const COSINE_FLOOR = 0.55

/** Score weights */
const WEIGHT_COSINE = 0.50
const WEIGHT_KEYWORD = 0.25
const WEIGHT_TIER = 0.10
const WEIGHT_RECENCY = 0.10
const WEIGHT_SCOPE = 0.05

/** Tier-aware character budgets for per-turn injection. */
const TIER_BUDGETS = {
  small: 1500, // ≤64K context window
  medium: 3000, // ≤128K context window
  large: 5000 // >128K context window
} as const

type ContextTier = keyof typeof TIER_BUDGETS

class MemoryRetrievalService {
  // ── Per-turn injection ──────────────────────────────────────────────────

  /**
   * Get relevant facts for a turn, formatted for prompt injection.
   * Returns empty string when nothing is relevant (the common case).
   *
   * @param workspaceId — workspace to search
   * @param promptText — the user's prompt to match against
   * @param contextTier — controls character budget
   * @param injectedIds — set of fact IDs already injected this session (mutated in place)
   */
  async getContextForTurn(
    workspaceId: string,
    promptText: string,
    contextTier: ContextTier = 'medium',
    injectedIds?: Set<string>
  ): Promise<string> {
    try {
      const results = await this.retrieve(workspaceId, promptText, 10)
      if (results.length === 0) return ''

      // Filter out already-injected facts (session dedupe)
      const fresh = injectedIds
        ? results.filter((r) => !injectedIds.has(r.fact.id))
        : results

      if (fresh.length === 0) return ''

      // Budget-cap the output
      const budget = TIER_BUDGETS[contextTier]
      const formatted = this.formatForInjection(fresh, budget)
      if (!formatted) return ''

      // Track which facts were injected
      if (injectedIds) {
        for (const r of fresh) {
          injectedIds.add(r.fact.id)
        }
      }

      // Touch accessed facts
      memoryFactRepository.touchFacts(fresh.map((r) => r.fact.id))

      return formatted
    } catch (err) {
      log.warn('[MemoryRetrieval] getContextForTurn failed:', err)
      return ''
    }
  }

  // ── Hybrid retrieval ────────────────────────────────────────────────────

  /**
   * Retrieve facts by hybrid scoring: cosine + keyword + tier + recency + scope.
   * Falls back to keyword-only when embeddings are offline.
   */
  async retrieve(
    workspaceId: string,
    query: string,
    limit = 20,
    category?: MemoryFactCategory
  ): Promise<MemoryRetrievalResult[]> {
    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return []

    const { candidateMap, queryVec } = await this.gatherCandidates(
      workspaceId,
      query,
      category
    )
    if (candidateMap.size === 0) return []

    // Score each candidate
    const now = Date.now()
    const scored: MemoryRetrievalResult[] = []

    for (const { fact, embeddingVec } of candidateMap.values()) {
      const result = scoreCandidate(fact, embeddingVec, queryVec, queryTokens, query, now)
      if (result) scored.push(result)
    }

    // Sort by score descending, take top N
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  // ── Candidate gathering (extracted for complexity) ─────────────────────

  /**
   * Embed a query string via the OMLX provider.
   * Returns null when embeddings are offline or the provider errors.
   */
  private async embedQuery(query: string): Promise<Float32Array | null> {
    try {
      if (omlxEmbeddingProvider.isReady) {
        const vectors = await omlxEmbeddingProvider.embed([query])
        if (vectors.length > 0 && vectors[0].length > 0) {
          return new Float32Array(vectors[0])
        }
      }
    } catch (err) {
      log.debug('[MemoryRetrieval] Embedding failed, using keyword fallback:', err)
    }
    return null
  }

  /**
   * Build a merged candidate map from embedding + keyword retrieval.
   * Falls back to keyword-only when embeddings are offline.
   */
  private async gatherCandidates(
    workspaceId: string,
    query: string,
    category?: MemoryFactCategory
  ): Promise<{
    candidateMap: Map<string, { fact: MemoryFact; embeddingVec?: Float32Array }>
    queryVec: Float32Array | null
  }> {
    const queryVec = await this.embedQuery(query)

    // Get candidate facts
    const allWithEmbeddings = queryVec
      ? memoryFactRepository.findWithEmbeddings(workspaceId)
      : []
    const keywordCandidates = memoryFactRepository.search(workspaceId, query, 50)

    // Merge candidates by ID (union of both sets)
    const candidateMap = new Map<string, { fact: MemoryFact; embeddingVec?: Float32Array }>()

    for (const { fact, embedding } of allWithEmbeddings) {
      if (category && fact.category !== category) continue
      candidateMap.set(fact.id, { fact, embeddingVec: embedding })
    }
    for (const fact of keywordCandidates) {
      if (category && fact.category !== category) continue
      if (!candidateMap.has(fact.id)) {
        candidateMap.set(fact.id, { fact })
      }
    }

    return { candidateMap, queryVec }
  }

  // ── Formatting ──────────────────────────────────────────────────────────

  /** Format retrieved facts for prompt injection within a character budget. */
  private formatForInjection(results: MemoryRetrievalResult[], budget: number): string | null {
    const lines: string[] = []
    let totalChars = 0

    for (const { fact } of results) {
      const tierLabel = ['T0', 'T1', 'T2', 'T3'][fact.tier] || 'T0'
      const catLabel = fact.category.charAt(0).toUpperCase() + fact.category.slice(1)
      const line = `- [${tierLabel}/${catLabel}] **${sanitizePromptInput(fact.title)}**: ${sanitizePromptInput(fact.content)}`

      if (totalChars + line.length > budget) break
      lines.push(line)
      totalChars += line.length
    }

    if (lines.length === 0) return null
    return lines.join('\n')
  }

  /** Format for MCP tool search response (more detail than injection). */
  formatForToolResponse(results: MemoryRetrievalResult[]): string {
    if (results.length === 0) return 'No relevant facts found.'

    return results
      .map(({ fact, score }) => {
        const tierLabel = ['Observed', 'Confirmed', 'Established', 'Wisdom'][fact.tier]
        return [
          `## ${fact.title}`,
          `**Category**: ${fact.category} | **Tier**: ${tierLabel} (${fact.tier}) | **Confidence**: ${(fact.confidence * 100).toFixed(0)}%`,
          fact.scopePaths.length > 0 ? `**Scope**: ${fact.scopePaths.join(', ')}` : null,
          `**Source**: ${fact.sourceType}${fact.sourceRef ? ` (${fact.sourceRef})` : ''}`,
          '',
          fact.content,
          `\n_Relevance: ${(score * 100).toFixed(0)}% | ID: ${fact.id}_`
        ]
          .filter(Boolean)
          .join('\n')
      })
      .join('\n\n---\n\n')
  }
}

// ── Scoring helpers ─────────────────────────────────────────────────────────

/** Score a single candidate fact. Returns null if below relevance threshold. */
function scoreCandidate(
  fact: MemoryFact,
  embeddingVec: Float32Array | undefined,
  queryVec: Float32Array | null,
  queryTokens: string[],
  query: string,
  now: number
): MemoryRetrievalResult | null {
  const cosineScore =
    queryVec && embeddingVec ? cosineSimilarity(queryVec, embeddingVec) : 0
  const cosineContrib = cosineScore >= COSINE_FLOOR ? cosineScore : 0
  const keywordScore = computeKeywordOverlap(queryTokens, fact)
  const tierBonus = fact.tier / 3
  const recencyScore = computeRecency(fact, now)
  const scopeBonus = computeScopeBoost(query, fact.scopePaths)

  const finalScore =
    cosineContrib * WEIGHT_COSINE +
    keywordScore * WEIGHT_KEYWORD +
    tierBonus * WEIGHT_TIER +
    recencyScore * WEIGHT_RECENCY +
    scopeBonus * WEIGHT_SCOPE

  // Inclusion gate: combined score, cosine alone, or keyword alone
  if (finalScore < RELEVANCE_FLOOR && cosineScore < COSINE_FLOOR && keywordScore <= 0.5) {
    return null
  }

  const matchType = resolveMatchType(cosineContrib, keywordScore)
  return { fact, score: finalScore, matchType }
}

/** Determine how a candidate matched (cosine, keyword, or hybrid). */
function resolveMatchType(
  cosineContrib: number,
  keywordScore: number
): MemoryRetrievalResult['matchType'] {
  if (cosineContrib > 0 && keywordScore > 0) return 'hybrid'
  if (cosineContrib > 0) return 'cosine'
  return 'keyword'
}

/** Tokenize text into lowercase words for keyword matching. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-/.]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2) // skip tiny tokens
}

/** Compute keyword overlap score (0–1). */
function computeKeywordOverlap(queryTokens: string[], fact: MemoryFact): number {
  if (queryTokens.length === 0) return 0

  const factText = `${fact.title} ${fact.content} ${fact.tags.join(' ')}`.toLowerCase()
  let hits = 0
  for (const token of queryTokens) {
    if (factText.includes(token)) hits++
  }
  return hits / queryTokens.length
}

/** Compute recency score (0–1): more recent = higher score. */
function computeRecency(fact: MemoryFact, now: number): number {
  const dateStr = fact.lastAccessedAt || fact.updatedAt || fact.createdAt
  if (!dateStr) return 0.5

  const age = now - new Date(dateStr).getTime()
  const daysOld = age / (1000 * 60 * 60 * 24)

  // Within 7 days: 1.0; 30 days: ~0.75; 90 days: ~0.5; 365 days: ~0.2
  return Math.max(0, 1 - daysOld / 400)
}

/** Compute scope path boost: higher if query mentions paths in fact.scopePaths. */
function computeScopeBoost(query: string, scopePaths: string[]): number {
  if (scopePaths.length === 0) return 0.5 // neutral for unscoped facts
  const queryLower = query.toLowerCase()
  for (const p of scopePaths) {
    if (queryLower.includes(p.toLowerCase())) return 1.0
  }
  return 0
}

export const memoryRetrievalService = new MemoryRetrievalService()
