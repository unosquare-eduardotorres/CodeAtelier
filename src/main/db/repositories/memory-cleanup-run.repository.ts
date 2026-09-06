/**
 * MemoryCleanupRunRepository — the undo log for the memory GC sweep.
 *
 * A sweep can archive hundreds of facts in one press. Per-item review is not an
 * option at that scale, so the safety gate is preview + undo rather than
 * selection, and this table is what makes undo possible: every entry records the
 * fact's `status` and `tier` as they were BEFORE the sweep touched it.
 *
 * Hard deletes are deliberately absent from `undo_json`. They are unrecoverable
 * by construction; the preview reports them as a separate, clearly-labelled
 * number so nobody presses Apply expecting them to be reversible.
 */

import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type {
  MemoryCleanupRun,
  MemoryCleanupStats,
  MemoryCleanupTrigger,
  MemoryFact,
  MemoryFactStatus,
  MemoryFactTier
} from '../../../shared/types'

/** One reversible mutation: what this fact looked like before the sweep. */
export interface CleanupUndoEntry {
  id: string
  prevStatus: MemoryFactStatus
  prevTier: MemoryFactTier
  /** Prior `valid_to`; null means the validity window was open. */
  prevValidTo: string | null
}

/**
 * Snapshot the state a fact must be returned to if its run is reversed.
 *
 * Lives beside the undo entry rather than in the cleanup service because both
 * the deterministic sweep and the LLM curator produce these, and having the
 * curator import it from the cleanup service made the two modules cyclic.
 */
export function undoEntryFor(fact: MemoryFact): CleanupUndoEntry {
  return {
    id: fact.id,
    prevStatus: fact.status,
    prevTier: fact.tier,
    prevValidTo: fact.validTo
  }
}

interface CleanupRunRow {
  id: string
  workspace_id: string
  mode: 'preview' | 'apply'
  trigger_source: MemoryCleanupTrigger
  stats_json: string
  undo_json: string
  undone_at: string | null
  created_at: string
}

const EMPTY_STATS: MemoryCleanupStats = {
  idleArchived: 0,
  curatorArchived: 0,
  curatorMerged: 0,
  curatorCalls: 0,
  tombstonesDeleted: 0,
  edgesDeleted: 0,
  contradictionsDeleted: 0,
  confirmationsPruned: 0
}

function mapRunRow(row: CleanupRunRow): MemoryCleanupRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    mode: row.mode,
    trigger: row.trigger_source,
    stats: { ...EMPTY_STATS, ...safeParseJSON<Partial<MemoryCleanupStats>>(row.stats_json, {}) },
    undoableCount: safeParseJSON<CleanupUndoEntry[]>(row.undo_json, []).length,
    undoneAt: row.undone_at,
    createdAt: row.created_at
  }
}

export class MemoryCleanupRunRepository extends BaseRepository<CleanupRunRow, MemoryCleanupRun> {
  protected readonly tableName = 'memory_cleanup_runs'
  protected mapRow(row: CleanupRunRow): MemoryCleanupRun {
    return mapRunRow(row)
  }

  /** Record a completed sweep along with the state needed to reverse it. */
  create(params: {
    workspaceId: string
    mode: 'preview' | 'apply'
    trigger: MemoryCleanupTrigger
    stats: MemoryCleanupStats
    undo: CleanupUndoEntry[]
  }): MemoryCleanupRun {
    const row = this.db()
      .prepare(
        `INSERT INTO memory_cleanup_runs
           (workspace_id, mode, trigger_source, stats_json, undo_json)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        params.workspaceId,
        params.mode,
        params.trigger,
        JSON.stringify(params.stats),
        JSON.stringify(params.undo)
      ) as CleanupRunRow
    return mapRunRow(row)
  }

  /** Most recent runs for a workspace, newest first. */
  listRecent(workspaceId: string, limit = 10): MemoryCleanupRun[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM memory_cleanup_runs
         WHERE workspace_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(workspaceId, limit) as CleanupRunRow[]
    return rows.map(mapRunRow)
  }

  /**
   * The newest applied run that is still reversible.
   *
   * "Still reversible" means not already undone, carrying at least one undo
   * entry, and inside the TTL — an undo of a months-old sweep would silently
   * resurrect facts that have since been superseded by newer knowledge.
   */
  findUndoable(workspaceId: string, ttlDays: number): MemoryCleanupRun | undefined {
    const row = this.db()
      .prepare(
        `SELECT * FROM memory_cleanup_runs
         WHERE workspace_id = ?
           AND mode = 'apply'
           AND undone_at IS NULL
           AND undo_json != '[]'
           AND julianday('now') - julianday(created_at) <= ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(workspaceId, ttlDays) as CleanupRunRow | undefined
    return row ? mapRunRow(row) : undefined
  }

  /** The stored undo entries for a run. Empty when the run is not reversible. */
  getUndoEntries(runId: string): CleanupUndoEntry[] {
    const row = this.db()
      .prepare(`SELECT undo_json FROM memory_cleanup_runs WHERE id = ?`)
      .get(runId) as { undo_json: string } | undefined
    return row ? safeParseJSON<CleanupUndoEntry[]>(row.undo_json, []) : []
  }

  /**
   * Mark a run as reversed.
   *
   * The undo log is cleared at the same time and in the same statement: leaving
   * it in place would let a second undo re-apply the same restore over whatever
   * the user did in between. Returns false when the run was already undone,
   * which is what makes concurrent undo presses safe.
   */
  markUndone(runId: string): boolean {
    const result = this.db()
      .prepare(
        `UPDATE memory_cleanup_runs
         SET undone_at = datetime('now'), undo_json = '[]'
         WHERE id = ? AND undone_at IS NULL`
      )
      .run(runId)
    return result.changes > 0
  }

  /**
   * Drop undo logs past the TTL, keeping the run row as a record of what ran.
   *
   * The logs are the bulky part — one entry per affected fact — and they are
   * dead weight the moment the run stops being reversible.
   */
  pruneExpiredUndoLogs(ttlDays: number): number {
    return this.db()
      .prepare(
        `UPDATE memory_cleanup_runs
         SET undo_json = '[]'
         WHERE undo_json != '[]'
           AND julianday('now') - julianday(created_at) > ?`
      )
      .run(ttlDays).changes
  }
}

export const memoryCleanupRunRepository = new MemoryCleanupRunRepository()
