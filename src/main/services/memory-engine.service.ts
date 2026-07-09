/**
 * MemoryEngineService — Write pipeline for the knowledge-aware memory engine.
 *
 * Handles: embed → top-k cosine similarity → classify (dup/contradiction/new)
 * → persist with audit trail. Includes decay sweep and embedding backfill.
 *
 * Similarity bands:
 *   ≥0.90  → duplicate (confirm existing fact)
 *   0.70–0.90  → ambiguous (Haiku classifies: dup | contradiction | distinct)
 *   <0.70  → new fact (insert directly)
 */

import { dbLogger } from '../logger'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import { omlxEmbeddingProvider } from './omlx-embedding.service'
import { modelConfigService, resolveAssignment, buildResolveOpts } from './model-config.service'
import { runOneShotLocal, buildMemoryFeedFallbackArgs } from './one-shot-local'
import { DEFAULT_MODEL_CONFIG } from '../../shared/constants'
import { spawn } from 'node:child_process'
import type {
  MemoryFact,
  MemoryFactCategory,
  MemoryFactTier,
  MemorySourceType
} from '../../shared/types'

const log = dbLogger

// ── Similarity thresholds ───────────────────────────────────────────────────
const DUPLICATE_THRESHOLD = 0.90
const AMBIGUOUS_THRESHOLD = 0.70

// ── Decay settings ──────────────────────────────────────────────────────────
const DECAY_DAYS_THRESHOLD = 30
const DECAY_CONFIDENCE_DELTA = 0.15
const DECAY_THROTTLE_MS = 24 * 60 * 60 * 1000 // 24h

// ── Promotion rules ─────────────────────────────────────────────────────────
const TIER_0_TO_1_CONFIRMS = 2
const TIER_1_TO_2_CONFIRMS = 3
const TIER_2_TO_3_CONFIRMS = 5

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

class MemoryEngineService {
  private lastDecayRun = 0
  private classifyInFlight = false

  // ── Write pipeline ──────────────────────────────────────────────────────

  /**
   * Main entry point: write a fact through the dedup/contradiction pipeline.
   * Returns the created or confirmed fact.
   */
  async writeFact(params: WriteFactParams): Promise<MemoryFact> {
    const { workspaceId } = params
    const factText = `${params.title}\n${params.content}`

    // 1. Try to embed
    let embedding: Buffer | null = null
    let embeddingPending = true
    try {
      if (omlxEmbeddingProvider.isReady) {
        const vectors = await omlxEmbeddingProvider.embed([factText])
        if (vectors.length > 0 && vectors[0].length > 0) {
          embedding = Buffer.from(new Float32Array(vectors[0]).buffer)
          embeddingPending = false
        }
      }
    } catch (err) {
      log.warn('[MemoryEngine] Embedding failed, saving as pending:', err)
    }

    // 2. If we have an embedding and a workspace, run similarity check
    if (embedding && workspaceId) {
      const result = await this.runSimilarityPipeline(
        workspaceId,
        params,
        embedding,
        factText
      )
      if (result) return result
    }

    // 3. No match or no embedding — insert as new
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

    log.info(`[MemoryEngine] New fact created: ${fact.id} (tier=${fact.tier}, pending=${embeddingPending})`)

    // 4. Opportunistic backfill of other pending facts
    this.backfillPendingEmbeddings().catch((e) =>
      log.warn('[MemoryEngine] Background backfill error:', e)
    )

    return fact
  }

  /**
   * Similarity pipeline: compare against existing facts, handle dup/contradiction.
   * Returns a fact if handled (confirmed or superseded), null if should insert new.
   */
  private async runSimilarityPipeline(
    workspaceId: string,
    params: WriteFactParams,
    embedding: Buffer,
    factText: string
  ): Promise<MemoryFact | null> {
    const queryVec = new Float32Array(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength / 4
    )

    const candidates = memoryFactRepository.findWithEmbeddings(workspaceId)
    if (candidates.length === 0) return null

    // Compute cosine similarities
    const scored = candidates
      .map(({ fact, embedding: existingVec }) => ({
        fact,
        similarity: cosineSimilarity(queryVec, existingVec)
      }))
      .sort((a, b) => b.similarity - a.similarity)

    const topMatch = scored[0]
    if (!topMatch || topMatch.similarity < AMBIGUOUS_THRESHOLD) {
      return null // New fact territory
    }

    // ≥0.90 — duplicate
    if (topMatch.similarity >= DUPLICATE_THRESHOLD) {
      return this.handleDuplicate(topMatch.fact)
    }

    // 0.70–0.90 — ambiguous band → Haiku classification
    return this.classifyAmbiguous(topMatch.fact, params, factText, embedding)
  }

  /** Confirm an existing fact as a duplicate hit. */
  private handleDuplicate(existing: MemoryFact): MemoryFact {
    const newTier = this.computePromotionTier(existing)
    const confirmed = memoryFactRepository.confirmFact(existing.id, newTier)
    log.info(
      `[MemoryEngine] Duplicate confirmed: ${existing.id} (count=${confirmed.confirmationCount}, tier=${confirmed.tier})`
    )
    return confirmed
  }

  /** Use Haiku to classify whether the ambiguous match is a dup, contradiction, or distinct. */
  private async classifyAmbiguous(
    existing: MemoryFact,
    newParams: WriteFactParams,
    _newText: string,
    embedding?: Buffer
  ): Promise<MemoryFact | null> {
    if (this.classifyInFlight) {
      // Don't pile up Haiku calls — treat as new
      return null
    }

    try {
      this.classifyInFlight = true

      const prompt = `You are a fact classifier. Compare these two facts and determine their relationship.

EXISTING FACT:
Title: ${existing.title}
Content: ${existing.content}
Category: ${existing.category}

NEW FACT:
Title: ${newParams.title}
Content: ${newParams.content}
Category: ${newParams.category}

Respond with EXACTLY one word: "duplicate", "contradiction", or "distinct".
- "duplicate" = they say essentially the same thing
- "contradiction" = they make conflicting claims about the same topic
- "distinct" = they are about different topics or compatible aspects`

      const classification = await this.spawnClassifier(prompt, newParams.workspacePath ?? undefined, newParams.workspaceId ?? undefined)
      const normalized = classification.trim().toLowerCase()

      if (normalized === 'duplicate') {
        return this.handleDuplicate(existing)
      }

      if (normalized === 'contradiction') {
        return this.handleContradiction(existing, newParams, embedding)
      }

      // distinct — fall through to insert new
      return null
    } catch (err) {
      log.warn('[MemoryEngine] Haiku classification failed, treating as new:', err)
      return null
    } finally {
      this.classifyInFlight = false
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

    // Record the contradiction for UI review
    memoryFactRepository.createContradiction({
      oldFactId: oldFact.id,
      newFactId: newFact.id,
      status: 'auto_resolved',
      resolution: `New fact "${newFact.title}" superseded "${oldFact.title}"`
    })

    log.info(
      `[MemoryEngine] Contradiction: ${oldFact.id} superseded by ${newFact.id}`
    )
    return newFact
  }

  // ── Promotion ───────────────────────────────────────────────────────────

  /** Compute the new tier after a confirmation, based on promotion rules. */
  private computePromotionTier(fact: MemoryFact): MemoryFactTier {
    return computePromotionTierPure(fact.tier, fact.confirmationCount)
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

  /** Embed all pending facts, retro-run dedup/contradiction on each. */
  async backfillPendingEmbeddings(): Promise<number> {
    if (!omlxEmbeddingProvider.isReady) return 0

    const pending = memoryFactRepository.findPendingEmbeddings(50)
    if (pending.length === 0) return 0

    let backfilled = 0
    for (const fact of pending) {
      try {
        const text = `${fact.title}\n${fact.content}`
        const vectors = await omlxEmbeddingProvider.embed([text])
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

  // ── Haiku classifier ───────────────────────────────────────────────────

  private async spawnClassifier(prompt: string, workspacePath?: string, workspaceId?: string): Promise<string> {
    // G5: Gate memoryFeed through resolveAssignment — route to local LLM when assigned
    // A2: Guard workspacePath — null paths fall through to the Claude CLI path below
    if (workspaceId && workspacePath) {
      const assignment = resolveAssignment({ action: 'memoryFeed', ...buildResolveOpts(workspaceId) })
      if (assignment.provider === 'local-llm') {
        const localCfg = modelConfigService.getLocalLLMConfig(workspacePath)
        const result = await runOneShotLocal({
          systemPrompt: 'You are a fact classifier. Respond with exactly one word.',
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

      const env = { ...process.env }
      delete env.CLAUDECODE

      if (env.PATH && !env.PATH.includes('/usr/local/bin')) {
        env.PATH = `/usr/local/bin:${env.PATH}`
      }
      if (env.PATH && !env.PATH.includes('/opt/homebrew/bin')) {
        env.PATH = `/opt/homebrew/bin:${env.PATH}`
      }

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

/** Pure promotion logic — exported for unit testing. */
function computePromotionTierPure(tier: MemoryFactTier, currentCount: number): MemoryFactTier {
  const nextCount = currentCount + 1
  if (tier === 0 && nextCount >= TIER_0_TO_1_CONFIRMS) return 1
  if (tier === 1 && nextCount >= TIER_1_TO_2_CONFIRMS) return 2
  if (tier === 2 && nextCount >= TIER_2_TO_3_CONFIRMS) return 3
  return tier
}

export { cosineSimilarity, computePromotionTierPure }
export const memoryEngineService = new MemoryEngineService()

// Backfill pending embeddings when the oMLX model becomes ready
omlxEmbeddingProvider.on('modelReady', () => {
  memoryEngineService.backfillPendingEmbeddings().catch((e) =>
    log.warn('[MemoryEngine] modelReady backfill error:', e)
  )
})
