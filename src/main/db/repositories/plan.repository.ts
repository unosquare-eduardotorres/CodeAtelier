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
  PlanFilters,
  PlanStatusHistoryEntry,
  PhaseProgress
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
  completed_at: string | null
  previous_plan_id: string | null
}

interface StatusHistoryRow {
  id: string
  plan_id: string
  from_status: string | null
  to_status: string
  changed_at: string
  actor: string
}

function mapStatusHistoryRow(row: StatusHistoryRow): PlanStatusHistoryEntry {
  return {
    id: row.id,
    planId: row.plan_id,
    fromStatus: row.from_status as PlanStatus | null,
    toStatus: row.to_status as PlanStatus,
    changedAt: row.changed_at,
    actor: row.actor
  }
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
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    previousPlanId: row.previous_plan_id ?? null
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

    const savedPlan = mapRow(row)

    // ── Revision linking: auto-archive previous plan from same source ──
    // Scoped to the same linked conversation (when set) so two concurrent chat
    // conversations in one workspace don't archive each other's active plan —
    // sources without a linked conversation (blueprint/audit/council revisions)
    // keep the original workspace-wide "latest wins" behavior.
    if (params.source && params.sourceId) {
      const existing = this.db()
        .prepare(
          `SELECT id, status FROM plans
           WHERE workspace_id = ? AND source = ? AND id != ? AND status != 'archived'
             AND (linked_conversation_id IS NULL OR linked_conversation_id = ?)
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(
          params.workspaceId,
          params.source,
          savedPlan.id,
          params.linkedConversationId ?? null
        ) as { id: string; status: string } | undefined
      if (existing) {
        this.updateStatus(existing.id, 'archived', undefined, 'system')
        this.db()
          .prepare('UPDATE plans SET previous_plan_id = ? WHERE id = ?')
          .run(existing.id, savedPlan.id)
        // Re-read to pick up the previous_plan_id
        const updated = this.getById(savedPlan.id)
        if (updated) {
          // Record initial status and enforce retention
          this.recordStatusChange(savedPlan.id, null, 'saved', 'system')
          this.enforceRetention(params.workspaceId)
          return updated
        }
      }
    }

    // Record initial status
    this.recordStatusChange(savedPlan.id, null, 'saved', 'system')

    // Enforce retention
    this.enforceRetention(params.workspaceId)

    return savedPlan
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

  /** Find the most recent in-progress plan linked to a conversation. */
  findActiveByConversationId(conversationId: string): PlanRecord | null {
    const row = this.db()
      .prepare(
        `SELECT * FROM plans
         WHERE linked_conversation_id = ? AND status IN ('in_progress', 'saved')
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(conversationId) as PlanRow | undefined
    return row ? mapRow(row) : null
  }

  /** Check if a plan from this source already exists (prevents duplicates). */
  findBySource(source: PlanSource, sourceId: string): PlanRecord | null {
    const row = this.db()
      .prepare('SELECT * FROM plans WHERE source = ? AND source_id = ?')
      .get(source, sourceId) as PlanRow | undefined
    return row ? mapRow(row) : null
  }

  /** Update status + optional linked IDs. Also records status change in the timeline. */
  updateStatus(
    id: string,
    status: PlanStatus,
    links?: {
      conversationId?: string
      mpaRunId?: string
      councilSessionId?: string
    },
    actor: string = 'user'
  ): void {
    const current = this.getById(id)
    const fromStatus = current?.status ?? null

    const sets = ['status = ?', "updated_at = datetime('now')"]
    const params: unknown[] = [status]

    // Set completed_at for terminal statuses
    const isTerminal = status === 'completed' || status === 'archived'
    if (isTerminal) {
      sets.push("completed_at = datetime('now')")
    }

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

    this.recordStatusChange(id, fromStatus, status, actor)
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

  // ── Status History ──

  /** Record a status transition in the timeline. */
  recordStatusChange(
    planId: string,
    fromStatus: PlanStatus | null,
    toStatus: PlanStatus,
    actor = 'user'
  ): void {
    this.db()
      .prepare(
        `INSERT INTO plan_status_history (plan_id, from_status, to_status, actor)
         VALUES (?, ?, ?, ?)`
      )
      .run(planId, fromStatus, toStatus, actor)
  }

  /** Fetch full status timeline for a plan, oldest-first. */
  getStatusHistory(planId: string): PlanStatusHistoryEntry[] {
    const rows = this.db()
      .prepare(
        `SELECT id, plan_id, from_status, to_status, changed_at, actor
         FROM plan_status_history WHERE plan_id = ? ORDER BY changed_at ASC`
      )
      .all(planId) as StatusHistoryRow[]
    return rows.map(mapStatusHistoryRow)
  }

  // ── Phase Progress ──

  /** Update a single phase's progress status. Merges into the existing JSON array. */
  updatePhaseProgress(
    planId: string,
    phaseId: number,
    status: string,
    completedAt?: string,
    touchedFiles?: string[],
    taskUpdate?: { taskId: string; title: string; status: string }
  ): void {
    const row = this.db()
      .prepare('SELECT phase_progress_json FROM plans WHERE id = ?')
      .get(planId) as { phase_progress_json: string | null } | undefined

    const progress: PhaseProgress[] = safeParseJSON(row?.phase_progress_json, [])
    const existing = progress.find((p) => p.phaseId === phaseId)

    if (existing) {
      existing.status = status
      if (status === 'completed' || status === 'failed') {
        existing.completedAt = completedAt ?? new Date().toISOString()
      }
      // Merge touchedFiles (deduped)
      if (touchedFiles && touchedFiles.length > 0) {
        const current = existing.touchedFiles ?? []
        const merged = [...new Set([...current, ...touchedFiles])]
        existing.touchedFiles = merged
      }
      // Merge task update
      if (taskUpdate) {
        const tasks = existing.tasks ?? []
        const taskIdx = tasks.findIndex((t) => t.taskId === taskUpdate.taskId)
        if (taskIdx >= 0) {
          tasks[taskIdx] = { ...tasks[taskIdx], ...taskUpdate }
        } else {
          tasks.push(taskUpdate)
        }
        existing.tasks = tasks
      }
    } else {
      progress.push({
        phaseId,
        status,
        startedAt: new Date().toISOString(),
        completedAt:
          status === 'completed' || status === 'failed'
            ? (completedAt ?? new Date().toISOString())
            : null,
        touchedFiles: touchedFiles ?? [],
        tasks: taskUpdate ? [taskUpdate] : undefined
      })
    }

    this.db()
      .prepare(
        "UPDATE plans SET phase_progress_json = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(JSON.stringify(progress), planId)
  }

  /** Get phase progress for a plan. */
  getPhaseProgress(planId: string): PhaseProgress[] {
    const row = this.db()
      .prepare('SELECT phase_progress_json FROM plans WHERE id = ?')
      .get(planId) as { phase_progress_json: string | null } | undefined
    return safeParseJSON(row?.phase_progress_json, [])
  }

  // ── Revision Linking ──

  /** Get the plan that superseded this one (if any). */
  getSupersedingPlan(planId: string): PlanRecord | null {
    const row = this.db().prepare('SELECT * FROM plans WHERE previous_plan_id = ?').get(planId) as
      PlanRow | undefined
    return row ? mapRow(row) : null
  }

  /** Get the previous revision of this plan (if any). */
  getPreviousPlan(planId: string): PlanRecord | null {
    const current = this.getById(planId)
    if (!current?.previousPlanId) return null
    return this.getById(current.previousPlanId)
  }
}

export const planRepository = new PlanRepository()
