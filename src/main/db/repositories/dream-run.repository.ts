import { getDatabase } from '../index'
import type { DreamRun, DreamStatus, DreamTriggerType } from '../../../shared/types'

interface DreamRunRow {
  id: string
  workspace_id: string
  status: DreamStatus
  trigger_type: DreamTriggerType
  memories_created: number
  memories_merged: number
  memories_pruned: number
  token_usage: number
  started_at: string
  ended_at: string | null
  error_message: string | null
}

function mapRow(row: DreamRunRow): DreamRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    triggerType: row.trigger_type,
    memoriesCreated: row.memories_created,
    memoriesMerged: row.memories_merged,
    memoriesPruned: row.memories_pruned,
    tokenUsage: row.token_usage,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    errorMessage: row.error_message
  }
}

export class DreamRunRepository {
  create(workspaceId: string, triggerType: DreamTriggerType): DreamRun {
    const db = getDatabase()
    const row = db
      .prepare(
        `INSERT INTO dream_runs (workspace_id, trigger_type)
         VALUES (?, ?)
         RETURNING *`
      )
      .get(workspaceId, triggerType) as DreamRunRow
    return mapRow(row)
  }

  findById(id: string): DreamRun | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) as
      | DreamRunRow
      | undefined
    return row ? mapRow(row) : null
  }

  findRunning(workspaceId: string): DreamRun | null {
    const db = getDatabase()
    const row = db
      .prepare(
        `SELECT * FROM dream_runs
         WHERE workspace_id = ? AND status = 'running'
         ORDER BY started_at DESC LIMIT 1`
      )
      .get(workspaceId) as DreamRunRow | undefined
    return row ? mapRow(row) : null
  }

  findByWorkspace(workspaceId: string, limit: number = 20): DreamRun[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM dream_runs
         WHERE workspace_id = ?
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .all(workspaceId, limit) as DreamRunRow[]
    return rows.map(mapRow)
  }

  complete(
    id: string,
    stats: {
      memoriesCreated: number
      memoriesMerged: number
      memoriesPruned: number
      tokenUsage: number
    }
  ): DreamRun {
    const db = getDatabase()
    const row = db
      .prepare(
        `UPDATE dream_runs SET
           status = 'completed',
           memories_created = ?,
           memories_merged = ?,
           memories_pruned = ?,
           token_usage = ?,
           ended_at = datetime('now')
         WHERE id = ?
         RETURNING *`
      )
      .get(
        stats.memoriesCreated,
        stats.memoriesMerged,
        stats.memoriesPruned,
        stats.tokenUsage,
        id
      ) as DreamRunRow
    return mapRow(row)
  }

  fail(id: string, errorMessage: string): DreamRun {
    const db = getDatabase()
    const row = db
      .prepare(
        `UPDATE dream_runs SET
           status = 'failed',
           error_message = ?,
           ended_at = datetime('now')
         WHERE id = ?
         RETURNING *`
      )
      .get(errorMessage, id) as DreamRunRow
    return mapRow(row)
  }

  cancel(id: string): DreamRun {
    const db = getDatabase()
    const row = db
      .prepare(
        `UPDATE dream_runs SET
           status = 'cancelled',
           ended_at = datetime('now')
         WHERE id = ?
         RETURNING *`
      )
      .get(id) as DreamRunRow
    return mapRow(row)
  }
}

export const dreamRunRepository = new DreamRunRepository()
