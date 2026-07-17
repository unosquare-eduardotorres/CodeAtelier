/**
 * MemoryConsolidationService — Background consolidation for the memory system.
 *
 * Responsibilities:
 *   1. One-time consolidation pass: cluster all active facts at ≥0.85 similarity,
 *      auto-merge ≥0.95 clusters, queue 0.85–0.95 clusters as single review items.
 *   2. Idle/daily job: auto-merge ≥0.95 duplicates, archive stale T0 facts,
 *      prune old contradiction records, cap the review queue.
 *
 * Inspired by Letta's sleep-time compute pattern: background consolidation
 * during idle time produces clean, compact memories.
 */

import { dbLogger } from '../logger'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import { memoryEngineService, cosineSimilarity } from './memory-engine.service'
import type { MemoryFact } from '../../shared/types'

const log = dbLogger

// ── Thresholds ──────────────────────────────────────────────────────────────
const CLUSTER_THRESHOLD = 0.85
const AUTO_MERGE_THRESHOLD = 0.95
const STALE_T0_DAYS = 30
const CONTRADICTION_PRUNE_DAYS = 30
const MAX_REVIEW_QUEUE = 100

// ── Idle job settings ───────────────────────────────────────────────────────
const IDLE_JOB_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours
const IDLE_JOB_DELAY_MS = 5 * 60 * 1000 // 5 minutes after startup

interface ConsolidationResult {
  clustersFound: number
  autoMerged: number
  reviewItemsCreated: number
  staleArchived: number
  contradictionsPruned: number
  reviewQueueCapped: number
}

class MemoryConsolidationService {
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private boundWorkspaceId: string | null = null

  // ── One-time consolidation pass ──────────────────────────────────────

  /**
   * Full consolidation: cluster all active facts at ≥0.85 similarity,
   * auto-merge ≥0.95, queue 0.85–0.95 for review.
   * Target: reduce active facts from 668 to ~250–350.
   */
  async runFullConsolidation(workspaceId: string): Promise<ConsolidationResult> {
    if (this.running) {
      log.warn('[Consolidation] Already running, skipping')
      return emptyResult()
    }

    this.running = true
    try {
      log.info('[Consolidation] Starting full consolidation pass')
      return this.consolidate(workspaceId)
    } finally {
      this.running = false
    }
  }

  /** Core consolidation logic — builds clusters and processes them. */
  private consolidate(workspaceId: string): ConsolidationResult {
    const embedded = memoryFactRepository.findWithEmbeddings(workspaceId)
    if (embedded.length < 2) {
      log.info(`[Consolidation] Only ${embedded.length} facts with embeddings, nothing to consolidate`)
      return emptyResult()
    }

    log.info(`[Consolidation] Processing ${embedded.length} embedded facts`)

    // Build adjacency list for connected components at CLUSTER_THRESHOLD
    const adjacency = new Map<number, Set<number>>()
    const pairSimilarities = new Map<string, number>()

    for (let i = 0; i < embedded.length; i++) {
      for (let j = i + 1; j < embedded.length; j++) {
        const sim = cosineSimilarity(embedded[i].embedding, embedded[j].embedding)
        if (sim >= CLUSTER_THRESHOLD) {
          if (!adjacency.has(i)) adjacency.set(i, new Set())
          if (!adjacency.has(j)) adjacency.set(j, new Set())
          adjacency.get(i)!.add(j)
          adjacency.get(j)!.add(i)
          pairSimilarities.set(`${Math.min(i, j)}-${Math.max(i, j)}`, sim)
        }
      }
    }

    // Find connected components
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
    let reviewItemsCreated = 0

    for (const cluster of clusters) {
      const clusterFacts = cluster.map((idx) => embedded[idx].fact)

      // Check if all pairs in cluster are ≥ AUTO_MERGE_THRESHOLD
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
        // Auto-merge: keep highest-tier, most-confirmed fact as canonical
        autoMerged += this.mergeCluster(clusterFacts)
      } else {
        // Queue one review item per cluster
        reviewItemsCreated += this.queueClusterReview(clusterFacts, cluster, embedded, pairSimilarities)
      }
    }

    // Run cleanup tasks
    const staleArchived = this.archiveStaleT0Facts(workspaceId)
    const contradictionsPruned = this.pruneOldContradictions()
    const reviewQueueCapped = this.capReviewQueue()

    const result: ConsolidationResult = {
      clustersFound: clusters.length,
      autoMerged,
      reviewItemsCreated,
      staleArchived,
      contradictionsPruned,
      reviewQueueCapped
    }

    log.info(
      `[Consolidation] Complete: ${clusters.length} clusters, ${autoMerged} merged, ` +
      `${reviewItemsCreated} review items, ${staleArchived} stale archived, ` +
      `${contradictionsPruned} contradictions pruned`
    )

    return result
  }

  /** Merge a cluster of highly-similar facts into one canonical fact. */
  private mergeCluster(facts: MemoryFact[]): number {
    // Sort: highest tier first, then most confirmations, then most recent
    facts.sort((a, b) =>
      b.tier !== a.tier ? b.tier - a.tier :
      b.confirmationCount !== a.confirmationCount ? b.confirmationCount - a.confirmationCount :
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )

    const canonical = facts[0]
    let merged = 0

    // Merge scope paths and tags from all members into canonical
    const allScopePaths = new Set(canonical.scopePaths)
    const allTags = new Set(canonical.tags)

    for (let i = 1; i < facts.length; i++) {
      facts[i].scopePaths.forEach((p) => allScopePaths.add(p))
      facts[i].tags.forEach((t) => allTags.add(t))
      // Transfer confirmation events to the canonical fact (summed evidence)
      memoryFactRepository.reparentConfirmations(facts[i].id, canonical.id)
      memoryFactRepository.mergeFact(facts[i].id, canonical.id)
      merged++
    }

    // Update canonical with merged scope paths/tags
    if (allScopePaths.size > canonical.scopePaths.length || allTags.size > canonical.tags.length) {
      memoryFactRepository.updateFact(canonical.id, {
        scopePaths: Array.from(allScopePaths),
        tags: Array.from(allTags)
      })
    }

    log.debug(`[Consolidation] Merged ${merged} facts into canonical ${canonical.id}: "${canonical.title}"`)
    return merged
  }

  /** Queue a single review item for a cluster that needs human review. */
  private queueClusterReview(
    facts: MemoryFact[],
    clusterIndices: number[],
    embedded: Array<{ fact: MemoryFact; embedding: Float32Array }>,
    pairSimilarities: Map<string, number>
  ): number {
    // Use the pair with highest similarity as the representative
    let bestI = clusterIndices[0]
    let bestJ = clusterIndices[1]
    let bestSim = 0

    for (let i = 0; i < clusterIndices.length; i++) {
      for (let j = i + 1; j < clusterIndices.length; j++) {
        const a = Math.min(clusterIndices[i], clusterIndices[j])
        const b = Math.max(clusterIndices[i], clusterIndices[j])
        const sim = pairSimilarities.get(`${a}-${b}`) ?? 0
        if (sim > bestSim) {
          bestSim = sim
          bestI = clusterIndices[i]
          bestJ = clusterIndices[j]
        }
      }
    }

    const created = memoryFactRepository.createContradiction({
      oldFactId: embedded[bestI].fact.id,
      newFactId: embedded[bestJ].fact.id,
      status: 'pending',
      resolution: `review cluster (${facts.length} facts, best cosine: ${bestSim.toFixed(3)})`
    })
    // ON CONFLICT DO NOTHING returns null when the pair already exists
    return created ? 1 : 0
  }

  // ── Cleanup tasks ──────────────────────────────────────────────────────

  /** Archive T0 facts never accessed or confirmed in STALE_T0_DAYS days. */
  private archiveStaleT0Facts(workspaceId: string): number {
    try {
      const stale = memoryFactRepository.findByWorkspace(workspaceId, 'active')
        .filter((f) =>
          f.tier === 0 &&
          f.confirmationCount === 0 &&
          !f.lastAccessedAt &&
          f.workspaceId === workspaceId && // Skip global facts (workspaceId IS NULL)
          daysSince(f.createdAt) > STALE_T0_DAYS
        )

      for (const fact of stale) {
        memoryFactRepository.archiveFact(fact.id)
      }

      if (stale.length > 0) {
        log.info(`[Consolidation] Archived ${stale.length} stale T0 facts`)
      }
      return stale.length
    } catch (err) {
      log.warn('[Consolidation] Archive stale T0 failed:', err)
      return 0
    }
  }

  /** Prune resolved contradiction records older than threshold. */
  private pruneOldContradictions(): number {
    try {
      return memoryFactRepository.pruneOldContradictions(CONTRADICTION_PRUNE_DAYS)
    } catch (err) {
      log.warn('[Consolidation] Prune contradictions failed:', err)
      return 0
    }
  }

  /** Cap the review queue by expiring oldest items beyond MAX_REVIEW_QUEUE. */
  private capReviewQueue(): number {
    try {
      const pendingCount = memoryFactRepository.countPendingContradictions()
      if (pendingCount <= MAX_REVIEW_QUEUE) return 0

      // Resolve the oldest excess as 'auto_resolved'
      const excess = pendingCount - MAX_REVIEW_QUEUE
      const pending = memoryFactRepository.findContradictions('pending')
      const toResolve = pending.slice(-excess) // oldest are at the end (DESC order)

      for (const c of toResolve) {
        memoryFactRepository.resolveContradiction(c.id, 'auto-expired (queue cap)', 'auto_resolved')
      }

      log.info(`[Consolidation] Capped review queue: resolved ${toResolve.length} oldest items`)
      return toResolve.length
    } catch (err) {
      log.warn('[Consolidation] Cap review queue failed:', err)
      return 0
    }
  }

  // ── Idle job ──────────────────────────────────────────────────────────

  /** Start the periodic idle consolidation job. */
  startIdleJob(workspaceId: string): void {
    if (this.idleTimer || this.startupTimer) return

    this.boundWorkspaceId = workspaceId

    // Delay first run — store handle so stopIdleJob can cancel
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      this.runIdleConsolidation(workspaceId)

      // Then run periodically
      this.idleTimer = setInterval(
        () => this.runIdleConsolidation(workspaceId),
        IDLE_JOB_INTERVAL_MS
      )
    }, IDLE_JOB_DELAY_MS)

    log.info('[Consolidation] Idle job scheduled (6h interval, 5min initial delay)')
  }

  /** Stop the idle job for a specific workspace (no-op if different workspace is bound). */
  stopIdleJobIfWorkspace(workspaceId: string): void {
    if (this.boundWorkspaceId === workspaceId) this.stopIdleJob()
  }

  /** Stop the idle job (cancels both startup timer and interval). */
  stopIdleJob(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
    this.boundWorkspaceId = null
  }

  /** Run a lightweight consolidation pass (subset of full). */
  private async runIdleConsolidation(workspaceId: string): Promise<void> {
    if (this.running) return

    this.running = true
    try {
      log.info('[Consolidation] Running idle consolidation')

      // 1. Cluster & auto-merge ≥0.95 duplicates
      memoryEngineService.scanForDuplicates(workspaceId)

      // 2. Archive stale T0 facts
      this.archiveStaleT0Facts(workspaceId)

      // 3. Prune old contradiction records
      this.pruneOldContradictions()

      // 4. Cap review queue
      this.capReviewQueue()

      // 5. Run decay sweep
      memoryEngineService.runDecaySweepIfDue()

      log.info('[Consolidation] Idle consolidation complete')
    } catch (err) {
      log.warn('[Consolidation] Idle consolidation failed:', err)
    } finally {
      this.running = false
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function daysSince(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (24 * 60 * 60 * 1000))
}

function emptyResult(): ConsolidationResult {
  return {
    clustersFound: 0,
    autoMerged: 0,
    reviewItemsCreated: 0,
    staleArchived: 0,
    contradictionsPruned: 0,
    reviewQueueCapped: 0
  }
}

export const memoryConsolidationService = new MemoryConsolidationService()
