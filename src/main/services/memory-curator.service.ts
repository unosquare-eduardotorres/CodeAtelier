/**
 * memory-curator — judgement for the band rules cannot decide.
 *
 * Deduplication is settled at both ends of the similarity scale and undecided
 * in the middle. Above 0.95 two facts are the same fact and auto-merge handles
 * them. Below 0.85 they are unrelated. Between the two sits a band that is
 * genuinely ambiguous — "use Result<T,E> in services" and "services return
 * Result types" are one convention; "migrations run in a transaction" and
 * "migrations bump user_version atomically" are two — and until now everything
 * in it piled into a review queue nobody could work through.
 *
 * Four constraints, all of them about blast radius rather than cost:
 *
 *   1. **The model can never hard-delete.** Its strongest available action is a
 *      soft archive, which only becomes permanent 90 days later via the
 *      tombstone GC. Every mistake it can make is recoverable, and the sweep
 *      that calls it records an undo entry for each one.
 *   2. Protected facts are filtered out BEFORE the prompt is built, not after
 *      the verdict comes back. A tier-2+, human-confirmed or volatile fact is
 *      never shown to the model, so no verdict about it can exist.
 *   3. Verdicts naming an id that was not in the batch are dropped. A model
 *      that hallucinates an id must not be able to reach a fact it never saw.
 *   4. A hard call budget per run, and only ever from the idle/manual sweep.
 *
 * Deliberately modelled on memory-reflection.service: same one-shot Claude path,
 * same cheap model, same opt-in-per-workspace shape.
 */

import log from 'electron-log'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import { cosineSimilarity } from './memory-engine.service'
import { workspaceRepository } from '../db/repositories'
import {
  undoEntryFor,
  type CleanupUndoEntry
} from '../db/repositories/memory-cleanup-run.repository'
import { runAgenticClaude } from './agentic-claude-runner'
import type { MemoryFact } from '../../shared/types'

const cLog = log.scope('memory-curator')

/** The one call curation makes to the outside world. Injectable for tests. */
export type CuratorRunner = typeof runAgenticClaude

// ── Configuration ───────────────────────────────────────────────────────────

/** Below this two facts are unrelated and there is nothing to judge. */
const CLUSTER_THRESHOLD = 0.85

/** At or above this auto-merge already handles them; asking a model is waste. */
const AUTO_MERGE_THRESHOLD = 0.95

/** Facts per model call. Small enough that one bad batch costs little. */
const BATCH_SIZE = 25

/** Calls per run. The cost ceiling, and the abort condition. */
const MAX_CALLS_PER_RUN = 12

export interface CurationResult {
  archived: number
  merged: number
  calls: number
  undo: CleanupUndoEntry[]
}

export type CuratorVerdictKind = 'KEEP' | 'ARCHIVE' | 'MERGE_INTO'

export interface CuratorVerdict {
  id: string
  verdict: CuratorVerdictKind
  /** Canonical fact id — only meaningful for MERGE_INTO. */
  target?: string
  reason: string
}

// ── Eligibility ─────────────────────────────────────────────────────────────

/**
 * Whether a fact may be shown to the curator at all.
 *
 * Identical protections to the deterministic idle rule, for the same reasons:
 * established tiers, anything a human vouched for, and volatile pinned facts
 * are not the model's business. Applied as a filter on the candidate set rather
 * than as a check on the verdict, so a protected fact never appears in a prompt.
 */
export function isCuratable(
  fact: Pick<MemoryFact, 'id' | 'tier' | 'status' | 'volatile' | 'workspaceId'>,
  workspaceId: string,
  humanConfirmed: Set<string> = new Set()
): boolean {
  return (
    fact.status === 'active' &&
    fact.workspaceId === workspaceId &&
    fact.tier <= 1 &&
    !fact.volatile &&
    !humanConfirmed.has(fact.id)
  )
}

/**
 * Connected components in the ambiguous band.
 *
 * Clusters whose every edge is at or above AUTO_MERGE_THRESHOLD are dropped —
 * those are plain duplicates and consolidation merges them without spending a
 * token. Singletons are dropped too: there is no judgement to make about a fact
 * with nothing to compare it to.
 *
 * Pairs are compared within a category only, for the same reason the dedup scan
 * does it: this runs on the Electron main thread and the loop is O(n²), so at
 * two thousand facts an unbucketed pass is a visible freeze. Two facts filed
 * under different categories are also, by construction, not the redundancy this
 * is looking for.
 */
export function findAmbiguousClusters(
  embedded: Array<{ fact: MemoryFact; embedding: Float32Array }>
): MemoryFact[][] {
  if (embedded.length < 2) return []

  const adjacency = new Map<number, Set<number>>()
  const sims = new Map<string, number>()

  const buckets = new Map<string, number[]>()
  for (let i = 0; i < embedded.length; i++) {
    const key = embedded[i].fact.category
    const bucket = buckets.get(key)
    if (bucket) bucket.push(i)
    else buckets.set(key, [i])
  }

  for (const bucket of buckets.values()) {
    for (let bi = 0; bi < bucket.length; bi++) {
      for (let bj = bi + 1; bj < bucket.length; bj++) {
        const i = bucket[bi]
        const j = bucket[bj]
        const sim = cosineSimilarity(embedded[i].embedding, embedded[j].embedding)
        if (sim < CLUSTER_THRESHOLD) continue
        if (!adjacency.has(i)) adjacency.set(i, new Set())
        if (!adjacency.has(j)) adjacency.set(j, new Set())
        adjacency.get(i)!.add(j)
        adjacency.get(j)!.add(i)
        // Bucket order does not guarantee i < j; normalise as the reader does.
        sims.set(`${Math.min(i, j)}-${Math.max(i, j)}`, sim)
      }
    }
  }

  const visited = new Set<number>()
  const clusters: MemoryFact[][] = []

  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue

    const members: number[] = []
    const stack = [start]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      members.push(current)
      for (const neighbour of adjacency.get(current) ?? []) {
        if (!visited.has(neighbour)) stack.push(neighbour)
      }
    }
    if (members.length < 2) continue

    // Every recorded edge above the auto-merge line means consolidation owns it.
    let hasAmbiguousEdge = false
    for (let i = 0; i < members.length && !hasAmbiguousEdge; i++) {
      for (let j = i + 1; j < members.length && !hasAmbiguousEdge; j++) {
        const key = `${Math.min(members[i], members[j])}-${Math.max(members[i], members[j])}`
        const sim = sims.get(key)
        if (sim !== undefined && sim < AUTO_MERGE_THRESHOLD) hasAmbiguousEdge = true
      }
    }
    if (!hasAmbiguousEdge) continue

    clusters.push(members.map((idx) => embedded[idx].fact))
  }

  return clusters
}

// ── Service ─────────────────────────────────────────────────────────────────

class MemoryCuratorService {
  private running = false

  /** Whether this workspace opted into paying for curation. */
  isEnabled(workspaceId: string): boolean {
    try {
      const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
      return settings?.memoryCuratorEnabled === true
    } catch {
      return false
    }
  }

  /**
   * The facts the curator would judge, with no model involved.
   *
   * The preview calls this, so it has to be cheap and it has to agree exactly
   * with what `curate` will act on — a dry run that disagrees with the real run
   * is worse than no dry run.
   */
  findCandidates(workspaceId: string): MemoryFact[] {
    const embedded = memoryFactRepository.findWithEmbeddings(workspaceId)
    const eligible = this.filterEligible(workspaceId, embedded)
    return findAmbiguousClusters(eligible).flat()
  }

  /**
   * Judge the ambiguous band and apply the verdicts.
   *
   * Returns the undo entries for everything it touched; the caller folds them
   * into the sweep's undo log so one press reverses the model's work too.
   */
  async curate(
    workspaceId: string,
    runner: CuratorRunner = runAgenticClaude
  ): Promise<CurationResult> {
    const empty: CurationResult = { archived: 0, merged: 0, calls: 0, undo: [] }

    if (this.running) {
      cLog.info('[curate] Already running, skipping')
      return empty
    }
    if (!this.isEnabled(workspaceId)) return empty

    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace?.repoPath) return empty

    this.running = true
    try {
      const embedded = memoryFactRepository.findWithEmbeddings(workspaceId)
      const eligible = this.filterEligible(workspaceId, embedded)
      const clusters = findAmbiguousClusters(eligible)
      if (clusters.length === 0) return empty

      const result: CurationResult = { archived: 0, merged: 0, calls: 0, undo: [] }

      // Batch by cluster, never across clusters: a verdict only makes sense
      // beside the facts it is being compared against.
      for (const batch of batchClusters(clusters, BATCH_SIZE)) {
        if (result.calls >= MAX_CALLS_PER_RUN) {
          cLog.info(`[curate] Call budget reached (${MAX_CALLS_PER_RUN}), stopping cleanly`)
          break
        }

        result.calls++
        const verdicts = await this.judgeBatch(workspaceId, workspace.repoPath, batch, runner)
        this.applyVerdicts(batch, verdicts, result)
      }

      cLog.info(
        `[curate] ${result.calls} call(s): ${result.archived} archived, ${result.merged} merged`
      )
      return result
    } finally {
      this.running = false
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** Drop protected facts before anything else looks at them. */
  private filterEligible(
    workspaceId: string,
    embedded: Array<{ fact: MemoryFact; embedding: Float32Array }>
  ): Array<{ fact: MemoryFact; embedding: Float32Array }> {
    if (embedded.length === 0) return []
    const humanConfirmed = memoryFactRepository.getHumanConfirmedIds(
      embedded.map(({ fact }) => fact.id)
    )
    return embedded.filter(({ fact }) => isCuratable(fact, workspaceId, humanConfirmed))
  }

  /** One model call for one batch. Returns [] on any failure. */
  private async judgeBatch(
    workspaceId: string,
    workspacePath: string,
    batch: MemoryFact[],
    runner: CuratorRunner
  ): Promise<CuratorVerdict[]> {
    try {
      const result = await runner({
        workspaceId,
        workspacePath,
        prompt: buildCuratorPrompt(batch),
        allowedTools: [],
        model: 'claude-haiku-4-5',
        maxTurns: 1,
        timeoutMs: 60_000
      })
      return parseVerdicts(result.stdout ?? '', new Set(batch.map((f) => f.id)))
    } catch (err) {
      cLog.warn('[judgeBatch] Model call failed:', err)
      return []
    }
  }

  /**
   * Apply verdicts, recording how to undo each one first.
   *
   * MERGE_INTO reparents the confirmation events before archiving, so evidence
   * follows the fact rather than dying with the duplicate. A merge whose target
   * is not in the same batch is downgraded to a plain archive: the model can
   * only reason about what it was shown.
   */
  private applyVerdicts(
    batch: MemoryFact[],
    verdicts: CuratorVerdict[],
    result: CurationResult
  ): void {
    const byId = new Map(batch.map((f) => [f.id, f]))

    for (const verdict of verdicts) {
      const fact = byId.get(verdict.id)
      if (!fact || verdict.verdict === 'KEEP') continue

      const target = verdict.verdict === 'MERGE_INTO' ? byId.get(verdict.target ?? '') : undefined

      // Merging a fact into itself would archive it and point it at itself.
      if (verdict.verdict === 'MERGE_INTO' && (!target || target.id === fact.id)) {
        cLog.warn(`[applyVerdicts] Unusable merge target for ${fact.id}; archiving instead`)
      }

      result.undo.push(undoEntryFor(fact))

      if (target && target.id !== fact.id) {
        memoryFactRepository.reparentConfirmations(fact.id, target.id)
        memoryFactRepository.mergeFact(fact.id, target.id)
        result.merged++
      } else {
        memoryFactRepository.archiveFact(fact.id)
        result.archived++
      }

      // Once archived a fact must not also be a merge target for a later
      // verdict in the same batch, or evidence lands on a tombstone.
      byId.delete(fact.id)
    }
  }
}

// ── Batching, prompt and parsing ────────────────────────────────────────────

/**
 * Pack clusters into batches without splitting a cluster across two calls.
 *
 * A cluster larger than the batch size is truncated rather than split: the
 * point of the prompt is that every fact in it can be compared against every
 * other, and half a cluster cannot deliver that.
 */
export function batchClusters(clusters: MemoryFact[][], batchSize: number): MemoryFact[][] {
  const batches: MemoryFact[][] = []
  let current: MemoryFact[] = []

  for (const cluster of clusters) {
    const capped = cluster.slice(0, batchSize)
    if (current.length > 0 && current.length + capped.length > batchSize) {
      batches.push(current)
      current = []
    }
    current.push(...capped)
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function buildCuratorPrompt(facts: MemoryFact[]): string {
  const list = facts
    .map((f) => `- id: ${f.id}\n  tier: T${f.tier}\n  title: ${f.title}\n  content: ${f.content}`)
    .join('\n')

  return [
    'You are curating a project knowledge base. Below are facts that a similarity',
    'scan flagged as possibly redundant. They are similar, but similarity is not',
    'sameness — your job is to say which.',
    '',
    'For EACH fact, return exactly one verdict:',
    '  KEEP        — it states something the others do not.',
    '  ARCHIVE     — it is redundant or obsolete and nothing else needs it.',
    '  MERGE_INTO  — it says the same thing as another fact in this list, which',
    '                is more complete. Give that fact id as "target".',
    '',
    'Rules:',
    '- Default to KEEP. Losing a distinct fact costs more than keeping a duplicate.',
    '- "target" must be an id from THIS list, and never the id being judged.',
    '- Never ARCHIVE every fact in the list. At least one must survive.',
    '- Give a short, concrete reason. No hedging.',
    '',
    'Respond as a JSON array only, no prose, no code fence:',
    '[{"id":"...","verdict":"KEEP|ARCHIVE|MERGE_INTO","target":"...","reason":"..."}]',
    '',
    '## Facts',
    '',
    list
  ].join('\n')
}

/**
 * Parse the model's reply into verdicts it is actually allowed to act on.
 *
 * `allowedIds` is the security boundary, not a convenience: a verdict naming an
 * id that was not in the batch is discarded outright, so a hallucinated or
 * copied-from-context id cannot reach a fact the model never saw.
 *
 * A reply that archives everything is rejected wholesale rather than partially
 * applied — that is the shape of a model that has lost the plot, and salvaging
 * half of it would delete real knowledge with no way to tell which half.
 */
export function parseVerdicts(text: string, allowedIds: Set<string>): CuratorVerdict[] {
  const match = /\[[\s\S]*\]/.exec(text.replace(/```(?:json)?/gi, ''))
  if (!match) return []

  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const verdicts: CuratorVerdict[] = []
  const seen = new Set<string>()

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>

    const id = typeof row.id === 'string' ? row.id : ''
    if (!allowedIds.has(id) || seen.has(id)) continue

    const kind = row.verdict
    if (kind !== 'KEEP' && kind !== 'ARCHIVE' && kind !== 'MERGE_INTO') continue

    const target = typeof row.target === 'string' ? row.target : undefined
    if (kind === 'MERGE_INTO' && (!target || !allowedIds.has(target) || target === id)) continue

    seen.add(id)
    verdicts.push({
      id,
      verdict: kind,
      target: kind === 'MERGE_INTO' ? target : undefined,
      reason: typeof row.reason === 'string' ? row.reason.slice(0, 300) : ''
    })
  }

  const survivors = allowedIds.size - verdicts.filter((v) => v.verdict !== 'KEEP').length
  if (survivors <= 0) {
    cLog.warn('[parseVerdicts] Model would remove every fact in the batch — discarding the batch')
    return []
  }

  return verdicts
}

export const memoryCuratorService = new MemoryCuratorService()
