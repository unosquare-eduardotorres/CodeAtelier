/**
 * Blueprint repository — CRUD for blueprints, blueprint_phases, and blueprint_tasks tables.
 *
 * Follows the BaseRepository pattern. Uses safeParseJSON for JSON TEXT columns
 * to prevent corrupted rows from crashing features.
 */

import log from 'electron-log'
import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type {
  Blueprint,
  BlueprintPhase,
  BlueprintTask,
  BlueprintArtifact,
  BlueprintStatus,
  BlueprintPhaseType,
  BlueprintPhaseStatus,
  BlueprintTaskStatus,
  BlueprintPriority
} from '../../../shared/blueprint-types'

// ── Row Interfaces (match SQLite schema) ──

interface BlueprintRow {
  id: string
  workspace_id: string
  title: string
  short_name: string
  description: string
  status: string
  current_phase: string
  priority: string
  source_idea_id: string | null
  constitution_snapshot: string | null
  settings_json: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

interface BlueprintPhaseRow {
  id: string
  blueprint_id: string
  phase: string
  status: string
  conversation_id: string | null
  artifacts_json: string
  context_snapshot: string | null
  started_at: string | null
  completed_at: string | null
}

interface BlueprintTaskRow {
  id: string
  blueprint_id: string
  task_id: string
  wave: number
  user_story: string | null
  description: string
  file_paths_json: string
  is_parallel: number
  depends_on_json: string
  status: string
  executor_run_id: string | null
  started_at: string | null
  completed_at: string | null
  completion_json: string | null
}

// ── Row Mappers ──

function mapBlueprintRow(row: BlueprintRow): Blueprint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    shortName: row.short_name,
    description: row.description,
    status: row.status as BlueprintStatus,
    currentPhase: row.current_phase as BlueprintPhaseType,
    priority: row.priority as BlueprintPriority,
    sourceIdeaId: row.source_idea_id,
    constitutionSnapshot: row.constitution_snapshot,
    settingsJson: safeParseJSON<Record<string, unknown>>(row.settings_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  }
}

function mapPhaseRow(row: BlueprintPhaseRow): BlueprintPhase {
  return {
    id: row.id,
    blueprintId: row.blueprint_id,
    phase: row.phase as BlueprintPhaseType,
    status: row.status as BlueprintPhaseStatus,
    conversationId: row.conversation_id,
    artifactsJson: safeParseJSON<BlueprintArtifact[]>(row.artifacts_json, []),
    contextSnapshot: row.context_snapshot,
    startedAt: row.started_at,
    completedAt: row.completed_at
  }
}

function mapTaskRow(row: BlueprintTaskRow): BlueprintTask {
  return {
    id: row.id,
    blueprintId: row.blueprint_id,
    taskId: row.task_id,
    wave: row.wave,
    userStory: row.user_story,
    description: row.description,
    filePathsJson: safeParseJSON<string[]>(row.file_paths_json, []),
    isParallel: row.is_parallel === 1,
    dependsOnJson: safeParseJSON<string[]>(row.depends_on_json, []),
    status: row.status as BlueprintTaskStatus,
    executorRunId: row.executor_run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    completionJson: safeParseJSON<{ filesCreated: string[]; filesModified: string[] } | null>(
      row.completion_json, null
    )
  }
}

// ── Blueprint Repository ──

export class BlueprintRepository extends BaseRepository<BlueprintRow, Blueprint> {
  protected readonly tableName = 'blueprints'
  protected mapRow(row: BlueprintRow): Blueprint {
    return mapBlueprintRow(row)
  }

  // ── Create ──

  create(params: {
    workspaceId: string
    title: string
    description?: string
    priority?: BlueprintPriority
    sourceIdeaId?: string
    constitutionSnapshot?: string
    settingsJson?: Record<string, unknown>
  }): Blueprint {
    const row = this.db()
      .prepare(
        `INSERT INTO blueprints (workspace_id, title, description, priority, source_idea_id, constitution_snapshot, settings_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        params.workspaceId,
        params.title,
        params.description ?? '',
        params.priority ?? 'P1',
        params.sourceIdeaId ?? null,
        params.constitutionSnapshot ?? null,
        JSON.stringify(params.settingsJson ?? {})
      ) as BlueprintRow
    return mapBlueprintRow(row)
  }

  // ── Read ──

  findByWorkspace(workspaceId: string, limit = 50): Blueprint[] {
    return this.findManyBy('workspace_id', workspaceId, {
      orderBy: 'created_at DESC',
      limit
    })
  }

  findByStatus(workspaceId: string, status: BlueprintStatus): Blueprint[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM blueprints WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC`
      )
      .all(workspaceId, status) as BlueprintRow[]
    return rows.map(mapBlueprintRow)
  }

  // ── Update ──

  updateStatus(id: string, status: BlueprintStatus): Blueprint | undefined {
    const isTerminal = status === 'complete' || status === 'failed' || status === 'cancelled'
    const sql = isTerminal
      ? `UPDATE blueprints SET status = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? RETURNING *`
      : `UPDATE blueprints SET status = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`
    const row = this.db().prepare(sql).get(status, id) as BlueprintRow | undefined
    return row ? mapBlueprintRow(row) : undefined
  }

  updatePhase(id: string, phase: BlueprintPhaseType): Blueprint | undefined {
    const row = this.db()
      .prepare(
        `UPDATE blueprints SET current_phase = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`
      )
      .get(phase, id) as BlueprintRow | undefined
    return row ? mapBlueprintRow(row) : undefined
  }

  updateShortName(id: string, shortName: string): Blueprint | undefined {
    const row = this.db()
      .prepare(
        `UPDATE blueprints SET short_name = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`
      )
      .get(shortName, id) as BlueprintRow | undefined
    return row ? mapBlueprintRow(row) : undefined
  }

  update(
    id: string,
    data: {
      title?: string
      description?: string
      shortName?: string
      status?: BlueprintStatus
      currentPhase?: BlueprintPhaseType
      priority?: BlueprintPriority
      constitutionSnapshot?: string
      settingsJson?: Record<string, unknown>
    }
  ): Blueprint | undefined {
    const sets: string[] = []
    const values: unknown[] = []

    if (data.title !== undefined) {
      sets.push('title = ?')
      values.push(data.title)
    }
    if (data.description !== undefined) {
      sets.push('description = ?')
      values.push(data.description)
    }
    if (data.shortName !== undefined) {
      sets.push('short_name = ?')
      values.push(data.shortName)
    }
    if (data.status !== undefined) {
      sets.push('status = ?')
      values.push(data.status)
      // Sync completed_at with terminal status transitions
      const isTerminal = data.status === 'complete' || data.status === 'failed' || data.status === 'cancelled'
      if (isTerminal) {
        sets.push("completed_at = datetime('now')")
      } else {
        sets.push('completed_at = NULL')
      }
    }
    if (data.currentPhase !== undefined) {
      sets.push('current_phase = ?')
      values.push(data.currentPhase)
    }
    if (data.priority !== undefined) {
      sets.push('priority = ?')
      values.push(data.priority)
    }
    if (data.constitutionSnapshot !== undefined) {
      sets.push('constitution_snapshot = ?')
      values.push(data.constitutionSnapshot)
    }
    if (data.settingsJson !== undefined) {
      sets.push('settings_json = ?')
      values.push(JSON.stringify(data.settingsJson))
    }

    if (sets.length === 0) return this.findById(id)

    sets.push("updated_at = datetime('now')")
    values.push(id)

    const row = this.db()
      .prepare(`UPDATE blueprints SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
      .get(...values) as BlueprintRow | undefined
    return row ? mapBlueprintRow(row) : undefined
  }

  // ── Delete ──

  delete(id: string): void {
    this.deleteById(id)
  }

  // ── Stale detection ──

  markStaleAsFailed(excludeIds: string[] = []): number {
    const db = this.db()
    let query = `UPDATE blueprints SET status = 'failed', completed_at = datetime('now'), updated_at = datetime('now')
         WHERE status IN ('specifying', 'clarifying', 'planning', 'tasking', 'reviewing', 'building', 'verifying')`
    const params: string[] = []
    if (excludeIds.length > 0) {
      const placeholders = excludeIds.map(() => '?').join(', ')
      query += ` AND id NOT IN (${placeholders})`
      params.push(...excludeIds)
    }
    const changes = db.prepare(query).run(...params).changes

    // BP-STALE-RECONCILE-01: Cascade cleanup to phases and tasks stuck in
    // active/running states. Without this, the UI shows permanently stuck
    // tasks and phases after an app crash during a BUILD phase.
    if (changes > 0) {
      db.prepare(
        `UPDATE blueprint_phases SET status = 'failed', completed_at = datetime('now')
         WHERE status = 'active'
           AND blueprint_id IN (
             SELECT id FROM blueprints WHERE status = 'failed'
           )`
      ).run()

      db.prepare(
        `UPDATE blueprint_tasks SET status = 'failed', completed_at = datetime('now')
         WHERE status = 'running'
           AND blueprint_id IN (
             SELECT id FROM blueprints WHERE status = 'failed'
           )`
      ).run()
    }

    return changes
  }
}

// ── Blueprint Phase Repository ──

export class BlueprintPhaseRepository extends BaseRepository<BlueprintPhaseRow, BlueprintPhase> {
  protected readonly tableName = 'blueprint_phases'
  protected mapRow(row: BlueprintPhaseRow): BlueprintPhase {
    return mapPhaseRow(row)
  }

  // ── Create ──

  create(params: {
    blueprintId: string
    phase: BlueprintPhaseType
    conversationId?: string
  }): BlueprintPhase {
    const row = this.db()
      .prepare(
        `INSERT INTO blueprint_phases (blueprint_id, phase, conversation_id)
         VALUES (?, ?, ?)
         RETURNING *`
      )
      .get(params.blueprintId, params.phase, params.conversationId ?? null) as BlueprintPhaseRow
    return mapPhaseRow(row)
  }

  /** Create all 7 phase records for a new blueprint (bulk insert). */
  createAllPhases(blueprintId: string): BlueprintPhase[] {
    const phases: BlueprintPhaseType[] = [
      'specify',
      'clarify',
      'plan',
      'tasks',
      'review',
      'build',
      'verify'
    ]
    const stmt = this.db().prepare(
      `INSERT INTO blueprint_phases (blueprint_id, phase) VALUES (?, ?) RETURNING *`
    )
    return this.runTransaction(() =>
      phases.map((phase) => mapPhaseRow(stmt.get(blueprintId, phase) as BlueprintPhaseRow))
    )
  }

  // ── Read ──

  findByBlueprint(blueprintId: string): BlueprintPhase[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM blueprint_phases WHERE blueprint_id = ?
         ORDER BY CASE phase
           WHEN 'specify' THEN 1
           WHEN 'clarify' THEN 2
           WHEN 'plan' THEN 3
           WHEN 'tasks' THEN 4
           WHEN 'review' THEN 5
           WHEN 'build' THEN 6
           WHEN 'verify' THEN 7
         END`
      )
      .all(blueprintId) as BlueprintPhaseRow[]
    return rows.map(mapPhaseRow)
  }

  findByBlueprintAndPhase(
    blueprintId: string,
    phase: BlueprintPhaseType
  ): BlueprintPhase | undefined {
    const row = this.db()
      .prepare(`SELECT * FROM blueprint_phases WHERE blueprint_id = ? AND phase = ?`)
      .get(blueprintId, phase) as BlueprintPhaseRow | undefined
    return row ? mapPhaseRow(row) : undefined
  }

  // ── Update ──

  updateStatus(id: string, status: BlueprintPhaseStatus): BlueprintPhase | undefined {
    const timestampCol =
      status === 'active'
        ? 'started_at'
        : status === 'complete' || status === 'failed'
          ? 'completed_at'
          : null

    let sql = `UPDATE blueprint_phases SET status = ?`
    if (timestampCol) sql += `, ${timestampCol} = datetime('now')`
    sql += ` WHERE id = ? RETURNING *`

    const row = this.db().prepare(sql).get(status, id) as BlueprintPhaseRow | undefined
    return row ? mapPhaseRow(row) : undefined
  }

  setConversation(id: string, conversationId: string): BlueprintPhase | undefined {
    // FK guard: conversation_id REFERENCES conversations(id). If the conversation
    // was never persisted (e.g. CLI exited before streaming any messages), the
    // UPDATE would throw SqliteError: FOREIGN KEY constraint failed. Skip instead.
    const conversationExists = this.db()
      .prepare(`SELECT 1 FROM conversations WHERE id = ?`)
      .get(conversationId)
    if (!conversationExists) {
      log.warn(
        `[blueprint-repo:setConversation] Conversation ${conversationId} not found — skipping FK link for phase ${id}`
      )
      return this.findById(id)
    }

    const row = this.db()
      .prepare(`UPDATE blueprint_phases SET conversation_id = ? WHERE id = ? RETURNING *`)
      .get(conversationId, id) as BlueprintPhaseRow | undefined
    return row ? mapPhaseRow(row) : undefined
  }

  saveArtifacts(id: string, artifacts: BlueprintArtifact[]): BlueprintPhase | undefined {
    const row = this.db()
      .prepare(`UPDATE blueprint_phases SET artifacts_json = ? WHERE id = ? RETURNING *`)
      .get(JSON.stringify(artifacts), id) as BlueprintPhaseRow | undefined
    return row ? mapPhaseRow(row) : undefined
  }

  appendArtifact(id: string, artifact: BlueprintArtifact): BlueprintPhase | undefined {
    const existing = this.findById(id)
    if (!existing) return undefined
    const artifacts = [...existing.artifactsJson, artifact]
    return this.saveArtifacts(id, artifacts)
  }

  /**
   * R2-2 fix: Atomically replace all artifacts of a given type with a single
   * new artifact. Does a fresh read inside the repo so callers never operate
   * on stale artifact lists. Returns the updated phase, or undefined if the
   * phase doesn't exist.
   */
  replaceArtifactOfType(id: string, type: string, artifact: BlueprintArtifact): BlueprintPhase | undefined {
    const existing = this.findById(id)          // fresh read inside the repo
    if (!existing) return undefined
    const filtered = existing.artifactsJson.filter((a) => a.type !== type)
    return this.saveArtifacts(id, [...filtered, artifact])
  }

  saveContextSnapshot(id: string, snapshot: string | null): BlueprintPhase | undefined {
    const row = this.db()
      .prepare(`UPDATE blueprint_phases SET context_snapshot = ? WHERE id = ? RETURNING *`)
      .get(snapshot, id) as BlueprintPhaseRow | undefined
    return row ? mapPhaseRow(row) : undefined
  }
}

// ── Blueprint Task Repository ──

export class BlueprintTaskRepository extends BaseRepository<BlueprintTaskRow, BlueprintTask> {
  protected readonly tableName = 'blueprint_tasks'
  protected mapRow(row: BlueprintTaskRow): BlueprintTask {
    return mapTaskRow(row)
  }

  // ── Create ──

  create(params: {
    blueprintId: string
    taskId: string
    wave: number
    description: string
    userStory?: string
    filePathsJson?: string[]
    isParallel?: boolean
    dependsOnJson?: string[]
  }): BlueprintTask {
    const row = this.db()
      .prepare(
        `INSERT INTO blueprint_tasks (blueprint_id, task_id, wave, description, user_story, file_paths_json, is_parallel, depends_on_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        params.blueprintId,
        params.taskId,
        params.wave,
        params.description,
        params.userStory ?? null,
        JSON.stringify(params.filePathsJson ?? []),
        params.isParallel ? 1 : 0,
        JSON.stringify(params.dependsOnJson ?? [])
      ) as BlueprintTaskRow
    return mapTaskRow(row)
  }

  /** Bulk-create tasks from parsed blueprint-tasks JSON. */
  createBulk(
    blueprintId: string,
    tasks: Array<{
      taskId: string
      wave: number
      description: string
      userStory?: string
      filePathsJson?: string[]
      isParallel?: boolean
      dependsOnJson?: string[]
    }>
  ): BlueprintTask[] {
    const stmt = this.db().prepare(
      `INSERT INTO blueprint_tasks (blueprint_id, task_id, wave, description, user_story, file_paths_json, is_parallel, depends_on_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    return this.runTransaction(() =>
      tasks.map((t) =>
        mapTaskRow(
          stmt.get(
            blueprintId,
            t.taskId,
            t.wave,
            t.description,
            t.userStory ?? null,
            JSON.stringify(t.filePathsJson ?? []),
            t.isParallel ? 1 : 0,
            JSON.stringify(t.dependsOnJson ?? [])
          ) as BlueprintTaskRow
        )
      )
    )
  }

  // ── Read ──

  findByBlueprint(blueprintId: string): BlueprintTask[] {
    return this.findManyBy('blueprint_id', blueprintId, { orderBy: 'wave ASC, task_id ASC' })
  }

  findByWave(blueprintId: string, wave: number): BlueprintTask[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM blueprint_tasks WHERE blueprint_id = ? AND wave = ? ORDER BY task_id ASC`
      )
      .all(blueprintId, wave) as BlueprintTaskRow[]
    return rows.map(mapTaskRow)
  }

  getWaveCount(blueprintId: string): number {
    const result = this.db()
      .prepare(`SELECT MAX(wave) as max_wave FROM blueprint_tasks WHERE blueprint_id = ?`)
      .get(blueprintId) as { max_wave: number | null } | undefined
    return result?.max_wave ?? 0
  }

  // ── Update ──

  updateStatus(id: string, status: BlueprintTaskStatus): BlueprintTask | undefined {
    const timestampCol =
      status === 'running'
        ? 'started_at'
        : status === 'complete' || status === 'failed'
          ? 'completed_at'
          : null

    let sql = `UPDATE blueprint_tasks SET status = ?`
    if (timestampCol) sql += `, ${timestampCol} = datetime('now')`
    sql += ` WHERE id = ? RETURNING *`

    const row = this.db().prepare(sql).get(status, id) as BlueprintTaskRow | undefined
    return row ? mapTaskRow(row) : undefined
  }

  setExecutorRun(id: string, executorRunId: string): BlueprintTask | undefined {
    const row = this.db()
      .prepare(`UPDATE blueprint_tasks SET executor_run_id = ? WHERE id = ? RETURNING *`)
      .get(executorRunId, id) as BlueprintTaskRow | undefined
    return row ? mapTaskRow(row) : undefined
  }

  // ── Delete (bulk, for re-generating tasks) ──

  deleteByBlueprint(blueprintId: string): number {
    return this.deleteBy('blueprint_id', blueprintId)
  }

  /**
   * Delete all remediation tasks (R-prefixed taskIds) for a blueprint.
   * Used when retrying verify to clean up stale remediation from prior rounds.
   */
  deleteRemediationTasks(blueprintId: string): number {
    return this.db()
      .prepare(`DELETE FROM blueprint_tasks WHERE blueprint_id = ? AND task_id LIKE 'R%'`)
      .run(blueprintId).changes
  }

  /** Persist per-task completion data (filesCreated/filesModified) for verify-phase disk checks. */
  setCompletion(
    id: string,
    completion: { filesCreated: string[]; filesModified: string[] }
  ): BlueprintTask | undefined {
    const row = this.db()
      .prepare(`UPDATE blueprint_tasks SET completion_json = ? WHERE id = ? RETURNING *`)
      .get(JSON.stringify(completion), id) as BlueprintTaskRow | undefined
    return row ? mapTaskRow(row) : undefined
  }
}

// ── Singleton Exports ──

export const blueprintRepository = new BlueprintRepository()
export const blueprintPhaseRepository = new BlueprintPhaseRepository()
export const blueprintTaskRepository = new BlueprintTaskRepository()
