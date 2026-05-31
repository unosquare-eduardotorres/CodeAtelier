import { BaseRepository } from '../base-repository'
import type {
  MpaRun,
  MpaPhase,
  MpaRunStatus,
  MpaPhaseStatus,
  MpaPhaseType,
  MpaGoalType
} from '../../../shared/mpa-types'

// ── Row interfaces ──

interface MpaRunRow {
  id: string
  workspace_id: string
  conversation_id: string | null
  grill_session_id: string | null
  title: string
  goal: string
  goal_type: string
  status: string
  current_phase: string | null
  config_json: string
  created_at: string
  completed_at: string | null
  total_tokens: number
}

interface MpaPhaseRow {
  id: string
  run_id: string
  phase_type: string
  iteration: number
  status: string
  agent_role: string
  goal_condition: string | null
  input_artifact_id: string | null
  output_artifact_id: string | null
  started_at: string | null
  completed_at: string | null
  tokens_used: number
  stream_content: string
}

// ── Mappers ──

function mapRunRow(row: MpaRunRow): MpaRun {
  let configJson: Record<string, unknown> = {}
  try {
    configJson = JSON.parse(row.config_json || '{}')
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    grillSessionId: row.grill_session_id,
    title: row.title,
    goal: row.goal,
    goalType: row.goal_type as MpaGoalType,
    status: row.status as MpaRunStatus,
    currentPhase: row.current_phase,
    configJson,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    totalTokens: row.total_tokens
  }
}

function mapPhaseRow(row: MpaPhaseRow): MpaPhase {
  return {
    id: row.id,
    runId: row.run_id,
    phaseType: row.phase_type as MpaPhaseType,
    iteration: row.iteration,
    status: row.status as MpaPhaseStatus,
    agentRole: row.agent_role,
    goalCondition: row.goal_condition,
    inputArtifactId: row.input_artifact_id,
    outputArtifactId: row.output_artifact_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    tokensUsed: row.tokens_used,
    streamContent: row.stream_content
  }
}

// ── Repository ──

export class MpaRunRepository extends BaseRepository<MpaRunRow, MpaRun> {
  protected readonly tableName = 'mpa_runs'
  protected mapRow(row: MpaRunRow): MpaRun { return mapRunRow(row) }

  createRun(params: {
    workspaceId: string
    title: string
    goal: string
    goalType: MpaGoalType
    grillSessionId?: string
    configJson?: Record<string, unknown>
  }): MpaRun {
    const row = this.db()
      .prepare(
        `INSERT INTO mpa_runs (workspace_id, title, goal, goal_type, grill_session_id, config_json)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        params.workspaceId,
        params.title,
        params.goal,
        params.goalType,
        params.grillSessionId ?? null,
        JSON.stringify(params.configJson ?? {})
      ) as MpaRunRow
    return mapRunRow(row)
  }

  override findById(id: string): MpaRun | undefined {
    return this.findOneBy('id', id)
  }

  findByWorkspace(workspaceId: string, limit = 20): MpaRun[] {
    return this.findManyBy('workspace_id', workspaceId, {
      orderBy: 'created_at DESC',
      limit
    })
  }

  updateRun(
    id: string,
    updates: {
      status?: MpaRunStatus
      currentPhase?: string | null
      conversationId?: string
      completedAt?: string
      totalTokens?: number
    }
  ): MpaRun | undefined {
    const setClauses: string[] = []
    const values: unknown[] = []

    if (updates.status !== undefined) {
      setClauses.push('status = ?')
      values.push(updates.status)
    }
    if (updates.currentPhase !== undefined) {
      setClauses.push('current_phase = ?')
      values.push(updates.currentPhase)
    }
    if (updates.conversationId !== undefined) {
      setClauses.push('conversation_id = ?')
      values.push(updates.conversationId)
    }
    if (updates.completedAt !== undefined) {
      setClauses.push('completed_at = ?')
      values.push(updates.completedAt)
    }
    if (updates.totalTokens !== undefined) {
      setClauses.push('total_tokens = ?')
      values.push(updates.totalTokens)
    }

    if (setClauses.length === 0) return this.findById(id)

    values.push(id)
    const row = this.db()
      .prepare(`UPDATE mpa_runs SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`)
      .get(...values) as MpaRunRow | undefined
    return row ? mapRunRow(row) : undefined
  }

  // ── Phase operations ──

  createPhase(params: {
    runId: string
    phaseType: MpaPhaseType
    iteration: number
    agentRole: string
    goalCondition?: string
    inputArtifactId?: string
  }): MpaPhase {
    const row = this.db()
      .prepare(
        `INSERT INTO mpa_phases (run_id, phase_type, iteration, agent_role, goal_condition, input_artifact_id)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        params.runId,
        params.phaseType,
        params.iteration,
        params.agentRole,
        params.goalCondition ?? null,
        params.inputArtifactId ?? null
      ) as MpaPhaseRow
    return mapPhaseRow(row)
  }

  findPhasesByRun(runId: string): MpaPhase[] {
    const rows = this.db()
      .prepare('SELECT * FROM mpa_phases WHERE run_id = ? ORDER BY started_at ASC, iteration ASC')
      .all(runId) as MpaPhaseRow[]
    return rows.map(mapPhaseRow)
  }

  updatePhase(
    id: string,
    updates: {
      status?: MpaPhaseStatus
      outputArtifactId?: string
      startedAt?: string
      completedAt?: string
      tokensUsed?: number
      streamContent?: string
    }
  ): MpaPhase | undefined {
    const setClauses: string[] = []
    const values: unknown[] = []

    if (updates.status !== undefined) {
      setClauses.push('status = ?')
      values.push(updates.status)
    }
    if (updates.outputArtifactId !== undefined) {
      setClauses.push('output_artifact_id = ?')
      values.push(updates.outputArtifactId)
    }
    if (updates.startedAt !== undefined) {
      setClauses.push('started_at = ?')
      values.push(updates.startedAt)
    }
    if (updates.completedAt !== undefined) {
      setClauses.push('completed_at = ?')
      values.push(updates.completedAt)
    }
    if (updates.tokensUsed !== undefined) {
      setClauses.push('tokens_used = ?')
      values.push(updates.tokensUsed)
    }
    if (updates.streamContent !== undefined) {
      setClauses.push('stream_content = ?')
      values.push(updates.streamContent)
    }

    if (setClauses.length === 0) return undefined

    values.push(id)
    const row = this.db()
      .prepare(`UPDATE mpa_phases SET ${setClauses.join(', ')} WHERE id = ? RETURNING *`)
      .get(...values) as MpaPhaseRow | undefined
    return row ? mapPhaseRow(row) : undefined
  }

  appendStreamContent(id: string, chunk: string): void {
    this.db().prepare('UPDATE mpa_phases SET stream_content = stream_content || ? WHERE id = ?').run(
      chunk,
      id
    )
  }

  /** Mark all 'running' runs as 'failed' (for stale detection on app restart) */
  markStaleAsFailed(): number {
    return this.db().prepare(
      `UPDATE mpa_runs SET status = 'failed', completed_at = datetime('now')
       WHERE status = 'running'`
    ).run().changes
  }

  /** Find the latest resumable run for a workspace (failed or cancelled) */
  findResumable(workspaceId: string): MpaRun | null {
    const row = this.db()
      .prepare(
        `SELECT * FROM mpa_runs
         WHERE workspace_id = ? AND status IN ('failed', 'cancelled')
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(workspaceId) as MpaRunRow | undefined
    return row ? mapRunRow(row) : null
  }
}

export const mpaRunRepository = new MpaRunRepository()
