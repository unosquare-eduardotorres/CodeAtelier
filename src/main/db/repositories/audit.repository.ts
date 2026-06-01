import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type {
  AuditRun,
  AuditResult,
  AuditTrackId,
  AuditMode,
  AuditRunStatus,
  AuditorStatus,
  AuditFinding,
  AuditCoverageStats,
  AuditSelectedSkills
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
  selected_skills: string | null // JSON (per-track skill ids)
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
  coverage_stats: string | null // JSON
  coverage_sufficient: number | null // 0/1 boolean
}

// ── Row mappers ──

function mapRunRow(row: AuditRunRow, results: AuditResult[] = []): AuditRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    mode: row.mode as AuditMode,
    status: row.status as AuditRunStatus,
    overallScore: row.overall_score,
    selectedTracks: safeParseJSON<AuditTrackId[]>(row.selected_tracks, []),
    detectedTechs: safeParseJSON<string[]>(row.detected_techs, []),
    selectedSkills: safeParseJSON<AuditSelectedSkills>(row.selected_skills, {}),
    results,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapResultRow(row: AuditResultRow): AuditResult {
  const coverageStats = safeParseJSON<AuditCoverageStats | undefined>(row.coverage_stats, undefined)

  return {
    id: row.id,
    auditRunId: row.audit_run_id,
    trackId: row.track_id as AuditTrackId,
    score: row.score,
    status: row.status as AuditorStatus,
    findings: safeParseJSON<AuditFinding[]>(row.findings, []),
    summary: row.summary ?? '',
    skillsUsed: safeParseJSON<string[]>(row.skills_used, []),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    coverageStats,
    coverageSufficient: row.coverage_sufficient === null ? undefined : row.coverage_sufficient === 1
  }
}

// ── Repository ──

export class AuditRepository extends BaseRepository<AuditRunRow, AuditRun> {
  protected readonly tableName = 'audit_runs'
  protected mapRow(row: AuditRunRow): AuditRun { return mapRunRow(row) }

  /**
   * Create a new run, keeping only the 10 most recent runs for the workspace.
   * Returns the new run with empty results array.
   */
  createRun(
    workspaceId: string,
    mode: AuditMode,
    selectedTracks: AuditTrackId[],
    detectedTechs: string[],
    selectedSkills: AuditSelectedSkills = {}
  ): AuditRun {
    const db = this.db()

    // Keep only the 10 most recent runs (delete oldest beyond limit)
    // CASCADE delete on audit_runs removes child audit_results automatically
    db.prepare(
      `DELETE FROM audit_runs WHERE workspace_id = ? AND id NOT IN (
        SELECT id FROM audit_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 9
      )`
    ).run(workspaceId, workspaceId)

    const row = db
      .prepare(
        `INSERT INTO audit_runs (workspace_id, mode, status, selected_tracks, detected_techs, selected_skills)
         VALUES (?, ?, 'pending', ?, ?, ?)
         RETURNING *`
      )
      .get(
        workspaceId,
        mode,
        JSON.stringify(selectedTracks),
        JSON.stringify(detectedTechs),
        JSON.stringify(selectedSkills)
      ) as AuditRunRow

    return mapRunRow(row)
  }

  /** Create pending result rows for each selected track. */
  createResults(auditRunId: string, trackIds: AuditTrackId[]): AuditResult[] {
    const db = this.db()
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
      coverageStats?: AuditCoverageStats
      coverageSufficient?: boolean
    }
  ): AuditResult | null {
    const db = this.db()
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
    if (update.coverageStats !== undefined) {
      sets.push('coverage_stats = ?')
      values.push(JSON.stringify(update.coverageStats))
    }
    if (update.coverageSufficient !== undefined) {
      sets.push('coverage_sufficient = ?')
      values.push(update.coverageSufficient ? 1 : 0)
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
    const db = this.db()
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
    const db = this.db()
    const runRows = db
      .prepare('SELECT * FROM audit_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(workspaceId, limit) as AuditRunRow[]

    return runRows.map((row) => {
      const resultRows = db
        .prepare('SELECT * FROM audit_results WHERE audit_run_id = ? ORDER BY created_at')
        .all(row.id) as AuditResultRow[]
      return mapRunRow(row, resultRows.map(mapResultRow))
    })
  }

  /** Find a single run by id, joined with its results. */
  findRunById(runId: string): AuditRun | null {
    const db = this.db()
    const runRow = db.prepare('SELECT * FROM audit_runs WHERE id = ?').get(runId) as
      | AuditRunRow
      | undefined
    if (!runRow) return null
    const resultRows = db
      .prepare('SELECT * FROM audit_results WHERE audit_run_id = ? ORDER BY created_at')
      .all(runId) as AuditResultRow[]
    return mapRunRow(runRow, resultRows.map(mapResultRow))
  }

  /** Delete a run (and, via CASCADE, its results). Returns true if a row was removed. */
  deleteRun(runId: string): boolean {
    const db = this.db()
    const info = db.prepare('DELETE FROM audit_runs WHERE id = ?').run(runId)
    return info.changes > 0
  }

  /** Get the latest run for a workspace, joined with its results. */
  getLatestForWorkspace(workspaceId: string): AuditRun | null {
    const db = this.db()
    const runRow = db
      .prepare('SELECT * FROM audit_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(workspaceId) as AuditRunRow | undefined

    if (!runRow) return null

    const resultRows = db
      .prepare('SELECT * FROM audit_results WHERE audit_run_id = ? ORDER BY created_at')
      .all(runRow.id) as AuditResultRow[]

    return mapRunRow(runRow, resultRows.map(mapResultRow))
  }


  /** Find a result by its ID. */
  findResultById(resultId: string): AuditResult | null {
    const db = this.db()
    const row = db.prepare('SELECT * FROM audit_results WHERE id = ?').get(resultId) as
      | AuditResultRow
      | undefined
    return row ? mapResultRow(row) : null
  }

  /** Find all results for a run. */
  findResultsByRunId(runId: string): AuditResult[] {
    const db = this.db()
    const rows = db
      .prepare('SELECT * FROM audit_results WHERE audit_run_id = ? ORDER BY created_at')
      .all(runId) as AuditResultRow[]
    return rows.map(mapResultRow)
  }

  /** Find a result by run ID and track ID. */
  findResultByTrack(runId: string, trackId: AuditTrackId): AuditResult | null {
    const db = this.db()
    const row = db
      .prepare('SELECT * FROM audit_results WHERE audit_run_id = ? AND track_id = ?')
      .get(runId, trackId) as AuditResultRow | undefined
    return row ? mapResultRow(row) : null
  }
}

export const auditRepository = new AuditRepository()
