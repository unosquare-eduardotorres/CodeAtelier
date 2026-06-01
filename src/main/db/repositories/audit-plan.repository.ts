import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type { AuditPlan, AuditPlanRecord } from '../../../shared/types'

// ── Row shape (snake_case from DB) ──

interface AuditPlanRow {
  id: string
  audit_run_id: string
  title: string
  summary: string
  plan_json: string // JSON
  source_finding_ids: string // JSON
  created_at: string
}

function mapRow(row: AuditPlanRow): AuditPlanRecord {
  return {
    id: row.id,
    auditRunId: row.audit_run_id,
    title: row.title,
    summary: row.summary ?? '',
    plan: safeParseJSON<AuditPlan>(row.plan_json, {
      version: 1,
      title: row.title,
      summary: row.summary ?? '',
      items: [],
      risks: [],
      sourceFindingIds: [],
      requirementDocument: ''
    }),
    sourceFindingIds: safeParseJSON<string[]>(row.source_finding_ids, []),
    createdAt: row.created_at
  }
}

// ── Repository ──

export class AuditPlanRepository extends BaseRepository<AuditPlanRow, AuditPlanRecord> {
  protected readonly tableName = 'audit_plans'
  protected mapRow(row: AuditPlanRow): AuditPlanRecord {
    return mapRow(row)
  }

  /** Persist a generated plan for a run. Returns the saved record. */
  savePlan(auditRunId: string, plan: AuditPlan): AuditPlanRecord {
    const row = this.db()
      .prepare(
        `INSERT INTO audit_plans (audit_run_id, title, summary, plan_json, source_finding_ids)
         VALUES (?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        auditRunId,
        plan.title,
        plan.summary,
        JSON.stringify(plan),
        JSON.stringify(plan.sourceFindingIds ?? [])
      ) as AuditPlanRow

    return mapRow(row)
  }

  /** Get all plans for a run, newest first. */
  getPlansForRun(auditRunId: string): AuditPlanRecord[] {
    const rows = this.db()
      .prepare('SELECT * FROM audit_plans WHERE audit_run_id = ? ORDER BY created_at DESC')
      .all(auditRunId) as AuditPlanRow[]
    return rows.map(mapRow)
  }
}

export const auditPlanRepository = new AuditPlanRepository()
