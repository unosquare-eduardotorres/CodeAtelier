/**
 * plan.repository — CRUD + lifecycle for the unified plans registry.
 *
 * The `plans` table is a write-alongside registry: plans are auto-registered
 * from Chat, Grill, Audit, Council, and MPA sources. Existing source tables
 * remain untouched — this table provides cross-modal visibility and lifecycle.
 */

import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type {
  StructuredPlan,
  PlanRecord,
  PlanSource,
  PlanStatus,
  PlanType,
  PlanFilters
} from '../../../shared/types'

// ── Row shape (snake_case from DB) ──

interface PlanRow {
  id: string
  workspace_id: string
  source: PlanSource
  source_id: string
  title: string
  summary: string
  plan_type: string | null
  structured_plan_json: string
  source_plan_json: string | null
  requirement_document: string | null
  status: PlanStatus
  linked_conversation_id: string | null
  linked_mpa_run_id: string | null
  linked_council_session_id: string | null
  file_count: number
  phase_count: number
  risk_count: number
  created_at: string
  updated_at: string
}

function mapRow(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    source: row.source,
    sourceId: row.source_id,
    title: row.title,
    summary: row.summary ?? '',
    planType: (row.plan_type as PlanType) ?? null,
    structuredPlan: safeParseJSON<StructuredPlan>(row.structured_plan_json, {
      title: row.title,
      summary: row.summary ?? ''
    }),
    sourcePlanJson: row.source_plan_json,
    requirementDocument: row.requirement_document,
    status: row.status,
    linkedConversationId: row.linked_conversation_id,
    linkedMpaRunId: row.linked_mpa_run_id,
    linkedCouncilSessionId: row.linked_council_session_id,
    fileCount: row.file_count ?? 0,
    phaseCount: row.phase_count ?? 0,
    riskCount: row.risk_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ── Save params ──

export interface SavePlanParams {
  workspaceId: string
  source: PlanSource
  sourceId: string
  title: string
  summary: string
  planType?: PlanType | null
  structuredPlan: StructuredPlan
  sourcePlanJson?: string | null
  requirementDocument?: string | null
  linkedConversationId?: string | null
  linkedMpaRunId?: string | null
  linkedCouncilSessionId?: string | null
}

// ── Derived metrics ──

function deriveCounts(plan: StructuredPlan): {
  fileCount: number
  phaseCount: number
  riskCount: number
} {
  const files = new Set<string>()
  if (plan.files) plan.files.forEach((f) => files.add(f))
  if (plan.filesChanged) plan.filesChanged.forEach((f) => files.add(f.file))
  if (plan.phases) {
    for (const phase of plan.phases) {
      if (phase.files) phase.files.forEach((f) => files.add(f.file))
    }
  }
  return {
    fileCount: files.size,
    phaseCount: plan.phases?.length ?? 0,
    riskCount: plan.risks?.length ?? 0
  }
}

// ── Repository ──

const RETENTION_LIMIT = 50

export class PlanRepository extends BaseRepository<PlanRow, PlanRecord> {
  protected readonly tableName = 'plans'
  protected mapRow(row: PlanRow): PlanRecord {
    return mapRow(row)
  }

  /** Persist a plan to the registry. Returns the saved record. */
  savePlan(params: SavePlanParams): PlanRecord {
    const counts = deriveCounts(params.structuredPlan)

    const row = this.db()
      .prepare(
        `INSERT INTO plans (
          workspace_id, source, source_id, title, summary, plan_type,
          structured_plan_json, source_plan_json, requirement_document,
          linked_conversation_id, linked_mpa_run_id, linked_council_session_id,
          file_count, phase_count, risk_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *`
      )
      .get(
        params.workspaceId,
        params.source,
        params.sourceId,
        params.title,
        params.summary,
        params.planType ?? params.structuredPlan.type ?? null,
        JSON.stringify(params.structuredPlan),
        params.sourcePlanJson ?? null,
        params.requirementDocument ?? null,
        params.linkedConversationId ?? null,
        params.linkedMpaRunId ?? null,
        params.linkedCouncilSessionId ?? null,
        counts.fileCount,
        counts.phaseCount,
        counts.riskCount
      ) as PlanRow

    // Enforce retention
    this.enforceRetention(params.workspaceId)

    return mapRow(row)
  }

  /** Get a single plan by ID. */
  getById(id: string): PlanRecord | null {
    const row = this.db().prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined
    return row ? mapRow(row) : null
  }

  /** Get plans for a workspace, newest first. Supports filtering. */
  getForWorkspace(workspaceId: string, filters?: PlanFilters): PlanRecord[] {
    const conditions = ['workspace_id = ?']
    const params: unknown[] = [workspaceId]

    if (filters?.status) {
      if (Array.isArray(filters.status)) {
        conditions.push(`status IN (${filters.status.map(() => '?').join(',')})`)
        params.push(...filters.status)
      } else {
        conditions.push('status = ?')
        params.push(filters.status)
      }
    }
    if (filters?.source) {
      conditions.push('source = ?')
      params.push(filters.source)
    }
    if (filters?.search) {
      conditions.push('(title LIKE ? OR summary LIKE ?)')
      const term = `%${filters.search}%`
      params.push(term, term)
    }

    const rows = this.db()
      .prepare(`SELECT * FROM plans WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC`)
      .all(...params) as PlanRow[]
    return rows.map(mapRow)
  }

  /** Check if a plan from this source already exists (prevents duplicates). */
  findBySource(source: PlanSource, sourceId: string): PlanRecord | null {
    const row = this.db()
      .prepare('SELECT * FROM plans WHERE source = ? AND source_id = ?')
      .get(source, sourceId) as PlanRow | undefined
    return row ? mapRow(row) : null
  }

  /** Update status + optional linked IDs. */
  updateStatus(
    id: string,
    status: PlanStatus,
    links?: {
      conversationId?: string
      mpaRunId?: string
      councilSessionId?: string
    }
  ): void {
    const sets = ['status = ?', "updated_at = datetime('now')"]
    const params: unknown[] = [status]

    if (links?.conversationId !== undefined) {
      sets.push('linked_conversation_id = ?')
      params.push(links.conversationId)
    }
    if (links?.mpaRunId !== undefined) {
      sets.push('linked_mpa_run_id = ?')
      params.push(links.mpaRunId)
    }
    if (links?.councilSessionId !== undefined) {
      sets.push('linked_council_session_id = ?')
      params.push(links.councilSessionId)
    }

    params.push(id)
    this.db()
      .prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params)
  }

  // ── Lifecycle convenience methods ──

  markHandedOff(id: string, conversationId: string): void {
    this.updateStatus(id, 'handed_off', { conversationId })
  }

  markInProgress(id: string): void {
    this.updateStatus(id, 'in_progress')
  }

  markCompleted(id: string): void {
    this.updateStatus(id, 'completed')
  }

  markArchived(id: string): void {
    this.updateStatus(id, 'archived')
  }

  /** Delete a plan by ID. Returns true if deleted. */
  deletePlan(id: string): boolean {
    const result = this.db().prepare('DELETE FROM plans WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** Keep only the newest N plans per workspace. */
  enforceRetention(workspaceId: string, limit: number = RETENTION_LIMIT): void {
    this.db()
      .prepare(
        `DELETE FROM plans WHERE workspace_id = ? AND id NOT IN (
          SELECT id FROM plans WHERE workspace_id = ?
          ORDER BY updated_at DESC LIMIT ?
        )`
      )
      .run(workspaceId, workspaceId, limit)
  }
}

export const planRepository = new PlanRepository()
