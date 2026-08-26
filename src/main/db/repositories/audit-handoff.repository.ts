/**
 * audit-handoff.repository — tracks which audit findings were already routed
 * somewhere for remediation (chat or blueprint).
 *
 * Rows are scoped to an audit run: finding ids are regenerated on every audit,
 * so a re-run starts from a clean slate by construction. Multiple rows per
 * finding are allowed — handing the same finding off again is a legitimate
 * action, and the newest row is what the UI shows.
 */

import { BaseRepository } from '../base-repository'
import type { AuditFindingHandoff, AuditHandoffTarget } from '../../../shared/types'

// ── Row shape (snake_case from DB) ──

interface AuditFindingHandoffRow {
  id: string
  audit_run_id: string
  finding_id: string
  target: string
  ref_id: string | null
  ref_title: string | null
  created_at: string
}

function mapRow(row: AuditFindingHandoffRow): AuditFindingHandoff {
  return {
    id: row.id,
    auditRunId: row.audit_run_id,
    findingId: row.finding_id,
    target: row.target as AuditHandoffTarget,
    refId: row.ref_id,
    refTitle: row.ref_title,
    createdAt: row.created_at
  }
}

export class AuditHandoffRepository extends BaseRepository<
  AuditFindingHandoffRow,
  AuditFindingHandoff
> {
  protected readonly tableName = 'audit_finding_handoffs'
  protected mapRow(row: AuditFindingHandoffRow): AuditFindingHandoff {
    return mapRow(row)
  }

  /**
   * Record one handoff per finding. Written in a single transaction so a
   * partially-marked selection can never survive a failure mid-loop.
   */
  record(params: {
    auditRunId: string
    findingIds: string[]
    target: AuditHandoffTarget
    refId?: string | null
    refTitle?: string | null
  }): AuditFindingHandoff[] {
    const { auditRunId, findingIds, target, refId = null, refTitle = null } = params
    if (findingIds.length === 0) return []

    const stmt = this.db().prepare(
      `INSERT INTO audit_finding_handoffs (audit_run_id, finding_id, target, ref_id, ref_title)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`
    )

    const insertAll = this.db().transaction((ids: string[]): AuditFindingHandoff[] =>
      ids.map((findingId) =>
        mapRow(stmt.get(auditRunId, findingId, target, refId, refTitle) as AuditFindingHandoffRow)
      )
    )

    return insertAll(findingIds)
  }

  /** All handoffs for a run, newest first. */
  findByRun(auditRunId: string): AuditFindingHandoff[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM audit_finding_handoffs
         WHERE audit_run_id = ?
         ORDER BY created_at DESC, rowid DESC`
      )
      .all(auditRunId) as AuditFindingHandoffRow[]
    return rows.map(mapRow)
  }
}

export const auditHandoffRepository = new AuditHandoffRepository()
