/**
 * Blueprint telemetry repository — E11, attempt-level execution telemetry.
 *
 * The decisions that matter most operationally in a blueprint run — why a task
 * was retried, why a ladder stopped early, why parallelism dropped, how long a
 * phase sat silent — existed only as log lines and in-memory `SchedulerStats`.
 * Every tuning question about them ("is the stop-loss too sensitive?", "does the
 * backoff schedule fit the provider's recovery time?") was therefore answered by
 * guessing. This table makes them answerable from a real run.
 *
 * Its own table rather than a widening of `events`: see migration 156 for why
 * (short version — `events.category`'s CHECK has diverged between schema.sql and
 * the migrated chain since migration 44).
 *
 * Writes are `better-sqlite3`-SYNCHRONOUS. Call sites must therefore record
 * AFTER the hot-path decision has been taken and dispatched, never between a
 * dispatch and its settle.
 */

import log from 'electron-log'
import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'

const telemetryLog = log.scope('blueprint-telemetry')

/**
 * Telemetry kinds in use. Deliberately NOT a DB CHECK — adding a kind must never
 * require a table rebuild, which is the lesson of migration 44. The union is a
 * compile-time aid only; the column accepts any string.
 */
export type BlueprintTelemetryKind =
  | 'config'
  | 'stall'
  | 'nudge'
  | 'auto_retry'
  | 'overload'
  | 'escalation'
  | 'stop_loss'
  | 'scheduler'
  /** P2 — one row per structured failure-memory extraction on a BUILD retry. */
  | 'failure_memory'
  /**
   * P1/M0/R1 — one row per failed ATTEMPT of a BUILD task, carrying the typed
   * `failureClass` and the attempt index. Written from inside the gate ladder,
   * not at settle: settle runs once per task, so a task that fails and then
   * succeeds would record nothing — and that is the population the retry-cause
   * split is about. Append-only on purpose: `blueprint_tasks.failure_reason` is
   * cleared when a retry eventually succeeds, so the task row cannot answer
   * "what caused the retries" — only this can.
   */
  | 'task_failure'

export interface BlueprintTelemetryRow {
  id: string
  blueprintId: string
  phase: string | null
  taskId: string | null
  attempt: number | null
  kind: string
  data: Record<string, unknown>
  createdAt: string
}

interface TelemetrySqlRow {
  id: string
  blueprint_id: string
  phase: string | null
  task_id: string | null
  attempt: number | null
  kind: string
  data_json: string
  created_at: string
}

export interface RecordTelemetryInput {
  blueprintId: string
  kind: BlueprintTelemetryKind
  phase?: string | null
  taskId?: string | null
  attempt?: number | null
  data?: Record<string, unknown>
}

export class BlueprintTelemetryRepository extends BaseRepository<
  TelemetrySqlRow,
  BlueprintTelemetryRow
> {
  protected readonly tableName = 'blueprint_telemetry'

  protected mapRow(row: TelemetrySqlRow): BlueprintTelemetryRow {
    return {
      id: row.id,
      blueprintId: row.blueprint_id,
      phase: row.phase,
      taskId: row.task_id,
      attempt: row.attempt,
      kind: row.kind,
      data: safeParseJSON<Record<string, unknown>>(row.data_json, {}),
      createdAt: row.created_at
    }
  }

  /**
   * Append one telemetry row.
   *
   * Never throws. Telemetry is an observer of the pipeline, not a participant:
   * a failed insert must not be able to fail the build it is describing. The
   * cost of that choice is that a broken writer is silent apart from this log
   * line — which is the right trade for a diagnostic side-channel.
   */
  record(input: RecordTelemetryInput): void {
    try {
      this.db()
        .prepare(
          `INSERT INTO blueprint_telemetry
             (blueprint_id, phase, task_id, attempt, kind, data_json)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.blueprintId,
          input.phase ?? null,
          input.taskId ?? null,
          input.attempt ?? null,
          input.kind,
          JSON.stringify(input.data ?? {})
        )
    } catch (err) {
      telemetryLog.warn(`[telemetry] record(${input.kind}) failed:`, err)
    }
  }

  /** All telemetry for one blueprint, oldest first — the run's narrative order. */
  findByBlueprint(blueprintId: string): BlueprintTelemetryRow[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM blueprint_telemetry
         WHERE blueprint_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(blueprintId) as TelemetrySqlRow[]
    return rows.map((r) => this.mapRow(r))
  }

  /**
   * kind → count for one blueprint, or across all blueprints when omitted.
   * The shape most tuning questions start from ("how often does this fire?").
   */
  countByKind(blueprintId?: string): Record<string, number> {
    const rows = (
      blueprintId
        ? this.db()
            .prepare(
              `SELECT kind, COUNT(*) AS n FROM blueprint_telemetry
               WHERE blueprint_id = ? GROUP BY kind`
            )
            .all(blueprintId)
        : this.db().prepare(`SELECT kind, COUNT(*) AS n FROM blueprint_telemetry GROUP BY kind`).all()
    ) as { kind: string; n: number }[]

    const out: Record<string, number> = {}
    for (const r of rows) out[r.kind] = r.n
    return out
  }

  /**
   * Delete rows older than `days`. Per-attempt rows grow without bound — a busy
   * workspace writes several per task per attempt — and nothing else deletes
   * them, since the table deliberately has no FK to `blueprints`.
   */
  pruneOlderThan(days: number): number {
    if (!Number.isFinite(days) || days < 0) return 0
    const info = this.db()
      .prepare(`DELETE FROM blueprint_telemetry WHERE created_at < datetime('now', ?)`)
      .run(`-${Math.floor(days)} days`)
    if (info.changes > 0) {
      telemetryLog.info(`[telemetry] Pruned ${info.changes} row(s) older than ${days}d`)
    }
    return info.changes
  }
}

export const blueprintTelemetryRepository = new BlueprintTelemetryRepository()
