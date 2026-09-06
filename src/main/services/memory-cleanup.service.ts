/**
 * memory-cleanup — the janitor the memory system never had.
 *
 * Before this, nothing removed anything automatically. The one archival rule
 * required a fact to have NEVER been accessed, which exempts precisely the
 * facts that are in use; `memory_facts` rows were never hard-deleted, so
 * archived facts kept their ~1.5KB embedding BLOB forever; and the retrieval
 * confirmation log grew a row per fact per day with nothing pruning it. At two
 * thousand facts that is not a tidiness problem, it is the corpus.
 *
 * The fix is deliberately boring. Everything decidable by rule is decided by
 * rule, here, with no model involved:
 *
 *   1. Idle archival  — active T0/T1 facts untouched for IDLE_ARCHIVE_DAYS.
 *   2. Tombstone GC   — hard-delete archived/superseded rows whose validity
 *                       closed over TOMBSTONE_TTL_DAYS ago. This is the step
 *                       that actually reclaims disk.
 *   3. Log compaction — retrieval confirmations older than RETRIEVAL_TTL_DAYS,
 *                       keeping one marker per fact per month.
 *
 * Per-item review is impossible at this scale, so the safety gate is
 * **preview + undo**, not selection: `preview()` is a pure dry run, `apply()`
 * records every reversible mutation, and `undo()` restores the whole run. The
 * only irreversible step is (2), and the preview reports it separately for
 * exactly that reason.
 */

import { dbLogger } from '../logger'
import { memoryFactRepository } from '../db/repositories/memory-fact.repository'
import {
  memoryCleanupRunRepository,
  undoEntryFor,
  type CleanupUndoEntry
} from '../db/repositories/memory-cleanup-run.repository'
import { workspaceRepository } from '../db/repositories'
import type {
  MemoryFact,
  MemoryCleanupPreview,
  MemoryCleanupProgress,
  MemoryCleanupRun,
  MemoryCleanupSample,
  MemoryCleanupStats,
  MemoryCleanupThresholds,
  MemoryCleanupTrigger
} from '../../shared/types'

const log = dbLogger

// ── Thresholds ──────────────────────────────────────────────────────────────

/** Archive active T0/T1 facts untouched for this long. */
export const IDLE_ARCHIVE_DAYS = 90

/** Hard-delete tombstones whose validity window closed this long ago. */
export const TOMBSTONE_TTL_DAYS = 90

/** Compact `retrieval` confirmation rows older than this. */
export const RETRIEVAL_TTL_DAYS = 180

/** How long an applied run stays reversible. */
export const UNDO_TTL_DAYS = 7

/** Example facts shown per bucket in a preview. */
const MAX_PREVIEW_SAMPLES = 10

export const DEFAULT_CLEANUP_THRESHOLDS: MemoryCleanupThresholds = {
  idleArchiveDays: IDLE_ARCHIVE_DAYS,
  tombstoneTtlDays: TOMBSTONE_TTL_DAYS,
  retrievalTtlDays: RETRIEVAL_TTL_DAYS
}

// ── The idle-archival rule ──────────────────────────────────────────────────

/** Everything the predicate needs that is not on the fact itself. */
export interface IdleArchivalContext {
  workspaceId: string
  idleDays: number
  /** Facts carrying at least one `human` confirmation. Never archived. */
  humanConfirmed: Set<string>
  /** Injectable for tests; defaults to now. */
  now?: number
}

/**
 * Whether a single fact is idle enough to archive.
 *
 * The old rule tested `!lastAccessedAt` — "never accessed" — which is why
 * nothing was ever archived: a fact retrieved once, years ago, was exempt
 * forever. The replacement asks "not accessed *recently*", falling back through
 * confirmation to creation so a fact that has genuinely never been touched
 * still ages out.
 *
 * Four things are protected unconditionally, and each protects a different
 * failure:
 *   - `tier >= 2` — established knowledge. Idleness is not evidence against a
 *     convention that is simply stable.
 *   - a `human` confirmation — somebody said this is true. Rules do not get to
 *     overrule that.
 *   - `volatile` — version/count facts are pinned and rewritten in place.
 *   - `workspaceId` mismatch, including global (`null`) facts — a global fact
 *     belongs to every workspace and one workspace's sweep must not retire it.
 */
export function isIdleArchivable(
  fact: Pick<
    MemoryFact,
    | 'id'
    | 'tier'
    | 'status'
    | 'volatile'
    | 'workspaceId'
    | 'lastAccessedAt'
    | 'lastConfirmedAt'
    | 'createdAt'
  >,
  ctx: IdleArchivalContext
): boolean {
  if (fact.status !== 'active') return false
  if (fact.workspaceId !== ctx.workspaceId) return false
  if (fact.tier >= 2) return false
  if (fact.volatile) return false
  if (ctx.humanConfirmed.has(fact.id)) return false

  const now = ctx.now ?? Date.now()

  // Anything created inside the window is protected regardless of the touch
  // timestamps, so a fact imported with a stale `lastConfirmedAt` cannot be
  // archived before it has had a chance to be used.
  if (daysSince(fact.createdAt, now) <= ctx.idleDays) return false

  const lastTouch = fact.lastAccessedAt ?? fact.lastConfirmedAt ?? fact.createdAt
  return daysSince(lastTouch, now) > ctx.idleDays
}

/** Facts eligible for idle archival, in the order they should be reported. */
export function selectIdleArchivalCandidates(
  facts: MemoryFact[],
  ctx: IdleArchivalContext
): MemoryFact[] {
  return facts.filter((f) => isIdleArchivable(f, ctx))
}

// ── Service ─────────────────────────────────────────────────────────────────

class MemoryCleanupService {
  private running = false

  /** True while a sweep is in flight. The idle job checks this before starting. */
  get isRunning(): boolean {
    return this.running
  }

  /** Whether this workspace opted into running the sweep from the idle job. */
  isAutoCleanupEnabled(workspaceId: string): boolean {
    try {
      const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
      return settings?.memoryAutoCleanup === true
    } catch {
      return false
    }
  }

  /**
   * Count everything the sweep would do, changing nothing.
   *
   * Deliberately first in the sequence: `IDLE_ARCHIVE_DAYS` and
   * `TOMBSTONE_TTL_DAYS` are proposals, not measurements, and the only way to
   * pick them is to see what they mean against a real corpus.
   */
  async preview(
    workspaceId: string,
    thresholds: MemoryCleanupThresholds = DEFAULT_CLEANUP_THRESHOLDS
  ): Promise<MemoryCleanupPreview> {
    const idle = this.findIdleCandidates(workspaceId, thresholds.idleArchiveDays)
    const tombstoneCount = memoryFactRepository.countTombstones(
      workspaceId,
      thresholds.tombstoneTtlDays
    )
    const tombstoneSamples = memoryFactRepository.findTombstones(
      workspaceId,
      thresholds.tombstoneTtlDays,
      MAX_PREVIEW_SAMPLES
    )
    const confirmationsPruned = memoryFactRepository.countPrunableRetrievalConfirmations(
      thresholds.retrievalTtlDays
    )

    return {
      workspaceId,
      thresholds,
      idleArchive: {
        count: idle.length,
        samples: idle
          .slice(0, MAX_PREVIEW_SAMPLES)
          .map((f) => toSample(f, `idle ${idleDaysOf(f)}d, T${f.tier}`))
      },
      curatorCandidates: await this.previewCuratorCandidates(workspaceId),
      tombstoneDelete: {
        count: tombstoneCount,
        samples: tombstoneSamples.map((f) => toSample(f, `${f.status} since ${f.validTo ?? '?'}`))
      },
      confirmationsPruned,
      generatedAt: new Date().toISOString()
    }
  }

  /**
   * Run the sweep and record how to reverse it.
   *
   * Undo entries are captured BEFORE anything is mutated. Capturing them after
   * would record the post-archive state and make undo a no-op — a bug that
   * looks like it works.
   */
  async apply(
    workspaceId: string,
    options: {
      trigger: MemoryCleanupTrigger
      thresholds?: MemoryCleanupThresholds
      onProgress?: (progress: MemoryCleanupProgress) => void
    }
  ): Promise<MemoryCleanupRun | null> {
    if (this.running) {
      log.warn('[Cleanup] Sweep already running, skipping')
      return null
    }

    const thresholds = options.thresholds ?? DEFAULT_CLEANUP_THRESHOLDS
    const emit = (step: MemoryCleanupProgress['step'], message: string): void =>
      options.onProgress?.({ workspaceId, step, message, done: step === 'done' })

    this.running = true
    try {
      const stats: MemoryCleanupStats = {
        idleArchived: 0,
        curatorArchived: 0,
        curatorMerged: 0,
        curatorCalls: 0,
        tombstonesDeleted: 0,
        edgesDeleted: 0,
        contradictionsDeleted: 0,
        confirmationsPruned: 0
      }
      const undo: CleanupUndoEntry[] = []

      // 1. Idle archival — reversible.
      emit('scanning', 'Scanning for idle facts…')
      const idle = this.findIdleCandidates(workspaceId, thresholds.idleArchiveDays)
      if (idle.length > 0) {
        emit('archiving', `Archiving ${idle.length} idle fact(s)…`)
        for (const fact of idle) undo.push(undoEntryFor(fact))
        stats.idleArchived = memoryFactRepository.archiveFacts(idle.map((f) => f.id))
      }

      // 2. Curator — reversible, opt-in, and its worst action is a soft archive.
      emit('curating', 'Reviewing near-duplicates…')
      const curated = await this.runCuratorIfEnabled(workspaceId)
      if (curated) {
        stats.curatorArchived = curated.archived
        stats.curatorMerged = curated.merged
        stats.curatorCalls = curated.calls
        undo.push(...curated.undo)
      }

      // 3. Tombstone GC — NOT reversible. Runs after archival on purpose:
      //    facts archived a moment ago carry a `valid_to` of now and cannot be
      //    inside the TTL, so this run can never delete what it just archived.
      emit('deleting', 'Removing expired tombstones…')
      const deleted = memoryFactRepository.hardDeleteTombstones(
        workspaceId,
        thresholds.tombstoneTtlDays
      )
      stats.tombstonesDeleted = deleted.facts
      stats.edgesDeleted = deleted.edges
      stats.contradictionsDeleted = deleted.contradictions

      // 4. Confirmation log compaction.
      emit('compacting', 'Compacting the confirmation log…')
      stats.confirmationsPruned = memoryFactRepository.pruneRetrievalConfirmations(
        thresholds.retrievalTtlDays
      )
      memoryCleanupRunRepository.pruneExpiredUndoLogs(UNDO_TTL_DAYS)

      const run = memoryCleanupRunRepository.create({
        workspaceId,
        mode: 'apply',
        trigger: options.trigger,
        stats,
        undo
      })

      log.info(
        `[Cleanup] Applied: ${stats.idleArchived} idle archived, ` +
          `${stats.curatorArchived + stats.curatorMerged} curated, ` +
          `${stats.tombstonesDeleted} tombstones deleted, ` +
          `${stats.confirmationsPruned} confirmation rows pruned`
      )
      emit('done', 'Cleanup complete')
      return run
    } catch (err) {
      log.warn('[Cleanup] Sweep failed:', err)
      options.onProgress?.({
        workspaceId,
        step: 'done',
        message: 'Cleanup failed',
        done: true,
        error: err instanceof Error ? err.message : String(err)
      })
      return null
    } finally {
      this.running = false
    }
  }

  /**
   * Reverse the most recent reversible run.
   *
   * Hard-deleted rows do not come back — they were never in the undo log. What
   * returns is every fact the run archived, at its exact prior status, tier and
   * validity window.
   */
  undo(workspaceId: string): { runId: string; restored: number } | null {
    const run = memoryCleanupRunRepository.findUndoable(workspaceId, UNDO_TTL_DAYS)
    if (!run) return null

    const entries = memoryCleanupRunRepository.getUndoEntries(run.id)

    // Claim the run before restoring. If two undo presses race, the loser gets
    // false here and does not re-apply the restore over whatever happened next.
    if (!memoryCleanupRunRepository.markUndone(run.id)) return null

    const restored = memoryFactRepository.restoreFacts(entries)
    log.info(`[Cleanup] Undid run ${run.id}: restored ${restored} fact(s)`)
    return { runId: run.id, restored }
  }

  /** Recent sweeps for this workspace, newest first. */
  listRuns(workspaceId: string, limit = 10): MemoryCleanupRun[] {
    return memoryCleanupRunRepository.listRecent(workspaceId, limit)
  }

  /** The run the UI would reverse, or null when nothing is reversible. */
  findUndoableRun(workspaceId: string): MemoryCleanupRun | null {
    return memoryCleanupRunRepository.findUndoable(workspaceId, UNDO_TTL_DAYS) ?? null
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /** Active facts that pass the idle rule. One query plus one batched lookup. */
  private findIdleCandidates(workspaceId: string, idleDays: number): MemoryFact[] {
    const active = memoryFactRepository.findByWorkspace(workspaceId, 'active')
    if (active.length === 0) return []
    const humanConfirmed = memoryFactRepository.getHumanConfirmedIds(active.map((f) => f.id))
    return selectIdleArchivalCandidates(active, { workspaceId, idleDays, humanConfirmed })
  }

  /**
   * Ask the curator what it would do, without calling a model.
   *
   * Imported lazily for the same reason reflection is: the curator pulls in the
   * Claude CLI runner, and the cleanup service is loaded by the IPC layer on
   * every launch.
   */
  private async previewCuratorCandidates(
    workspaceId: string
  ): Promise<MemoryCleanupPreview['curatorCandidates']> {
    try {
      const { memoryCuratorService } = await import('./memory-curator.service')
      if (!memoryCuratorService.isEnabled(workspaceId)) return { count: 0, samples: [] }
      const candidates = memoryCuratorService.findCandidates(workspaceId)
      return {
        count: candidates.length,
        samples: candidates
          .slice(0, MAX_PREVIEW_SAMPLES)
          .map((f) => toSample(f, 'near-duplicate, needs judgement'))
      }
    } catch (err) {
      log.warn('[Cleanup] Curator preview unavailable:', err)
      return { count: 0, samples: [] }
    }
  }

  /** Run the curator when the workspace opted in. Never throws into the sweep. */
  private async runCuratorIfEnabled(
    workspaceId: string
  ): Promise<{ archived: number; merged: number; calls: number; undo: CleanupUndoEntry[] } | null> {
    try {
      const { memoryCuratorService } = await import('./memory-curator.service')
      if (!memoryCuratorService.isEnabled(workspaceId)) return null
      return await memoryCuratorService.curate(workspaceId)
    } catch (err) {
      log.warn('[Cleanup] Curator pass failed:', err)
      return null
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function daysSince(dateStr: string, now: number): number {
  const then = new Date(dateStr).getTime()
  if (!Number.isFinite(then)) return 0
  return Math.floor((now - then) / (24 * 60 * 60 * 1000))
}

function idleDaysOf(fact: MemoryFact): number {
  return daysSince(fact.lastAccessedAt ?? fact.lastConfirmedAt ?? fact.createdAt, Date.now())
}

function toSample(fact: MemoryFact, reason: string): MemoryCleanupSample {
  return {
    id: fact.id,
    title: fact.title,
    tier: fact.tier,
    category: fact.category,
    reason
  }
}

export const memoryCleanupService = new MemoryCleanupService()
