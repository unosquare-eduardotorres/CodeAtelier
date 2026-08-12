/**
 * MemoryBootstrapRepository — durable job queue for Feed Brain / Deep Scan.
 *
 * The bootstrap pipeline plans every unit of work up front (one row per
 * document / analysis task) and then drains the queue. That is what makes
 * item totals knowable, progress honest, and resume-after-quit possible.
 *
 * Tables: memory_bootstrap_runs, memory_bootstrap_items (migration 133).
 */

import { randomUUID } from 'node:crypto'
import { BaseRepository } from '../base-repository'
import type {
  BootstrapItemKind,
  BootstrapItemStatus,
  BootstrapItemView,
  BootstrapMode,
  BootstrapPhaseLabel,
  BootstrapPhaseStats,
  BootstrapRunStatus,
  BootstrapRunSummary,
  BootstrapScope
} from '../../../shared/types'

// ── Row shapes ──────────────────────────────────────────────────────────────

interface RunRow {
  id: string
  workspace_id: string
  mode: BootstrapMode
  scope: BootstrapScope
  status: BootstrapRunStatus
  current_phase: BootstrapPhaseLabel | null
  items_total: number
  items_done: number
  items_skipped: number
  items_failed: number
  facts_created: number
  active_ms: number
  error: string | null
  created_at: string
  finished_at: string | null
}

interface ItemRow {
  id: string
  run_id: string
  workspace_id: string
  phase: BootstrapPhaseLabel
  kind: BootstrapItemKind
  source_ref: string
  content_hash: string | null
  priority: number
  chunk_total: number
  chunk_done: number
  status: BootstrapItemStatus
  facts_created: number
  error: string | null
  updated_at: string
}

/** An item as handed to `planItems` — ids and counters are assigned here. */
export interface PlannedItem {
  phase: BootstrapPhaseLabel
  kind: BootstrapItemKind
  sourceRef: string
  contentHash?: string | null
  priority?: number
  chunkTotal?: number
}

export interface CreateRunInput {
  workspaceId: string
  mode: BootstrapMode
  scope: BootstrapScope
}

// ── Mappers ─────────────────────────────────────────────────────────────────

function mapItemRow(row: ItemRow): BootstrapItemView {
  return {
    id: row.id,
    runId: row.run_id,
    phase: row.phase,
    kind: row.kind,
    sourceRef: row.source_ref,
    contentHash: row.content_hash,
    priority: row.priority,
    chunkTotal: row.chunk_total,
    chunkDone: row.chunk_done,
    status: row.status,
    factsCreated: row.facts_created,
    error: row.error,
    updatedAt: row.updated_at
  }
}

// ── Repository ──────────────────────────────────────────────────────────────

export class MemoryBootstrapRepository extends BaseRepository<ItemRow, BootstrapItemView> {
  protected readonly tableName = 'memory_bootstrap_items'
  protected mapRow(row: ItemRow): BootstrapItemView {
    return mapItemRow(row)
  }

  // ── Runs ──────────────────────────────────────────────────────────────

  createRun(input: CreateRunInput): string {
    const id = randomUUID()
    this.db()
      .prepare(
        `INSERT INTO memory_bootstrap_runs (id, workspace_id, mode, scope, status)
         VALUES (?, ?, ?, ?, 'planning')`
      )
      .run(id, input.workspaceId, input.mode, input.scope)
    return id
  }

  getRun(runId: string): BootstrapRunSummary | undefined {
    const row = this.db().prepare('SELECT * FROM memory_bootstrap_runs WHERE id = ?').get(runId) as
      RunRow | undefined
    if (!row) return undefined
    return this.toSummary(row)
  }

  /**
   * Run summary with per-phase counts recomputed from the item rows.
   * The rollup is derived rather than stored so it cannot drift.
   */
  private toSummary(row: RunRow): BootstrapRunSummary {
    const phaseRows = this.db()
      .prepare(
        `SELECT phase,
                COUNT(*) AS total,
                SUM(CASE WHEN status IN ('done','skipped') THEN 1 ELSE 0 END) AS done,
                COALESCE(SUM(facts_created), 0) AS facts
           FROM memory_bootstrap_items
          WHERE run_id = ?
          GROUP BY phase`
      )
      .all(row.id) as Array<{ phase: string; total: number; done: number; facts: number }>

    const perPhase: Record<string, BootstrapPhaseStats> = {}
    for (const p of phaseRows) {
      perPhase[p.phase] = { total: p.total, done: p.done ?? 0, facts: p.facts ?? 0 }
    }

    return {
      id: row.id,
      workspaceId: row.workspace_id,
      mode: row.mode,
      scope: row.scope,
      status: row.status,
      currentPhase: row.current_phase,
      itemsTotal: row.items_total,
      itemsDone: row.items_done,
      itemsSkipped: row.items_skipped,
      itemsFailed: row.items_failed,
      factsCreated: row.facts_created,
      activeMs: row.active_ms,
      error: row.error,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      perPhase
    }
  }

  updateRun(
    runId: string,
    patch: {
      status?: BootstrapRunStatus
      currentPhase?: BootstrapPhaseLabel | null
      itemsTotal?: number
      factsCreated?: number
      activeMs?: number
      error?: string | null
      finishedAt?: string | null
    }
  ): void {
    const sets: string[] = []
    const values: unknown[] = []

    if (patch.status !== undefined) {
      sets.push('status = ?')
      values.push(patch.status)
    }
    if (patch.currentPhase !== undefined) {
      sets.push('current_phase = ?')
      values.push(patch.currentPhase)
    }
    if (patch.itemsTotal !== undefined) {
      sets.push('items_total = ?')
      values.push(patch.itemsTotal)
    }
    if (patch.factsCreated !== undefined) {
      sets.push('facts_created = ?')
      values.push(patch.factsCreated)
    }
    if (patch.activeMs !== undefined) {
      sets.push('active_ms = ?')
      values.push(patch.activeMs)
    }
    if (patch.error !== undefined) {
      sets.push('error = ?')
      values.push(patch.error)
    }
    if (patch.finishedAt !== undefined) {
      sets.push('finished_at = ?')
      values.push(patch.finishedAt)
    }
    if (sets.length === 0) return

    values.push(runId)
    this.db()
      .prepare(`UPDATE memory_bootstrap_runs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values)
  }

  /** Recompute the run's item counters from its item rows. */
  syncRunCounters(runId: string): void {
    this.db()
      .prepare(
        `UPDATE memory_bootstrap_runs
            SET items_done    = (SELECT COUNT(*) FROM memory_bootstrap_items WHERE run_id = ? AND status = 'done'),
                items_skipped = (SELECT COUNT(*) FROM memory_bootstrap_items WHERE run_id = ? AND status = 'skipped'),
                items_failed  = (SELECT COUNT(*) FROM memory_bootstrap_items WHERE run_id = ? AND status = 'failed'),
                facts_created = (SELECT COALESCE(SUM(facts_created), 0) FROM memory_bootstrap_items WHERE run_id = ?)
          WHERE id = ?`
      )
      .run(runId, runId, runId, runId, runId)
  }

  listRuns(workspaceId: string, limit = 10): BootstrapRunSummary[] {
    const rows = this.db()
      .prepare(
        // created_at only has second granularity, so two runs started in the
        // same second tie. rowid breaks the tie in insertion order.
        `SELECT * FROM memory_bootstrap_runs
          WHERE workspace_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`
      )
      .all(workspaceId, limit) as RunRow[]
    return rows.map((r) => this.toSummary(r))
  }

  /** Most recent run for a workspace regardless of status. */
  getLatestRun(workspaceId: string): BootstrapRunSummary | undefined {
    const rows = this.listRuns(workspaceId, 1)
    return rows[0]
  }

  /**
   * Paused or still-marked-running rows that have unfinished work.
   * These are what the UI offers as "Resume".
   */
  findResumableRuns(workspaceId: string): BootstrapRunSummary[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM memory_bootstrap_runs
          WHERE workspace_id = ?
            AND status IN ('paused', 'running', 'planning')
          ORDER BY created_at DESC, rowid DESC`
      )
      .all(workspaceId) as RunRow[]
    return rows.map((r) => this.toSummary(r))
  }

  /**
   * Boot-time recovery. A crash or force-quit leaves rows claiming to be
   * `running` with no process behind them; demote them to `paused` so the user
   * gets a resumable run instead of a zombie that blocks new starts.
   * Any item left mid-flight goes back to `pending` (chunk_done is preserved,
   * so resume picks up inside the file rather than redoing it).
   */
  markOrphanedRunsPaused(): number {
    return this.runTransaction(() => {
      this.db()
        .prepare(
          `UPDATE memory_bootstrap_items
              SET status = 'pending', updated_at = datetime('now')
            WHERE status = 'running'`
        )
        .run()
      const info = this.db()
        .prepare(
          `UPDATE memory_bootstrap_runs
              SET status = 'paused'
            WHERE status IN ('running', 'planning')`
        )
        .run()
      return info.changes
    })
  }

  // ── Items ─────────────────────────────────────────────────────────────

  /** Insert the whole planned queue in one transaction. Returns the count. */
  planItems(runId: string, workspaceId: string, items: PlannedItem[]): number {
    if (items.length === 0) return 0
    const stmt = this.db().prepare(
      `INSERT INTO memory_bootstrap_items
         (id, run_id, workspace_id, phase, kind, source_ref, content_hash, priority, chunk_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    return this.runTransaction(() => {
      for (const item of items) {
        stmt.run(
          randomUUID(),
          runId,
          workspaceId,
          item.phase,
          item.kind,
          item.sourceRef,
          item.contentHash ?? null,
          item.priority ?? 100,
          item.chunkTotal ?? 0
        )
      }
      return items.length
    })
  }

  /**
   * Atomically claim the highest-priority pending item.
   *
   * The UPDATE…WHERE id = (SELECT …) is a single statement, so even though
   * better-sqlite3 is synchronous this stays correct if the drain loop ever
   * runs more than one worker.
   */
  claimNextItem(runId: string): BootstrapItemView | undefined {
    const row = this.db()
      .prepare(
        `UPDATE memory_bootstrap_items
            SET status = 'running', updated_at = datetime('now')
          WHERE id = (
            SELECT id FROM memory_bootstrap_items
             WHERE run_id = ? AND status = 'pending'
             ORDER BY priority ASC, rowid ASC
             LIMIT 1
          )
          RETURNING *`
      )
      .get(runId) as ItemRow | undefined
    return row ? mapItemRow(row) : undefined
  }

  /**
   * Kind of the next item that would be claimed, without claiming it.
   * The drain pool uses this to treat the Deep Scan agent as a barrier: it
   * must not start while document items are still in flight, because its
   * prompt embeds the "already recorded" fact list.
   */
  peekNextItemKind(runId: string): BootstrapItemKind | undefined {
    const row = this.db()
      .prepare(
        `SELECT kind FROM memory_bootstrap_items
          WHERE run_id = ? AND status = 'pending'
          ORDER BY priority ASC, rowid ASC
          LIMIT 1`
      )
      .get(runId) as { kind: BootstrapItemKind } | undefined
    return row?.kind
  }

  updateItem(
    itemId: string,
    patch: {
      status?: BootstrapItemStatus
      chunkDone?: number
      chunkTotal?: number
      factsCreated?: number
      contentHash?: string | null
      error?: string | null
    }
  ): void {
    const sets: string[] = []
    const values: unknown[] = []

    if (patch.status !== undefined) {
      sets.push('status = ?')
      values.push(patch.status)
    }
    if (patch.chunkDone !== undefined) {
      sets.push('chunk_done = ?')
      values.push(patch.chunkDone)
    }
    if (patch.chunkTotal !== undefined) {
      sets.push('chunk_total = ?')
      values.push(patch.chunkTotal)
    }
    if (patch.factsCreated !== undefined) {
      sets.push('facts_created = ?')
      values.push(patch.factsCreated)
    }
    if (patch.contentHash !== undefined) {
      sets.push('content_hash = ?')
      values.push(patch.contentHash)
    }
    if (patch.error !== undefined) {
      sets.push('error = ?')
      values.push(patch.error)
    }
    if (sets.length === 0) return

    sets.push("updated_at = datetime('now')")
    values.push(itemId)
    this.db()
      .prepare(`UPDATE memory_bootstrap_items SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values)
  }

  /**
   * Record chunk-level progress. Written after every chunk so a pause or
   * crash mid-file resumes inside the file instead of restarting it.
   */
  bumpChunkDone(itemId: string, chunkDone: number, factsCreated: number): void {
    this.db()
      .prepare(
        `UPDATE memory_bootstrap_items
            SET chunk_done = ?, facts_created = ?, updated_at = datetime('now')
          WHERE id = ?`
      )
      .run(chunkDone, factsCreated, itemId)
  }

  /** Release a claimed item back to the queue (used when pausing mid-item). */
  releaseItem(itemId: string): void {
    this.db()
      .prepare(
        `UPDATE memory_bootstrap_items
            SET status = 'pending', updated_at = datetime('now')
          WHERE id = ? AND status = 'running'`
      )
      .run(itemId)
  }

  listItems(
    runId: string,
    options: {
      status?: BootstrapItemStatus
      phase?: BootstrapPhaseLabel
      limit?: number
      offset?: number
    } = {}
  ): { items: BootstrapItemView[]; total: number } {
    const where: string[] = ['run_id = ?']
    const values: unknown[] = [runId]

    if (options.status) {
      where.push('status = ?')
      values.push(options.status)
    }
    if (options.phase) {
      where.push('phase = ?')
      values.push(options.phase)
    }
    const whereSql = where.join(' AND ')

    const total = (
      this.db()
        .prepare(`SELECT COUNT(*) AS n FROM memory_bootstrap_items WHERE ${whereSql}`)
        .get(...values) as { n: number }
    ).n

    // Surface active work first, then failures (the rows a user acts on),
    // then everything else in queue order.
    const rows = this.db()
      .prepare(
        `SELECT * FROM memory_bootstrap_items
          WHERE ${whereSql}
          ORDER BY CASE status
                     WHEN 'running' THEN 0
                     WHEN 'failed'  THEN 1
                     WHEN 'done'    THEN 2
                     WHEN 'skipped' THEN 3
                     ELSE 4
                   END,
                   priority ASC, rowid ASC
          LIMIT ? OFFSET ?`
      )
      .all(...values, options.limit ?? 100, options.offset ?? 0) as ItemRow[]

    return { items: rows.map(mapItemRow), total }
  }

  /** Count of items left to drain — the resume-worthiness check. */
  countPending(runId: string): number {
    return (
      this.db()
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_bootstrap_items
            WHERE run_id = ? AND status IN ('pending', 'running')`
        )
        .get(runId) as { n: number }
    ).n
  }

  deleteRun(runId: string): number {
    return this.db().prepare('DELETE FROM memory_bootstrap_runs WHERE id = ?').run(runId).changes
  }
}

export const memoryBootstrapRepository = new MemoryBootstrapRepository()
