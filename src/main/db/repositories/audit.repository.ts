import { getDatabase } from '../index'
import type {
  AuditRun,
  AuditResult,
  AuditTrackId,
  AuditMode,
  AuditRunStatus,
  AuditorStatus,
  AuditFinding
} from '../../../shared/types'

// ── Row shapes (snake_case from DB) ──

interface AuditRunRow {
  id: string
  workspace_id: string
  mode: string
  status: string
  overall_score: number | null
  selected_tracks: string // JSON
  detected_techs: string // JSON
  created_at: string
  updated_at: string
}

interface AuditResultRow {
  id: string
  audit_run_id: string
  track_id: string
  score: number | null
  status: string
  findings: string // JSON
  summary: string
  skills_used: string // JSON
  started_at: string | null
  completed_at: string | null
  created_at: string
}

// ── Row mappers ──

function mapRunRow(row: AuditRunRow, results: AuditResult[] = []): AuditRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    mode: row.mode as AuditMode,
    status: row.status as AuditRunStatus,
    overallScore: row.overall_score,
    selectedTracks: JSON.parse(row.selected_tracks) as AuditTrackId[],
    detectedTechs: JSON.parse(row.detected_techs) as string[],
    results,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapResultRow(row: AuditResultRow): AuditResult {
  return {
    id: row.id,
    auditRunId: row.audit_run_id,
    trackId: row.track_id as AuditTrackId,
    score: row.score,
    status: row.status as AuditorStatus,
    findings: JSON.parse(row.findings) as AuditFinding[],
    summary: row.summary ?? '',
    skillsUsed: JSON.parse(row.skills_used || '[]') as string[],
    startedAt: row.started_at,
    completedAt: row.completed_at
  }
}

// ── Repository ──

export class AuditRepository {
  /**
   * Create a new run, keeping only the 10 most recent runs for the workspace.
   * Returns the new run with empty results array.
   */
  createRun(
    workspaceId: string,
    mode: AuditMode,
    selectedTracks: AuditTrackId[],
    detectedTechs: string[]
  ): AuditRun {
    const db = getDatabase()

    // Keep only the 10 most recent runs (delete oldest beyond limit)
    // CASCADE delete on audit_runs removes child audit_results automatically
    db.prepare(
      `DELETE FROM audit_runs WHERE workspace_id = ? AND id NOT IN (
        SELECT id FROM audit_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 9
      )`
    ).run(workspaceId, workspaceId)

    const row = db
      .prepare(
        `INSERT INTO audit_runs (workspace_id, mode, status, selected_tracks, detected_techs)
         VALUES (?, ?, 'pending', ?, ?)
         RETURNING *`
      )
      .get(
        workspaceId,
        mode,
        JSON.stringify(selectedTracks),
        JSON.stringify(detectedTechs)
      ) as AuditRunRow

    return mapRunRow(row)
  }

  /** Create pending result rows for each selected track. */
  createResults(auditRunId: string, trackIds: AuditTrackId[]): AuditResult[] {
    const db = getDatabase()
    const stmt = db.prepare(
      `INSERT INTO audit_results (audit_run_id, track_id, status)
       VALUES (?, ?, 'pending')
       RETURNING *`
    )

    const results: AuditResult[] = []
    const tx = db.transaction(() => {
      for (const trackId of trackIds) {
        const row = stmt.get(auditRunId, trackId) as AuditResultRow
        results.push(mapResultRow(row))
      }
    })
    tx()
    return results
  }

  /** Update a single auditor result's status, score, findings, etc. */
  updateResult(
    resultId: string,
    update: {
      status?: AuditorStatus
      score?: number | null
      findings?: AuditFinding[]
      summary?: string
      skillsUsed?: string[]
      startedAt?: string | null
      completedAt?: string | null
    }
  ): AuditResult | null {
    const db = getDatabase()
    const sets: string[] = []
    const values: unknown[] = []

    if (update.status !== undefined) {
      sets.push('status = ?')
      values.push(update.status)
    }
    if (update.score !== undefined) {
      sets.push('score = ?')
      values.push(update.score)
    }
    if (update.findings !== undefined) {
      sets.push('findings = ?')
      values.push(JSON.stringify(update.findings))
    }
    if (update.summary !== undefined) {
      sets.push('summary = ?')
      values.push(update.summary)
    }
    if (update.skillsUsed !== undefined) {
      sets.push('skills_used = ?')
      values.push(JSON.stringify(update.skillsUsed))
    }
    if (update.startedAt !== undefined) {
      sets.push('started_at = ?')
      values.push(update.startedAt)
    }
    if (update.completedAt !== undefined) {
      sets.push('completed_at = ?')
      values.push(update.completedAt)
    }

    if (sets.length === 0) return null
    values.push(resultId)

    const row = db
      .prepare(`UPDATE audit_results SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
      .get(...values) as AuditResultRow | undefined

    return row ? mapResultRow(row) : null
  }

  /** Update the run's status and overall score. */
  updateRun(
    runId: string,
    update: { status?: AuditRunStatus; overallScore?: number | null }
  ): AuditRun | null {
    const db = getDatabase()
    const sets: string[] = ["updated_at = datetime('now')"]
    const values: unknown[] = []

    if (update.status !== undefined) {
      sets.push('status = ?')
      values.push(update.status)
    }
    if (update.overallScore !== undefined) {
      sets.push('overall_score = ?')
      values.push(update.overallScore)
    }

    values.push(runId)
    const row = db
      .prepare(`UPDATE audit_runs SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
      .get(...values) as AuditRunRow | undefined

    if (!row) return null

    const resultRows = db
      .prepare('SELECT * FROM audit_results WHERE audit_run_id = ? ORDER BY created_at')
      .all(runId) as AuditResultRow[]
    return mapRunRow(row, resultRows.map(mapResultRow))
  }

  /** Get the N most recent runs for a workspace, each joined with results. */
  getHistoryForWorkspace(workspaceId: string, limit: number = 10): AuditRun[] {
    const db = getDatabase()
    const runRows = db
      .prepare(
        'SELECT * FROM audit_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(workspaceId, limit) as AuditRunRow[]

    return runRows.map((row) => {
      const resultRows = db
        .prepare('SELECT * FROM audit_results WHERE audit_run_id = ? ORDER BY created_at')
        .all(row.id) as AuditResultRow[]
      return mapRunRow(row, resultRows.map(mapResultRow))
    })
  }

  /** Get the latest run for a workspace, joined with its results. */
  getLatestForWorkspace(workspaceId: string): AuditRun | null {
    const db = getDatabase()
    const runRow = db
      .prepare('SELECT * FROM audit_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(workspaceId) as AuditRunRow | undefined

    if (!runRow) return null

    const resultRows = db
      .prepare('SELECT * FROM audit_results WHERE audit_run_id = ? ORDER BY created_at')
      .all(runRow.id) as AuditResultRow[]

    return mapRunRow(runRow, resultRows.map(mapResultRow))
  }

  /** Delete the run for a workspace (CASCADE deletes results). */
  deleteForWorkspace(workspaceId: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM audit_runs WHERE workspace_id = ?').run(workspaceId)
  }

  /** Find a result by its ID. */
  findResultById(resultId: string): AuditResult | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM audit_results WHERE id = ?').get(resultId) as
      | AuditResultRow
      | undefined
    return row ? mapResultRow(row) : null
  }

  /** Find all results for a run. */
  findResultsByRunId(runId: string): AuditResult[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM audit_results WHERE audit_run_id = ? ORDER BY created_at')
      .all(runId) as AuditResultRow[]
    return rows.map(mapResultRow)
  }

  /** Find a result by run ID and track ID. */
  findResultByTrack(runId: string, trackId: AuditTrackId): AuditResult | null {
    const db = getDatabase()
    const row = db
      .prepare('SELECT * FROM audit_results WHERE audit_run_id = ? AND track_id = ?')
      .get(runId, trackId) as AuditResultRow | undefined
    return row ? mapResultRow(row) : null
  }
}

export const auditRepository = new AuditRepository()
