import { BaseRepository } from '../base-repository'
import type { E2ERunStatus } from '../../../shared/types'

// ── Database row (snake_case) ──

interface E2ETestRunRow {
  id: string
  workspace_id: string
  status: string
  model_id: string | null
  backend: string | null
  started_at: string
  finished_at: string | null
  total_passed: number
  total_failed: number
  total_skipped: number
  total_error: number
}

// ── Application model (camelCase) ──

export interface E2ETestRunRecord {
  id: string
  workspaceId: string
  status: E2ERunStatus
  modelId: string | null
  backend: string | null
  startedAt: string
  finishedAt: string | null
  totalPassed: number
  totalFailed: number
  totalSkipped: number
  totalError: number
}

function toModel(row: E2ETestRunRow): E2ETestRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status as E2ERunStatus,
    modelId: row.model_id,
    backend: row.backend,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totalPassed: row.total_passed,
    totalFailed: row.total_failed,
    totalSkipped: row.total_skipped,
    totalError: row.total_error
  }
}

export class E2ETestRunRepository extends BaseRepository<E2ETestRunRow, E2ETestRunRecord> {
  protected readonly tableName = 'e2e_test_runs'

  protected mapRow(row: E2ETestRunRow): E2ETestRunRecord {
    return toModel(row)
  }

  create(workspaceId: string, modelId: string | null, backend: string | null): E2ETestRunRecord {
    const row = this.db()
      .prepare(
        `INSERT INTO e2e_test_runs (workspace_id, model_id, backend)
         VALUES (?, ?, ?)
         RETURNING *`
      )
      .get(workspaceId, modelId, backend) as E2ETestRunRow
    return toModel(row)
  }

  findByWorkspace(workspaceId: string, limit = 50): E2ETestRunRecord[] {
    return this.findManyBy('workspace_id', workspaceId, {
      orderBy: 'started_at DESC',
      limit
    })
  }

  updateStatus(
    id: string,
    status: E2ERunStatus,
    totals?: { passed: number; failed: number; skipped: number; error: number }
  ): void {
    if (totals) {
      this.db()
        .prepare(
          `UPDATE e2e_test_runs
           SET status = ?, finished_at = datetime('now'),
               total_passed = ?, total_failed = ?, total_skipped = ?, total_error = ?
           WHERE id = ?`
        )
        .run(status, totals.passed, totals.failed, totals.skipped, totals.error, id)
    } else {
      this.db()
        .prepare(`UPDATE e2e_test_runs SET status = ? WHERE id = ?`)
        .run(status, id)
    }
  }

  updateTotals(id: string, totals: { passed: number; failed: number; skipped: number; error: number }): void {
    this.db()
      .prepare(
        `UPDATE e2e_test_runs
         SET total_passed = ?, total_failed = ?, total_skipped = ?, total_error = ?
         WHERE id = ?`
      )
      .run(totals.passed, totals.failed, totals.skipped, totals.error, id)
  }
}

export const e2eTestRunRepository = new E2ETestRunRepository()
