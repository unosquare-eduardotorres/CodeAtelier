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
  /**
   * P3b — one row per WAVE / DRAIN-POINT gate run. These verdicts existed only
   * inside the phase artifact, so the W4 gate failure that killed a 49-minute
   * run was unqueryable: `drainCount: 1` said gates ran once, and nothing said
   * what they found.
   */
  | 'gate'
  /**
   * P3a — one row per BUILD-end reconciliation: does the tree still contain
   * what the completed tasks claimed? Written on every build, pass or fail, so
   * "15/15 verified" can be checked against the tree rather than trusted.
   */
  | 'reconciliation'
  /**
   * A6 — one row per enforced per-task commit (mode: enforced/failed). Tracks
   * how often the backstop had to fire vs. the agent committing on its own.
   * A6-fix adds mode: 'unattributable' — dirty files claimed by neither
   * filePathsJson nor completion.filesModified, left uncommitted on purpose.
   */
  | 'task_commit'
  /**
   * One row per kernel restore of a packet test file to its pre-session bytes,
   * carrying the stage that triggered it (ladder / escalation / sweep /
   * peer-review), the attempt and the file count. The restore is a decision
   * point the logs alone cannot settle: "does it rescue runs, or is it masking
   * a builder that keeps editing the spec" is a frequency question, and a
   * sweep firing on every task means the ladder's own restore is not reaching
   * the damage.
   */
  | 'test_restore'
  /**
   * E1-fix — one row per SPECIFY completion recording the CLARIFY auto-skip
   * decision (skipped or not, markerCount, veto state, reason). Without it
   * there is no way to tell "the skip works" from "it never fires" — in
   * particular the checklist false-positive path that suppresses every skip.
   */
  | 'clarify_skip'
  /**
   * F2 — one row per peer-review RE-GRADE, the verdict the task row cannot
   * carry. P3b deliberately re-asserts the original passing report after peer
   * review (the re-grade runs against a synthetic baseline), so a peer-review
   * fix attempt that broke the tree previously left no record anywhere — the
   * one ungated writer in the pipeline. This is that record.
   */
  | 'peer_review_regrade'
  /**
   * F4 — one row per in-ladder re-run of a task that failed on infrastructure
   * (a transport error, a session that never started). Separate from
   * `auto_retry`, which is PHASE-level: mixing them would make "did the task
   * ladder retry" unanswerable, and that question is exactly what the 6c4a6a85
   * post-mortem could not answer.
   */
  | 'infra_retry'
  /**
   * A1 — one row per resume DECISION on a BUILD retry: `attempted` when the
   * retry dispatches with a resumed session id, `succeeded` when that rung
   * completes, `declined` (with reason: not-safe / no-persisted-id /
   * provider-changed / stale / flag-off) when the ladder goes cold instead.
   * Three statuses rather than one, because "resume attempted" and "resume
   * actually happened" collapsing into one number is exactly what hid the E12
   * dropped-retry bug for weeks.
   */
  | 'session_resume'

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
        : this.db()
            .prepare(`SELECT kind, COUNT(*) AS n FROM blueprint_telemetry GROUP BY kind`)
            .all()
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
