import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type { E2EResultStatus, E2EAssertionResult, E2ETranscriptEntry } from '../../../shared/types'

// ── Database row (snake_case) ──

interface E2ETestResultRow {
  id: string
  run_id: string
  scenario_id: string
  status: string
  duration_ms: number | null
  failure_reason: string | null
  assertion_results: string | null
  transcript_json: string | null
  conversation_id: string | null
  created_at: string
}

// ── Application model (camelCase) ──

export interface E2ETestResultRecord {
  id: string
  runId: string
  scenarioId: string
  status: E2EResultStatus
  durationMs: number | null
  failureReason: string | null
  assertionResults: E2EAssertionResult[]
  transcriptJson: E2ETranscriptEntry[]
  conversationId: string | null
  createdAt: string
}

function toModel(row: E2ETestResultRow): E2ETestResultRecord {
  return {
    id: row.id,
    runId: row.run_id,
    scenarioId: row.scenario_id,
    status: row.status as E2EResultStatus,
    durationMs: row.duration_ms,
    failureReason: row.failure_reason,
    assertionResults: safeParseJSON<E2EAssertionResult[]>(row.assertion_results, []),
    transcriptJson: safeParseJSON<E2ETranscriptEntry[]>(row.transcript_json, []),
    conversationId: row.conversation_id,
    createdAt: row.created_at
  }
}

export class E2ETestResultRepository extends BaseRepository<E2ETestResultRow, E2ETestResultRecord> {
  protected readonly tableName = 'e2e_test_results'

  protected mapRow(row: E2ETestResultRow): E2ETestResultRecord {
    return toModel(row)
  }

  create(runId: string, scenarioId: string): E2ETestResultRecord {
    const row = this.db()
      .prepare(
        `INSERT INTO e2e_test_results (run_id, scenario_id)
         VALUES (?, ?)
         RETURNING *`
      )
      .get(runId, scenarioId) as E2ETestResultRow
    return toModel(row)
  }

  createMany(runId: string, scenarioIds: string[]): E2ETestResultRecord[] {
    return this.runTransaction(() => {
      const stmt = this.db().prepare(
        `INSERT INTO e2e_test_results (run_id, scenario_id) VALUES (?, ?) RETURNING *`
      )
      return scenarioIds.map((sid) => toModel(stmt.get(runId, sid) as E2ETestResultRow))
    })
  }

  findByRun(runId: string): E2ETestResultRecord[] {
    return this.findManyBy('run_id', runId, { orderBy: 'created_at ASC' })
  }

  /**
   * Lightweight variant for run-results list — excludes heavy assertion_results and transcript_json.
   * Returns the same shape but with empty arrays for the heavy fields.
   */
  summariesByRun(runId: string): E2ETestResultRecord[] {
    const rows = this.db()
      .prepare(
        `SELECT id, run_id, scenario_id, status, duration_ms, failure_reason,
                conversation_id, created_at
         FROM e2e_test_results
         WHERE run_id = ?
         ORDER BY created_at ASC`
      )
      .all(runId) as E2ETestResultRow[]
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      scenarioId: row.scenario_id,
      status: row.status as E2EResultStatus,
      durationMs: row.duration_ms,
      failureReason: row.failure_reason,
      assertionResults: [],
      transcriptJson: [],
      conversationId: row.conversation_id,
      createdAt: row.created_at
    }))
  }

  updateStatus(
    id: string,
    status: E2EResultStatus,
    fields?: {
      durationMs?: number
      failureReason?: string
      assertionResults?: E2EAssertionResult[]
      transcriptJson?: E2ETranscriptEntry[]
      conversationId?: string
    }
  ): void {
    this.db()
      .prepare(
        `UPDATE e2e_test_results
         SET status = ?,
             duration_ms = COALESCE(?, duration_ms),
             failure_reason = COALESCE(?, failure_reason),
             assertion_results = COALESCE(?, assertion_results),
             transcript_json = COALESCE(?, transcript_json),
             conversation_id = COALESCE(?, conversation_id)
         WHERE id = ?`
      )
      .run(
        status,
        fields?.durationMs ?? null,
        fields?.failureReason ?? null,
        fields?.assertionResults ? JSON.stringify(fields.assertionResults) : null,
        fields?.transcriptJson ? JSON.stringify(fields.transcriptJson) : null,
        fields?.conversationId ?? null,
        id
      )
  }

  findFailedByRun(runId: string): E2ETestResultRecord[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM e2e_test_results
         WHERE run_id = ? AND status IN ('failed', 'error')
         ORDER BY created_at ASC`
      )
      .all(runId) as E2ETestResultRow[]
    return rows.map((r) => toModel(r))
  }

  countByStatus(runId: string): Record<E2EResultStatus, number> {
    const rows = this.db()
      .prepare(
        `SELECT status, COUNT(*) as cnt FROM e2e_test_results WHERE run_id = ? GROUP BY status`
      )
      .all(runId) as { status: string; cnt: number }[]

    const counts: Record<string, number> = {
      queued: 0,
      running: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      error: 0
    }
    for (const r of rows) counts[r.status] = r.cnt
    return counts as Record<E2EResultStatus, number>
  }
}

export const e2eTestResultRepository = new E2ETestResultRepository()
