/**
 * MemoryEngineService — Write pipeline for the knowledge-aware memory engine.
 *
 * Mem0-inspired write path: embed → top-5 cosine similarity → classify
 * (ADD / UPDATE / NOOP / SUPERSEDE) → persist with evidence-based promotion.
 *
 * Key improvements over the original pipeline:
 *   - Compares against top-5 matches (not top-1)
 *   - Classifier returns ADD/UPDATE/NOOP/SUPERSEDE (not just dup/contradiction/distinct)
 *   - UPDATE rewrites existing fact in-place (no near-duplicate insertion)
 *   - Ambiguous writes are queued instead of silently inserted when classifier is busy
 *   - Volatile facts (version numbers, counts) always UPDATE-in-place
 *   - Evidence-based promotion with day-spread + source diversity requirements
 *   - Capture caps: max facts per session/commit (background auto-capture only)
 *   - Title-based fallback dedup when embedding model isn't available
 */

import { dbLogger } from '../logger'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import { localEmbeddingProvider } from './local-embedding.provider'
import { modelConfigService, resolveAssignment, buildResolveOpts } from './model-config.service'
import { runOneShotLocal, buildMemoryFeedFallbackArgs } from './one-shot-local'
import { DEFAULT_MODEL_CONFIG } from '../../shared/constants'
import { spawn } from 'node:child_process'
import { buildEnvWithPath } from './env-utils'
import type {
  MemoryFact,
  MemoryFactCategory,
  MemoryFactTier,
  MemorySourceType,
  ConfirmationSourceType
} from '../../shared/types'

const log = dbLogger

// ── Similarity thresholds ───────────────────────────────────────────────────
const DUPLICATE_THRESHOLD = 0.90
/** Relaxed threshold used during bootstrap so related-but-distinct facts survive. */
const BOOTSTRAP_DUPLICATE_THRESHOLD = 0.93
const AMBIGUOUS_THRESHOLD = 0.82 // raised from 0.70 — reduces false-positive LLM classifier calls
const AUTO_MERGE_THRESHOLD = 0.95
const TOP_K_MATCHES = 5

// ── Decay settings ──────────────────────────────────────────────────────────
const DECAY_DAYS_THRESHOLD = 30
const DECAY_CONFIDENCE_DELTA = 0.15
const DECAY_THROTTLE_MS = 24 * 60 * 60 * 1000 // 24h

// ── Capture caps ────────────────────────────────────────────────────────────
const MAX_FACTS_PER_SESSION = 2 // lowered from 3 — quality over quantity
const MAX_FACTS_PER_COMMIT = 1 // lowered from 2 — one key insight per commit

// ── Volatility detection patterns ───────────────────────────────────────────
const VOLATILE_PATTERNS = [
  /schema[_\s]?version/i,
  /CURRENT_SCHEMA_VERSION/,
  /electron[_\s]?version/i,
  /electronVersion/,
  /build\.electronVersion/,
  /database\.schemaVersion/,
  /\bversion[:\s]+\d+/i,
  /\bv\d+\.\d+\.\d+/
]

/** Parameters for writing a new fact through the engine pipeline. */
export interface WriteFactParams {
  workspaceId: string | null
  category: MemoryFactCategory
  title: string
  content: string
  tags?: string[]
  scopePaths?: string[]
  sourceType: MemorySourceType
  sourceRef?: string | null
  workspacePath?: string | null
}

// ── Capture cap tracking ────────────────────────────────────────────────────

interface CaptureCounts {
  session: Map<string, number> // sourceRef → count
  commit: Map<string, number>
}

class MemoryEngineService {
  private lastDecayRun = 0
  private classifyQueue: Array<{
    params: WriteFactParams
    embedding: Buffer
    factText: string
    workspaceId: string
    sourceType: MemorySourceType
    resolve: (fact: MemoryFact | null | undefined) => void
    reject: (err: Error) => void
  }> = []
  private classifyProcessing = false
  private draining = false

  private captureCounts: CaptureCounts = {
    session: new Map(),
    commit: new Map()
  }

  /** True while a bootstrap / Deep Scan job is running. */
  private bootstrapActive = false

  /**
   * Toggled by MemoryBootstrapService around a bootstrap job. While active,
   * agent-recorded ('tool') facts get the same relaxed dedup threshold as
   * 'bootstrap' facts — a large legacy corpus produces many genuinely distinct
   * facts that still sit above 0.90 cosine.
   */
  setBootstrapActive(active: boolean): void {
    this.bootstrapActive = active
  }

  /** Dedup threshold for a source type, relaxed during bootstrap jobs. */
  private resolveDupThreshold(sourceType: MemorySourceType): number {
    if (sourceType === 'bootstrap') return BOOTSTRAP_DUPLICATE_THRESHOLD
    if (sourceType === 'tool' && this.bootstrapActive) return BOOTSTRAP_DUPLICATE_THRESHOLD
    return DUPLICATE_THRESHOLD
  }

  // ── Write pipeline ──────────────────────────────────────────────────────

  /**
   * Main entry point: write a fact through the dedup/contradiction pipeline.
   * Returns the created or confirmed fact, or null if capped/deduped as NOOP.
   */
  async writeFact(params: WriteFactParams): Promise<MemoryFact | null> {
    const { workspaceId } = params
    const factText = `${params.title}\n${params.content}`

    // 1. Detect volatility
    const isVolatile = this.detectVolatility(factText)

    // 2. Try to embed
    let embedding: Buffer | null = null
    let embeddingPending = true
    try {
      if (localEmbeddingProvider.isReady) {
        const vectors = await localEmbeddingProvider.embed([factText])
        if (vectors.length > 0 && vectors[0].length > 0) {
          embedding = Buffer.from(new Float32Array(vectors[0]).buffer)
          embeddingPending = false
        }
      }
    } catch (err) {
      log.warn('[MemoryEngine] Embedding failed, saving as pending:', err)
    }

    // 3. If we have an embedding and a workspace, run similarity check.
    //    Similarity pipeline runs BEFORE the capture cap so that dedup confirms,
    //    updates, and contradiction records succeed even on busy days. The cap
    //    only gates brand-new fact inserts (step 4).
    if (embedding && workspaceId) {
      const result = await this.runSimilarityPipeline(
        workspaceId,
        params,
        embedding,
        factText,
        isVolatile
      )
      if (result !== undefined) {
        // Pipeline handled it (confirmed, updated, nooped, or superseded).
        // Cap accounting is inside the mutating handlers (handleUpdate, handleContradiction)
        // so that dedup confirms (handleDuplicate) don't consume cap slots.
        return result
      }
    }

    // 3b. Fallback dedup when embedding pipeline was skipped:
    //     Normalized title match against existing active facts.
    //     Prevents duplicate avalanche when embedding provider isn't ready.
    if (!embedding && workspaceId) {
      const existingMatch = this.titleFallbackDedup(workspaceId, params.title, params.category)
      if (existingMatch) {
        log.info(`[MemoryEngine] Title-fallback dedup: "${params.title}" matches existing ${existingMatch.id}`)
        return this.handleDuplicate(existingMatch, params.sourceType)
      }
    }

    // 4. No match or no embedding — insert as new fact.
    //    Capture cap only gates new-fact creation, not re-confirmations above.
    if (!this.checkCaptureCap(params)) {
      log.debug(`[MemoryEngine] Capture cap reached for ${params.sourceType}/${params.sourceRef}, skipping new fact`)
      return null
    }

    const fact = memoryFactRepository.createFact({
      workspaceId: params.workspaceId,
      category: params.category,
      title: params.title,
      content: params.content,
      tags: params.tags,
      scopePaths: params.scopePaths,
      sourceType: params.sourceType,
      sourceRef: params.sourceRef ?? null,
      embedding,
      embeddingPending
    })

    // Mark volatile facts
    if (isVolatile) {
      memoryFactRepository.setVolatile(fact.id, true)
    }

    log.info(`[MemoryEngine] New fact created: ${fact.id} (tier=${fact.tier}, pending=${embeddingPending}, volatile=${isVolatile})`)

    // 5. Do NOT record a confirmation at creation — the fact starts at T0 and must
    // earn its first confirmation through a separate re-observation event.
    // This preserves the "3 confirms on 3 days" requirement for T0→T1.

    this.incrementCaptureCap(params)

    // 6. Opportunistic backfill of other pending facts
    this.backfillPendingEmbeddings().catch((e) =>
      log.warn('[MemoryEngine] Background backfill error:', e)
    )

    // Return with accurate volatile flag (setVolatile mutated DB but not the object)
    return isVolatile ? { ...fact, volatile: true } : fact
  }

  /**
   * Similarity pipeline: compare against top-5 existing facts.
   * Returns a MemoryFact if handled, null for NOOP, undefined if should insert new.
   */
  private async runSimilarityPipeline(
    workspaceId: string,
    params: WriteFactParams,
    embedding: Buffer,
    factText: string,
    isVolatile: boolean
  ): Promise<MemoryFact | null | undefined> {
    const queryVec = new Float32Array(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength / 4
    )

    const candidates = memoryFactRepository.findWithEmbeddings(workspaceId)
    if (candidates.length === 0) return undefined

    // Compute cosine similarities and take top-K
    const scored = candidates
      .map(({ fact, embedding: existingVec }) => ({
        fact,
        similarity: cosineSimilarity(queryVec, existingVec)
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, TOP_K_MATCHES)

    const topMatch = scored[0]
    if (!topMatch || topMatch.similarity < AMBIGUOUS_THRESHOLD) {
      return undefined // New fact territory
    }

    // During bootstrap, raise the dedup threshold slightly to avoid
    // over-merging related facts from the same knowledge domain
    const effectiveDupThreshold = this.resolveDupThreshold(params.sourceType)

    // Volatile facts: UPDATE-in-place only when similarity is high AND same category.
    // At 0.70 two different volatile facts (e.g. schemaVersion vs electronVersion) can
    // easily match — require ≥0.90 + same category to prevent cross-fact data loss.
    if (
      isVolatile &&
      topMatch.similarity >= effectiveDupThreshold &&
      topMatch.fact.category === params.category
    ) {
      return this.handleUpdate(topMatch.fact, params, embedding)
    }

    // ≥0.95 — auto-merge (no classifier needed)
    if (topMatch.similarity >= AUTO_MERGE_THRESHOLD) {
      return this.handleDuplicate(topMatch.fact, params.sourceType)
    }

    // ≥effectiveDupThreshold — duplicate
    if (topMatch.similarity >= effectiveDupThreshold) {
      return this.handleDuplicate(topMatch.fact, params.sourceType)
    }

    // ambiguous band → Mem0-style classification
    return this.classifyAmbiguous(topMatch.fact, params, factText, embedding, scored)
  }

  /** Confirm an existing fact as a duplicate hit. */
  private handleDuplicate(existing: MemoryFact, sourceType: MemorySourceType): MemoryFact {
    const confirmType = this.sourceTypeToConfirmationType(sourceType)
    return this.confirmFactWithEvidence(existing, confirmType)
  }

  /** UPDATE: rewrite existing fact's content in-place (Mem0-style). */
  private handleUpdate(
    existing: MemoryFact,
    newParams: WriteFactParams,
    embedding: Buffer
  ): MemoryFact {
    const updated = memoryFactRepository.updateFactInPlace(existing.id, {
      title: newParams.title,
      content: newParams.content,
      tags: newParams.tags,
      scopePaths: newParams.scopePaths
    })

    // Update embedding to match new content
    memoryFactRepository.setEmbedding(existing.id, embedding)

    // Record confirmation AND bump confirmation_count/last_confirmed_at + tier
    const confirmType = this.sourceTypeToConfirmationType(newParams.sourceType)
    const confirmed = this.confirmFactWithEvidence(updated, confirmType)

    // Consume a capture-cap slot — this is a real mutation (content rewrite)
    this.incrementCaptureCap(newParams)

    log.info(
      `[MemoryEngine] Updated in-place: ${existing.id} (volatile=${existing.volatile})`
    )
    return confirmed
  }

  /**
   * Mem0-style classification: determine ADD / UPDATE / NOOP / SUPERSEDE.
   * Queues the request if classifier is busy (never falls through to insert).
   */
  private async classifyAmbiguous(
    bestMatch: MemoryFact,
    newParams: WriteFactParams,
    _newText: string,
    embedding: Buffer,
    topMatches: Array<{ fact: MemoryFact; similarity: number }>
  ): Promise<MemoryFact | null | undefined> {
    // Build context from top matches for classifier
    const matchContext = topMatches
      .slice(0, 3)
      .map((m, i) => `Match ${i + 1} (similarity: ${m.similarity.toFixed(3)}):\n  Title: ${m.fact.title}\n  Content: ${m.fact.content}`)
      .join('\n\n')

    const prompt = `You are a knowledge base curator. A new fact is being proposed. Compare it against the existing facts and decide what to do.

EXISTING FACTS:
${matchContext}

NEW FACT:
Title: ${newParams.title}
Content: ${newParams.content}
Category: ${newParams.category}

Respond with EXACTLY one word: "ADD", "UPDATE", "NOOP", or "SUPERSEDE".
- "ADD" = the new fact covers a genuinely new topic not in the existing facts
- "UPDATE" = the new fact is an updated version of Match 1 (same topic, newer info) — rewrite Match 1 with this content
- "NOOP" = the new fact says the same thing as an existing fact — skip it
- "SUPERSEDE" = the new fact contradicts Match 1 — replace it`

    // Queue instead of falling through when busy (include draining to prevent
    // concurrent classifiers during the microtask window between one classification's
    // finally block and the drain loop's next await)
    if (this.classifyProcessing || this.draining) {
      return new Promise<MemoryFact | null | undefined>((resolve, reject) => {
        this.classifyQueue.push({
          params: newParams,
          embedding,
          factText: _newText,
          workspaceId: newParams.workspaceId!,
          sourceType: newParams.sourceType,
          resolve,
          reject
        })
        // drainClassifyQueue will be called from executeClassification's finally block
      })
    }

    return this.executeClassification(prompt, bestMatch, newParams, embedding)
  }

  /** Execute a single classification and apply the result. */
  private async executeClassification(
    prompt: string,
    bestMatch: MemoryFact,
    newParams: WriteFactParams,
    embedding: Buffer
  ): Promise<MemoryFact | null | undefined> {
    try {
      this.classifyProcessing = true

      const classification = await this.spawnClassifier(
        prompt,
        newParams.workspacePath ?? undefined,
        newParams.workspaceId ?? undefined
      )
      const normalized = classification.trim().toUpperCase()

      switch (normalized) {
        case 'NOOP':
          log.info(`[MemoryEngine] NOOP: new fact is duplicate of ${bestMatch.id}`)
          // Still record a confirmation for the existing fact
          this.confirmFactWithEvidence(bestMatch, 'auto_dedup')
          return null

        case 'UPDATE':
          return this.handleUpdate(bestMatch, newParams, embedding)

        case 'SUPERSEDE':
          return this.handleContradiction(bestMatch, newParams, embedding)

        case 'ADD':
        default:
          // Fall through to insert new
          return undefined
      }
    } catch (err) {
      log.warn('[MemoryEngine] Classification failed, queuing as pending:', err)
      // On failure, insert as new but with lower confidence
      return undefined
    } finally {
      this.classifyProcessing = false
      this.drainClassifyQueue()
    }
  }

  /**
   * Process queued classification requests one at a time.
   * Loops until the queue is empty so no queued promise hangs forever.
   * Each item gets fresh similarity scoring and a real classifier prompt.
   */
  private async drainClassifyQueue(): Promise<void> {
    if (this.draining || this.classifyProcessing || this.classifyQueue.length === 0) return

    this.draining = true
    try {
    while (this.classifyQueue.length > 0) {
      const item = this.classifyQueue.shift()!

      try {
        // Re-compute similarity against current embeddings (fresh, not stale)
        const candidates = memoryFactRepository.findWithEmbeddings(item.workspaceId)
        const queryVec = new Float32Array(
          item.embedding.buffer,
          item.embedding.byteOffset,
          item.embedding.byteLength / 4
        )
        const scored = candidates
          .map(({ fact, embedding: existingVec }) => ({
            fact,
            similarity: cosineSimilarity(queryVec, existingVec)
          }))
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, TOP_K_MATCHES)

        const bestMatch = scored[0]
        if (!bestMatch || bestMatch.similarity < AMBIGUOUS_THRESHOLD) {
          // No match — resolve undefined so writeFact inserts as new
          item.resolve(undefined)
          continue
        }

        // Fast-path: mirror the pipeline's branch order to skip the LLM classifier
        // when fresh similarity is high enough for a deterministic outcome.
        const isVolatile = this.detectVolatility(item.factText)
        const effectiveDupThreshold = this.resolveDupThreshold(item.sourceType)
        if (
          isVolatile &&
          bestMatch.similarity >= effectiveDupThreshold &&
          bestMatch.fact.category === item.params.category
        ) {
          item.resolve(this.handleUpdate(bestMatch.fact, item.params, item.embedding))
          continue
        }
        if (bestMatch.similarity >= AUTO_MERGE_THRESHOLD) {
          item.resolve(this.handleDuplicate(bestMatch.fact, item.params.sourceType))
          continue
        }
        if (bestMatch.similarity >= effectiveDupThreshold) {
          item.resolve(this.handleDuplicate(bestMatch.fact, item.params.sourceType))
          continue
        }

        // Build the real prompt with actual match context
        const matchContext = scored
          .slice(0, 3)
          .map(
            (m, i) =>
              `Match ${i + 1} (similarity: ${m.similarity.toFixed(3)}):\n  Title: ${m.fact.title}\n  Content: ${m.fact.content}`
          )
          .join('\n\n')

        const prompt = `You are a knowledge base curator. A new fact is being proposed. Compare it against the existing facts and decide what to do.

EXISTING FACTS:
${matchContext}

NEW FACT:
Title: ${item.params.title}
Content: ${item.params.content}
Category: ${item.params.category}

Respond with EXACTLY one word: "ADD", "UPDATE", "NOOP", or "SUPERSEDE".
- "ADD" = the new fact covers a genuinely new topic not in the existing facts
- "UPDATE" = the new fact is an updated version of Match 1 (same topic, newer info) — rewrite Match 1 with this content
- "NOOP" = the new fact says the same thing as an existing fact — skip it
- "SUPERSEDE" = the new fact contradicts Match 1 — replace it`

        const result = await this.executeClassification(
          prompt,
          bestMatch.fact,
          item.params,
          item.embedding
        )
        item.resolve(result as MemoryFact | null | undefined)
      } catch (err) {
        item.reject(err as Error)
      }
    }
    } finally {
      this.draining = false
    }
  }

  /** Handle a contradiction: supersede old fact, insert new, record audit. */
  private handleContradiction(
    oldFact: MemoryFact,
    newParams: WriteFactParams,
    embedding?: Buffer
  ): MemoryFact {
    // Insert the new fact with the already-computed embedding
    const newFact = memoryFactRepository.createFact({
      workspaceId: newParams.workspaceId,
      category: newParams.category,
      title: newParams.title,
      content: newParams.content,
      tags: newParams.tags,
      scopePaths: newParams.scopePaths,
      sourceType: newParams.sourceType,
      sourceRef: newParams.sourceRef ?? null,
      tier: Math.max(0, oldFact.tier) as MemoryFactTier, // inherit tier floor
      confidence: 0.5,
      embedding: embedding ?? null,
      embeddingPending: !embedding
    })

    // Supersede the old fact
    memoryFactRepository.supersedeFact(oldFact.id, newFact.id)

    // Record the contradiction for UI review (ON CONFLICT DO NOTHING — idempotent)
    memoryFactRepository.createContradiction({
      oldFactId: oldFact.id,
      newFactId: newFact.id,
      status: 'auto_resolved',
      resolution: `New fact "${newFact.title}" superseded "${oldFact.title}"`
    })

    // Consume a capture-cap slot — this is a real mutation (new fact inserted + old superseded)
    this.incrementCaptureCap(newParams)

    log.info(
      `[MemoryEngine] Contradiction: ${oldFact.id} superseded by ${newFact.id}`
    )
    return newFact
  }

  // ── Evidence-based promotion ───────────────────────────────────────────

  /**
   * Confirm a fact with automatic tier promotion.
   * This is the single entry point for UI confirms, MCP tool confirms,
   * and internal dedup confirms — all paths compute promotion.
   */
  confirmFactWithPromotion(factId: string, sourceType: ConfirmationSourceType = 'human'): MemoryFact {
    const existing = memoryFactRepository.findById(factId)
    if (!existing) throw new Error(`MemoryFact not found: ${factId}`)
    return this.confirmFactWithEvidence(existing, sourceType)
  }

  /** Core confirmation logic with evidence-based promotion. */
  private confirmFactWithEvidence(fact: MemoryFact, sourceType: ConfirmationSourceType): MemoryFact {
    // Record the confirmation event
    // auto_dedup only records the event for audit — zero weight prevents
    // repetition from inflating tier promotions (dedup ≠ independent evidence)
    const weight = sourceType === 'auto_dedup' ? 0.0 : 1.0
    memoryFactRepository.addConfirmation(fact.id, sourceType, weight)

    // Compute new tier based on evidence
    const newTier = this.computePromotionTier(fact)

    return memoryFactRepository.confirmFact(fact.id, newTier)
  }

  /** Compute the new tier after a confirmation, using evidence-based rules. */
  private computePromotionTier(fact: MemoryFact): MemoryFactTier {
    // Volatile facts (version numbers, counts) never promote — they are
    // current-state snapshots, not knowledge. Capped at T0.
    if (fact.volatile) {
      return 0 as MemoryFactTier
    }

    const confirmations = memoryFactRepository.getConfirmations(fact.id)
    return computePromotionTierPure(fact.tier, fact.confidence, confirmations)
  }

  // ── Capture caps ──────────────────────────────────────────────────────

  /** Check if a write is within capture caps. Returns true if allowed. */
  private checkCaptureCap(params: WriteFactParams): boolean {
    // User-initiated and agent-driven writes always bypass per-source caps
    if (['manual', 'tool', 'bootstrap', 'blueprint', 'grill'].includes(params.sourceType)) return true

    const { sourceType, sourceRef } = params

    // Per-source caps (background auto-capture quality gates)
    if (sourceType === 'session' && sourceRef) {
      const count = this.captureCounts.session.get(sourceRef) ?? 0
      if (count >= MAX_FACTS_PER_SESSION) return false
    }
    if (sourceType === 'commit' && sourceRef) {
      const count = this.captureCounts.commit.get(sourceRef) ?? 0
      if (count >= MAX_FACTS_PER_COMMIT) return false
    }

    return true
  }

  /** Increment capture counters after a successful write. */
  private incrementCaptureCap(params: WriteFactParams): void {
    const { sourceType, sourceRef } = params

    if (sourceType === 'session' && sourceRef) {
      this.captureCounts.session.set(sourceRef, (this.captureCounts.session.get(sourceRef) ?? 0) + 1)
    }
    if (sourceType === 'commit' && sourceRef) {
      this.captureCounts.commit.set(sourceRef, (this.captureCounts.commit.get(sourceRef) ?? 0) + 1)
    }
  }

  // ── Title-based fallback dedup ───────────────────────────────────────

  /**
   * Lightweight title-based dedup fallback for when embeddings aren't available.
   * Normalizes titles (lowercase, trim, collapse whitespace) and checks for:
   *   1. Exact normalized title match (same category)
   *   2. Token overlap ≥ 80% (same category) — catches minor rephrasing
   * Returns the matching fact or null.
   */
  private titleFallbackDedup(
    workspaceId: string,
    newTitle: string,
    newCategory: string
  ): MemoryFact | null {
    const normalize = (t: string): string =>
      t.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '')

    const newNorm = normalize(newTitle)
    if (newNorm.length < 5) return null // too short to match reliably

    const newTokens = new Set(newNorm.split(' ').filter(t => t.length > 2))
    if (newTokens.size === 0) return null

    const existing = memoryFactRepository.findByWorkspace(workspaceId, 'active')

    for (const fact of existing) {
      if (fact.category !== newCategory) continue

      const existingNorm = normalize(fact.title)

      // 1. Exact match
      if (existingNorm === newNorm) return fact

      // 2. Token overlap ≥ 80%
      const existingTokens = new Set(existingNorm.split(' ').filter(t => t.length > 2))
      if (existingTokens.size === 0) continue

      const intersection = [...newTokens].filter(t => existingTokens.has(t)).length
      const union = new Set([...newTokens, ...existingTokens]).size
      const jaccard = union > 0 ? intersection / union : 0

      if (jaccard >= 0.80) return fact
    }

    return null
  }

  // ── Volatility detection ──────────────────────────────────────────────

  /** Check if a fact's content matches volatile patterns (versions, counts). */
  private detectVolatility(text: string): boolean {
    return VOLATILE_PATTERNS.some((pattern) => pattern.test(text))
  }

  /** Map memory source types to confirmation source types. */
  private sourceTypeToConfirmationType(sourceType: MemorySourceType): ConfirmationSourceType {
    switch (sourceType) {
      case 'manual':
        return 'human'
      case 'tool':
        return 'tool'
      case 'session':
      case 'commit':
      case 'document':
      case 'claude-md':
      case 'blueprint':
      case 'grill':
      case 'bootstrap':
        return 'extraction'
      default:
        return 'auto_dedup'
    }
  }

  // ── Decay sweep ─────────────────────────────────────────────────────────

  /** Run the decay sweep if enough time has passed since the last run. */
  runDecaySweepIfDue(): void {
    const now = Date.now()
    if (now - this.lastDecayRun < DECAY_THROTTLE_MS) return

    try {
      const stale = memoryFactRepository.findStale(DECAY_DAYS_THRESHOLD)
      if (stale.length > 0) {
        const ids = stale.map((f) => f.id)
        memoryFactRepository.decayFacts(ids, DECAY_CONFIDENCE_DELTA)
        log.info(`[MemoryEngine] Decay sweep: ${ids.length} facts decayed`)
      }
      this.lastDecayRun = now
    } catch (err) {
      log.warn('[MemoryEngine] Decay sweep failed:', err)
    }
  }

  // ── Embedding backfill ──────────────────────────────────────────────────

  /** Embed a single batch of up to 50 pending facts (opportunistic background path). */
  async backfillPendingEmbeddings(): Promise<number> {
    if (!localEmbeddingProvider.isReady) return 0

    const pending = memoryFactRepository.findPendingEmbeddings(50)
    if (pending.length === 0) return 0

    let backfilled = 0
    for (const fact of pending) {
      try {
        const text = `${fact.title}\n${fact.content}`
        const vectors = await localEmbeddingProvider.embed([text])
        if (vectors.length > 0 && vectors[0].length > 0) {
          const buf = Buffer.from(new Float32Array(vectors[0]).buffer)
          memoryFactRepository.setEmbedding(fact.id, buf)
          backfilled++
        }
      } catch (err) {
        log.warn(`[MemoryEngine] Backfill failed for fact ${fact.id}:`, err)
        break // Don't hammer a failing provider
      }
    }

    if (backfilled > 0) {
      log.info(`[MemoryEngine] Backfilled ${backfilled}/${pending.length} embeddings`)
    }
    return backfilled
  }

  /** Embed ALL pending facts in batches of 50, reporting progress per fact. */
  async backfillAllPendingEmbeddings(
    onProgress?: (processed: number, total: number) => void
  ): Promise<number> {
    if (!localEmbeddingProvider.isReady) return 0

    // Count total pending up front for progress reporting
    const allPending = memoryFactRepository.findPendingEmbeddings(10_000)
    const total = allPending.length
    if (total === 0) return 0

    let processed = 0
    let batch: ReturnType<typeof memoryFactRepository.findPendingEmbeddings>

    // Process in batches of 50 until no more pending
    while ((batch = memoryFactRepository.findPendingEmbeddings(50)).length > 0) {
      for (const fact of batch) {
        try {
          const text = `${fact.title}\n${fact.content}`
          const vectors = await localEmbeddingProvider.embed([text])
          if (vectors.length > 0 && vectors[0].length > 0) {
            const buf = Buffer.from(new Float32Array(vectors[0]).buffer)
            memoryFactRepository.setEmbedding(fact.id, buf)
          }
        } catch (err) {
          log.warn(`[MemoryEngine] Backfill failed for fact ${fact.id}:`, err)
          // Report final progress before returning on provider failure
          onProgress?.(processed, total)
          log.info(`[MemoryEngine] Backfill stopped after ${processed}/${total} embeddings (provider failure)`)
          return processed
        }
        processed++
        onProgress?.(processed, total)
      }
    }

    log.info(`[MemoryEngine] Backfilled all ${processed}/${total} embeddings`)
    return processed
  }

  // ── Dedup scan ─────────────────────────────────────────────────

  /**
   * Cluster-based dedup scan: build connected components at ≥0.90 cosine,
   * emit one review item per cluster (not per pair). Auto-merge ≥0.95.
   */
  scanForDuplicates(workspaceId: string): { clustersFound: number; autoMerged: number } {
    const embedded = memoryFactRepository.findWithEmbeddings(workspaceId)
    if (embedded.length < 2) return { clustersFound: 0, autoMerged: 0 }

    // Build adjacency list for connected components
    const THRESHOLD = 0.90
    const adjacency = new Map<number, Set<number>>()
    const pairSimilarities = new Map<string, number>()

    for (let i = 0; i < embedded.length; i++) {
      for (let j = i + 1; j < embedded.length; j++) {
        const sim = cosineSimilarity(embedded[i].embedding, embedded[j].embedding)
        if (sim >= THRESHOLD) {
          if (!adjacency.has(i)) adjacency.set(i, new Set())
          if (!adjacency.has(j)) adjacency.set(j, new Set())
          adjacency.get(i)!.add(j)
          adjacency.get(j)!.add(i)
          pairSimilarities.set(`${i}-${j}`, sim)
        }
      }
    }

    // Find connected components (clusters)
    const visited = new Set<number>()
    const clusters: number[][] = []

    for (const node of adjacency.keys()) {
      if (visited.has(node)) continue
      const cluster: number[] = []
      const stack = [node]
      while (stack.length > 0) {
        const current = stack.pop()!
        if (visited.has(current)) continue
        visited.add(current)
        cluster.push(current)
        for (const neighbor of adjacency.get(current) ?? []) {
          if (!visited.has(neighbor)) stack.push(neighbor)
        }
      }
      if (cluster.length >= 2) clusters.push(cluster)
    }

    let autoMerged = 0

    for (const cluster of clusters) {
      // Check if all pairs in cluster are ≥0.95 (auto-merge)
      let allAutoMergeable = true
      for (let i = 0; i < cluster.length && allAutoMergeable; i++) {
        for (let j = i + 1; j < cluster.length && allAutoMergeable; j++) {
          const a = Math.min(cluster[i], cluster[j])
          const b = Math.max(cluster[i], cluster[j])
          const sim = pairSimilarities.get(`${a}-${b}`) ?? 0
          if (sim < AUTO_MERGE_THRESHOLD) allAutoMergeable = false
        }
      }

      if (allAutoMergeable) {
        // Auto-merge: keep the highest-tier, most-confirmed fact as canonical
        const clusterFacts = cluster.map((idx) => embedded[idx].fact)
        clusterFacts.sort((a, b) =>
          b.tier !== a.tier ? b.tier - a.tier :
          b.confirmationCount !== a.confirmationCount ? b.confirmationCount - a.confirmationCount :
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        )
        const canonical = clusterFacts[0]
        for (let k = 1; k < clusterFacts.length; k++) {
          // Transfer confirmation events before merging (preserves evidence history)
          memoryFactRepository.reparentConfirmations(clusterFacts[k].id, canonical.id)
          memoryFactRepository.mergeFact(clusterFacts[k].id, canonical.id)
          autoMerged++
        }
      } else {
        // Emit one review item per cluster (representative pair)
        const repI = cluster[0]
        const repJ = cluster[1]
        const a = Math.min(repI, repJ)
        const b = Math.max(repI, repJ)
        const sim = pairSimilarities.get(`${a}-${b}`) ?? THRESHOLD
        // ON CONFLICT DO NOTHING — idempotent, returns null on duplicate
        memoryFactRepository.createContradiction({
          oldFactId: embedded[a].fact.id,
          newFactId: embedded[b].fact.id,
          status: 'pending',
          resolution: `duplicate cluster (${cluster.length} facts, cosine: ${sim.toFixed(3)})`
        })
      }
    }

    log.info(
      `[MemoryEngine] Dedup scan: ${clusters.length} clusters, ${autoMerged} auto-merged from ${embedded.length} facts`
    )
    return { clustersFound: clusters.length, autoMerged }
  }

  // ── Haiku classifier ───────────────────────────────────────────────────

  private async spawnClassifier(prompt: string, workspacePath?: string, workspaceId?: string): Promise<string> {
    // G5: Gate memoryFeed through resolveAssignment — route to local LLM when assigned
    // A2: Guard workspacePath — null paths fall through to the Claude CLI path below
    if (workspaceId && workspacePath) {
      const assignment = resolveAssignment({ action: 'memoryFeed', ...buildResolveOpts(workspaceId) })
      if (assignment.provider === 'local-llm') {
        const localCfg = modelConfigService.getLocalLLMConfig(workspacePath)
        const result = await runOneShotLocal({
          systemPrompt: 'You are a knowledge base curator. Respond with exactly one word.',
          userMessage: prompt,
          baseUrl: modelConfigService.getLocalBaseUrl(localCfg),
          model: assignment.modelId,
          apiKey: localCfg.localApiKey,
          feature: 'memory_feed',
          workspaceId,
          maxTokens: 32,
          claudeFallbackArgs: buildMemoryFeedFallbackArgs(prompt),
          claudeFallbackModel: DEFAULT_MODEL_CONFIG.memoryFeed
        })
        return result.text
      }
    }

    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 30_000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

      const env = buildEnvWithPath()

      const model = modelConfigService.getModel(workspacePath ?? undefined, 'memoryFeed')

      const child = spawn(
        'claude',
        ['-p', prompt, '--model', model, '--output-format', 'text', '--permission-mode', 'plan'],
        { stdio: ['ignore', 'pipe', 'pipe'], env, signal: controller.signal }
      )

      let stdout = ''
      const MAX_OUTPUT = 1024

      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT) {
          stdout += data.toString().slice(0, MAX_OUTPUT - stdout.length)
        }
      })

      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim())
        } else {
          reject(new Error(`Classifier exited with code ${code}`))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
}

// ── Math utils ──────────────────────────────────────────────────────────────

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ── Evidence-based promotion (exported for unit testing) ────────────────────

/**
 * Pure promotion logic — implements evidence-based rules (tightened 2026-07):
 *   T0→T1: ≥3 confirms on ≥3 distinct days
 *   T1→T2: ≥5 confirms across ≥3 distinct source types over 14+ days, confidence ≥ 0.75
 *   T2→T3: ≥2 human confirms required + ≥8 weighted confirms over 30+ days, confidence ≥ 0.90
 *
 * Auto-dedup confirms record events but weigh 0.0 (repetition ≠ evidence).
 */
function computePromotionTierPure(
  tier: MemoryFactTier,
  confidence: number,
  confirmations: Array<{ sourceType: ConfirmationSourceType; weight: number; createdAt: string }>
): MemoryFactTier {
  // Filter out auto_dedup confirmations from promotion metrics entirely.
  // auto_dedup records are kept for audit but repetition ≠ independent evidence.
  const evidence = confirmations.filter((c) => c.sourceType !== 'auto_dedup')

  const distinctDays = new Set(evidence.map((c) => c.createdAt.slice(0, 10))).size
  const distinctSources = new Set(evidence.map((c) => c.sourceType)).size
  const weightedSum = evidence.reduce((sum, c) => sum + c.weight, 0)
  const totalCount = evidence.length

  // Compute day span (earliest to latest evidence confirmation)
  let daySpan = 0
  if (evidence.length >= 2) {
    const dates = evidence.map((c) => new Date(c.createdAt).getTime())
    daySpan = Math.floor((Math.max(...dates) - Math.min(...dates)) / (24 * 60 * 60 * 1000))
  }

  // Count human confirmations specifically for T2→T3
  const humanCount = evidence.filter((c) => c.sourceType === 'human').length

  // T0 → T1: 3+ confirms on 3+ distinct days
  if (tier === 0 && totalCount >= 3 && distinctDays >= 3) return 1

  // T1 → T2: 5+ confirms across 3+ source types over 14+ days, confidence ≥ 0.75
  if (tier === 1 && totalCount >= 5 && distinctSources >= 3 && daySpan >= 14 && confidence >= 0.75) return 2

  // T2 → T3: 2+ human confirms + 8+ weighted confirms over 30+ days, confidence ≥ 0.90
  if (tier === 2 && humanCount >= 2 && weightedSum >= 8 && daySpan >= 30 && confidence >= 0.90) return 3

  return tier
}

/** Capture cap constants — exported for testing. */
export const CAPTURE_CAPS = {
  MAX_FACTS_PER_SESSION,
  MAX_FACTS_PER_COMMIT,
} as const

/** Volatile detection patterns — exported for testing. */
export { VOLATILE_PATTERNS }

export { cosineSimilarity, computePromotionTierPure }
export const memoryEngineService = new MemoryEngineService()

// Backfill pending embeddings when the oMLX model becomes ready
localEmbeddingProvider.on('modelReady', () => {
  memoryEngineService.backfillPendingEmbeddings().catch((e) =>
    log.warn('[MemoryEngine] modelReady backfill error:', e)
  )
})
