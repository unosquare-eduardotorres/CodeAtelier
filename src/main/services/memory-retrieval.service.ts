/**
 * MemoryRetrievalService — Hybrid retrieval for per-turn injection and search.
 *
 * Scoring: cosine similarity + keyword overlap + tier bonus + recency +
 * scope_paths boost. Relevance floor filters out irrelevant facts.
 * Keyword-only fallback when embeddings are offline.
 */

import { dbLogger } from '../logger'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import { localEmbeddingProvider } from './local-embedding.provider'
import { sanitizePromptInput } from './sanitize-prompt-input'
import { cosineSimilarity } from './memory-engine.service'
import { anyPathInScope, normalizePath } from './scope-matcher'
import type { MemoryFact, MemoryFactCategory, MemoryRetrievalResult } from '../../shared/types'

const log = dbLogger

// ── Retrieval configuration ─────────────────────────────────────────────────

/** Minimum combined score to include in results. */
const RELEVANCE_FLOOR = 0.4

/** Cosine similarity floor — below this, cosine doesn't count. */
const COSINE_FLOOR = 0.55

/** Score weights */
const WEIGHT_COSINE = 0.5
const WEIGHT_KEYWORD = 0.25
const WEIGHT_TIER = 0.1
const WEIGHT_RECENCY = 0.1
const WEIGHT_SCOPE = 0.05

/**
 * Rank multiplier for a fact whose `scope_paths` cover a file the turn is
 * touching. Scope was 5% of an additive score, which could never lift a
 * genuinely relevant convention past the relevance floor on its own.
 */
const SCOPE_ACTIVATION_MULTIPLIER = 1.5

/**
 * RRF damping constant. 60 is the value from the original Cormack et al.
 * result and the one every mainstream implementation uses; it makes the top
 * few ranks matter without letting rank 1 dominate outright.
 */
const RRF_K = 60

/** Candidates taken from each arm before fusion. */
const ARM_LIMIT = 50

/** Pool retrieved per turn, from which MMR selects. */
const MMR_CANDIDATE_POOL = 30

/** Facts handed to the budget formatter after diversification. */
const MMR_SELECTION_SIZE = 10

/**
 * MMR trade-off. 0.7 keeps relevance dominant — diversity is a tie-breaker
 * among comparably relevant facts, not a reason to inject a worse one.
 */
const MMR_LAMBDA = 0.7

/**
 * Minimum share of query tokens a keyword-only candidate must contain.
 * BM25 ORs the terms, so without this a single common word pulls in the corpus.
 */
const KEYWORD_GATE = 0.5

export type RetrievalScorer = 'rrf' | 'legacy'

/** Scorer selection, overridable for A/B comparison on the eval set. */
function defaultScorer(): RetrievalScorer {
  return process.env.MEMORY_RETRIEVAL_SCORER === 'legacy' ? 'legacy' : 'rrf'
}

/** Established facts are worth more, but tier must not outrank relevance. */
function tierMultiplier(fact: MemoryFact): number {
  return 1 + fact.tier * 0.1
}

/** Recent facts edge out stale ones without ever suppressing them. */
function recencyMultiplier(fact: MemoryFact, now: number): number {
  return 0.8 + 0.4 * computeRecency(fact, now)
}

/** Tier-aware character budgets for per-turn injection. */
const TIER_BUDGETS = {
  small: 1500, // ≤64K context window
  medium: 3000, // ≤128K context window
  large: 5000 // >128K context window
} as const

type ContextTier = keyof typeof TIER_BUDGETS

/** Facts at or above this tier bypass per-session injection dedupe. */
const RE_INJECTABLE_TIER = 2

/**
 * Workspaces whose embedding matrix is held in memory at once.
 *
 * Each matrix is the whole active corpus with its vectors — order 10MB on a
 * mature workspace — so this is deliberately small. Two covers the realistic
 * case of alternating between a project and a scratch workspace.
 */
const EMBEDDING_CACHE_MAX_WORKSPACES = 2

/** A workspace's active facts and their vectors, as of a known mutation point. */
interface EmbeddingMatrix {
  /** `getLastMutationAt` value this snapshot was built from. */
  mutationAt: number
  entries: Array<{ fact: MemoryFact; embedding: Float32Array }>
  byId: Map<string, Float32Array>
}

class MemoryRetrievalService {
  /**
   * Cached embedding matrices, keyed by workspace.
   *
   * `rankByVector` ran `findWithEmbeddings` on every single turn, which reads
   * every active fact *with its BLOB* out of SQLite before computing one
   * cosine per fact. The read is the expensive half and the corpus rarely
   * changes between turns, so it is snapshotted and reused until something
   * actually mutates a fact.
   *
   * `getLastMutationAt` reads MAX(updated_at), which `touchFacts` does not
   * bump — so ordinary retrieval, the thing that runs every turn, does not
   * invalidate the snapshot it just used.
   */
  private embeddingCache = new Map<string, EmbeddingMatrix>()

  /**
   * The workspace's embedding matrix, rebuilt only when a fact has changed.
   *
   * Only ever holds the *current* view. A point-in-time (`asOf`) query asks a
   * different question and is rare, so it reads through to the database rather
   * than polluting this with per-timestamp snapshots.
   */
  private getEmbeddingMatrix(workspaceId: string): EmbeddingMatrix {
    let mutationAt: number
    try {
      mutationAt = memoryFactRepository.getLastMutationAt(workspaceId)
    } catch {
      // Without a liveness signal a cached matrix cannot be trusted.
      return this.buildEmbeddingMatrix(workspaceId, -1, false)
    }

    const cached = this.embeddingCache.get(workspaceId)
    if (cached && cached.mutationAt === mutationAt) return cached

    return this.buildEmbeddingMatrix(workspaceId, mutationAt, true)
  }

  private buildEmbeddingMatrix(
    workspaceId: string,
    mutationAt: number,
    store: boolean
  ): EmbeddingMatrix {
    const entries = memoryFactRepository.findWithEmbeddings(workspaceId)
    const byId = new Map(entries.map((e) => [e.fact.id, e.embedding]))
    const matrix: EmbeddingMatrix = { mutationAt, entries, byId }

    if (!store) return matrix

    // Evict by insertion order before growing past the cap. These snapshots are
    // large enough that an unbounded map is a leak, not a cache.
    if (
      !this.embeddingCache.has(workspaceId) &&
      this.embeddingCache.size >= EMBEDDING_CACHE_MAX_WORKSPACES
    ) {
      const oldest = this.embeddingCache.keys().next().value
      if (oldest !== undefined) this.embeddingCache.delete(oldest)
    }
    this.embeddingCache.set(workspaceId, matrix)
    return matrix
  }

  /** Drop cached vectors. Exposed for tests and for memory-pressure handling. */
  clearEmbeddingCache(workspaceId?: string): void {
    if (workspaceId) this.embeddingCache.delete(workspaceId)
    else this.embeddingCache.clear()
  }
  // ── Per-turn injection ──────────────────────────────────────────────────

  /**
   * Get relevant facts for a turn, formatted for prompt injection.
   * Returns empty string when nothing is relevant (the common case).
   *
   * @param workspaceId — workspace to search
   * @param promptText — the user's prompt to match against
   * @param contextTier — controls character budget
   * @param injectedIds — set of fact IDs already injected this session (mutated in place)
   * @param activePaths — files the turn is actually working on. Retrieval used to
   *   see only the prompt text, so opening `src/billing/Invoice.java` and saying
   *   "fix this bug" surfaced nothing: no billing token appears in the message.
   */
  async getContextForTurn(
    workspaceId: string,
    promptText: string,
    contextTier: ContextTier = 'medium',
    injectedIds?: Set<string>,
    activePaths: string[] = []
  ): Promise<string> {
    try {
      // Retrieve a pool rather than exactly what fits: MMR needs alternatives
      // to choose between, and the budget cap below decides the final count.
      const results = await this.retrieve(
        workspaceId,
        promptText,
        MMR_CANDIDATE_POOL,
        undefined,
        activePaths
      )
      if (results.length === 0) return ''

      // Filter out already-injected facts (session dedupe).
      // Knowledge/Wisdom facts (tier >= 2) are exempt: injectedIds grows
      // monotonically for the whole session, so once history compacts away
      // the original injection the fact would be lost for good. These are
      // precisely the facts worth repeating.
      const fresh = injectedIds
        ? results.filter((r) => r.fact.tier >= RE_INJECTABLE_TIER || !injectedIds.has(r.fact.id))
        : results

      if (fresh.length === 0) return ''

      // Diversify. Ranking by one blended score reliably returns ten
      // paraphrases of the same convention, which wastes the whole budget
      // saying one thing.
      const selected = this.diversify(fresh, MMR_SELECTION_SIZE, workspaceId)

      // Budget-cap the output
      const budget = TIER_BUDGETS[contextTier]
      const formatted = this.formatForInjection(selected, budget)
      if (!formatted) return ''

      // Track which facts were injected
      if (injectedIds) {
        for (const r of selected) {
          injectedIds.add(r.fact.id)
        }
      }

      // Touch accessed facts
      memoryFactRepository.touchFacts(selected.map((r) => r.fact.id))

      return formatted
    } catch (err) {
      log.warn('[MemoryRetrieval] getContextForTurn failed:', err)
      return ''
    }
  }

  // ── Hybrid retrieval ────────────────────────────────────────────────────

  /**
   * Retrieve facts, fusing a vector arm and a BM25 arm.
   *
   * Defaults to Reciprocal Rank Fusion. The previous weighted-sum scorer is
   * still reachable via `scorer: 'legacy'` (or MEMORY_RETRIEVAL_SCORER=legacy)
   * so the two can be compared on the eval set rather than argued about.
   */
  async retrieve(
    workspaceId: string,
    query: string,
    limit = 20,
    category?: MemoryFactCategory,
    activePaths: string[] = [],
    opts?: { scorer?: RetrievalScorer; asOf?: string }
  ): Promise<MemoryRetrievalResult[]> {
    const queryTokens = tokenize(query)
    // Paths named in the message count as active even when the caller passed
    // none — "why does src/db/index.ts do this?" is a scope signal.
    const paths = mergePaths(activePaths, extractPathTokens(query))
    if (queryTokens.length === 0 && paths.length === 0) return []

    const scorer = opts?.scorer ?? defaultScorer()

    if (scorer === 'legacy' && opts?.asOf) {
      // The legacy scorer has no validity-window predicate anywhere in its
      // candidate gathering. Answering a point-in-time question with today's
      // facts and no signal is worse than answering it slowly, so say so.
      log.warn(
        `[MemoryRetrieval] asOf=${opts.asOf} ignored: the legacy scorer cannot ` +
          `answer point-in-time queries. Results reflect current facts.`
      )
    }

    return scorer === 'legacy'
      ? this.retrieveLegacy(workspaceId, query, queryTokens, limit, category, paths)
      : this.retrieveRrf(workspaceId, query, queryTokens, limit, category, paths, opts?.asOf)
  }

  // ── Diversity ──────────────────────────────────────────────────────

  /**
   * Maximal Marginal Relevance re-ranking.
   *
   * Greedily picks the fact maximising
   *   λ·relevance − (1−λ)·max_similarity_to_already_picked
   * so the second slot goes to the best fact that says something *different*
   * from the first, rather than to its closest paraphrase.
   *
   * Facts without an embedding cannot be compared, so they are treated as
   * maximally distinct — which is the safe direction: a fact we cannot prove
   * is redundant should not be dropped for redundancy.
   */
  private diversify(
    results: MemoryRetrievalResult[],
    count: number,
    workspaceId?: string
  ): MemoryRetrievalResult[] {
    if (results.length <= 1 || count <= 1) return results.slice(0, count)

    let embeddings: Map<string, Float32Array>
    try {
      // The vector arm has just loaded every one of these vectors. Re-reading
      // the same ~30 rows out of SQLite to re-rank them was pure duplicate IO.
      const cached = workspaceId ? this.getEmbeddingMatrix(workspaceId).byId : null
      const missing = cached
        ? results.filter((r) => !cached.has(r.fact.id)).map((r) => r.fact.id)
        : results.map((r) => r.fact.id)

      if (cached && missing.length === 0) {
        embeddings = cached
      } else {
        // Facts the snapshot does not cover (an `asOf` result, or one written
        // since it was built) still need a read.
        const fetched = memoryFactRepository.findEmbeddingsByIds(missing)
        embeddings = cached ? new Map([...cached, ...fetched]) : fetched
      }
    } catch (err) {
      log.debug('[MemoryRetrieval] Embedding lookup for MMR failed:', err)
      return results.slice(0, count)
    }
    if (embeddings.size === 0) return results.slice(0, count)

    const maxScore = Math.max(...results.map((r) => r.score)) || 1
    const remaining = [...results]
    const selected: MemoryRetrievalResult[] = []

    // The top-ranked fact is always kept: it is the best answer available, and
    // there is nothing yet for it to be redundant against.
    selected.push(remaining.shift()!)

    while (selected.length < count && remaining.length > 0) {
      let bestIndex = 0
      let bestValue = -Infinity

      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i]
        const relevance = candidate.score / maxScore
        const candidateVec = embeddings.get(candidate.fact.id)

        let maxSim = 0
        if (candidateVec) {
          for (const chosen of selected) {
            const chosenVec = embeddings.get(chosen.fact.id)
            if (!chosenVec) continue
            const sim = cosineSimilarity(candidateVec, chosenVec)
            if (sim > maxSim) maxSim = sim
          }
        }

        const value = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim
        if (value > bestValue) {
          bestValue = value
          bestIndex = i
        }
      }

      selected.push(remaining.splice(bestIndex, 1)[0])
    }

    return selected
  }

  // ── Rank fusion (default) ────────────────────────────────────────────

  /**
   * Reciprocal Rank Fusion over the vector list and the BM25 list.
   *
   * The weighted sum this replaces needed cosine and keyword-overlap scores to
   * be calibrated against each other, and that calibration drifts as the corpus
   * grows. RRF only reads *positions*, so it is scale-free: a fact ranked first
   * by either arm scores 1/(k+0), whatever the underlying units were.
   *
   * Tier, recency and scope stop being co-equal additive terms and become
   * multipliers applied after fusion — they say how much to trust a fact, not
   * how well it matches the query.
   */
  private async retrieveRrf(
    workspaceId: string,
    query: string,
    queryTokens: string[],
    limit: number,
    category: MemoryFactCategory | undefined,
    activePaths: string[],
    asOf?: string
  ): Promise<MemoryRetrievalResult[]> {
    const queryVec = await this.embedQuery(query)

    const vectorArm = this.rankByVector(workspaceId, queryVec, category, asOf)
    const keywordArm = this.rankByKeyword(workspaceId, query, category, asOf)
    if (vectorArm.length === 0 && keywordArm.length === 0) return []

    // Fuse by position.
    const fused = new Map<
      string,
      { fact: MemoryFact; score: number; inVector: boolean; inKeyword: boolean }
    >()

    const contribute = (ranked: MemoryFact[], arm: 'inVector' | 'inKeyword'): void => {
      ranked.forEach((fact, rank) => {
        const entry = fused.get(fact.id) ?? {
          fact,
          score: 0,
          inVector: false,
          inKeyword: false
        }
        entry.score += 1 / (RRF_K + rank)
        entry[arm] = true
        fused.set(fact.id, entry)
      })
    }

    contribute(vectorArm, 'inVector')
    contribute(keywordArm, 'inKeyword')

    // Precision gate. Both arms are recall-oriented — BM25 ORs the query terms,
    // so a single common word drags in unrelated facts. Applied to the fused
    // candidates only (at most a few hundred), never to the whole corpus.
    const now = Date.now()
    const results: MemoryRetrievalResult[] = []

    for (const entry of fused.values()) {
      const activated = anyPathInScope(activePaths, entry.fact.scopePaths)
      const keywordScore = computeKeywordOverlap(queryTokens, entry.fact)

      if (!activated && !entry.inVector && keywordScore < KEYWORD_GATE) continue

      const multiplier =
        tierMultiplier(entry.fact) *
        recencyMultiplier(entry.fact, now) *
        (activated ? SCOPE_ACTIVATION_MULTIPLIER : 1)

      results.push({
        fact: entry.fact,
        score: entry.score * multiplier,
        matchType: resolveMatchType(entry.inVector ? 1 : 0, keywordScore)
      })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  /** Facts ordered by cosine similarity, best first. */
  private rankByVector(
    workspaceId: string,
    queryVec: Float32Array | null,
    category?: MemoryFactCategory,
    asOf?: string
  ): MemoryFact[] {
    if (!queryVec) return []

    // `asOf` reads through: it is a different result set and a rare query.
    const source = asOf
      ? memoryFactRepository.findWithEmbeddings(workspaceId, asOf)
      : this.getEmbeddingMatrix(workspaceId).entries

    const scored: Array<{ fact: MemoryFact; cosine: number }> = []
    for (const { fact, embedding } of source) {
      if (category && fact.category !== category) continue
      const cosine = cosineSimilarity(queryVec, embedding)
      if (cosine >= COSINE_FLOOR) scored.push({ fact, cosine })
    }

    scored.sort((a, b) => b.cosine - a.cosine)
    return scored.slice(0, ARM_LIMIT).map((s) => s.fact)
  }

  /** Facts ordered by BM25, best first. */
  private rankByKeyword(
    workspaceId: string,
    query: string,
    category?: MemoryFactCategory,
    asOf?: string
  ): MemoryFact[] {
    return memoryFactRepository
      .searchFts(workspaceId, query, ARM_LIMIT, asOf)
      .map((r) => r.fact)
      .filter((fact) => !category || fact.category === category)
  }

  // ── Legacy weighted-sum scorer (kept for comparison) ────────────────────

  private async retrieveLegacy(
    workspaceId: string,
    query: string,
    queryTokens: string[],
    limit: number,
    category: MemoryFactCategory | undefined,
    activePaths: string[]
  ): Promise<MemoryRetrievalResult[]> {
    const { candidateMap, queryVec } = await this.gatherCandidates(workspaceId, query, category)
    if (candidateMap.size === 0) return []

    const now = Date.now()
    const scored: MemoryRetrievalResult[] = []

    for (const { fact, embeddingVec } of candidateMap.values()) {
      const result = scoreCandidate(
        fact,
        embeddingVec,
        queryVec,
        queryTokens,
        query,
        now,
        activePaths
      )
      if (result) scored.push(result)
    }

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
      if (localEmbeddingProvider.isReady) {
        const vectors = await localEmbeddingProvider.embed([query])
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
    const allWithEmbeddings = queryVec ? memoryFactRepository.findWithEmbeddings(workspaceId) : []
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
  now: number,
  activePaths: string[] = []
): MemoryRetrievalResult | null {
  const cosineScore = queryVec && embeddingVec ? cosineSimilarity(queryVec, embeddingVec) : 0
  const cosineContrib = cosineScore >= COSINE_FLOOR ? cosineScore : 0
  const keywordScore = computeKeywordOverlap(queryTokens, fact)
  const tierBonus = fact.tier / 3
  const recencyScore = computeRecency(fact, now)

  // Hard activation: a fact whose declared scope covers a file this turn is
  // touching is on-topic by construction, whatever the wording of the message.
  // It bypasses the relevance floor and is ranked above merely-similar facts.
  const activated = anyPathInScope(activePaths, fact.scopePaths)
  const scopeBonus = activated ? 1 : computeScopeBoost(query, fact.scopePaths)

  const baseScore =
    cosineContrib * WEIGHT_COSINE +
    keywordScore * WEIGHT_KEYWORD +
    tierBonus * WEIGHT_TIER +
    recencyScore * WEIGHT_RECENCY +
    scopeBonus * WEIGHT_SCOPE

  const finalScore = activated ? baseScore * SCOPE_ACTIVATION_MULTIPLIER : baseScore

  // Inclusion gate: scope activation, combined score, cosine alone, or keyword alone
  if (
    !activated &&
    finalScore < RELEVANCE_FLOOR &&
    cosineScore < COSINE_FLOOR &&
    keywordScore <= 0.5
  ) {
    return null
  }

  const matchType = resolveMatchType(cosineContrib, keywordScore)
  return { fact, score: finalScore, matchType }
}

/**
 * Paths mentioned in free text.
 *
 * Two shapes count: anything with a separator (`src/db/index.ts`, `src/db/`)
 * and a bare filename with a source-code extension (`Invoice.java`). Prose
 * words and decimals must not qualify, or every fact would activate.
 */
export function extractPathTokens(text: string): string[] {
  const out: string[] = []

  const withSeparator = /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.-]+)+/g
  for (const m of text.matchAll(withSeparator)) out.push(m[0])

  const bareFile =
    /\b[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|mjs|cjs|java|py|go|rb|cs|php|rs|swift|kt|scala|c|cc|cpp|h|hpp|sql|md|mdx|ya?ml|json|toml|ini|sh|ps1|xml|gradle|proto)\b/g
  for (const m of text.matchAll(bareFile)) out.push(m[0])

  return [...new Set(out.map((p) => normalizePath(p.replace(/[.,;:)\]]+$/, ''))))].filter(Boolean)
}

/** Union two path lists, normalised and deduplicated. */
function mergePaths(a: string[], b: string[]): string[] {
  const out = new Set<string>()
  for (const p of [...a, ...b]) {
    const normalized = normalizePath(p)
    if (normalized) out.add(normalized)
  }
  return [...out]
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

/**
 * Compute recency score (0–1): more recent = higher score.
 *
 * Reads `observedAt` — when the source stated the fact — in preference to
 * `updatedAt`. A dedup merge or a tier promotion bumps `updated_at`, which made
 * an ancient convention score as though it had just been written; and a fact
 * mined from a 2011 commit should rank as 2011, not as its ingestion date.
 */
function computeRecency(fact: MemoryFact, now: number): number {
  const dateStr = fact.lastAccessedAt || fact.observedAt || fact.updatedAt || fact.createdAt
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
