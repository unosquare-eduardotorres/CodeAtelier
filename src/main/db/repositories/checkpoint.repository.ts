import { getDatabase } from '../index'

interface CheckpointRecord {
  id: string
  conversationId: string
  workspaceId: string | null
  label: string
  stateJson: string
  gitBranch: string | null
  gitCommitSha: string | null
  activeTaskIds: string
  createdAt: string
}

interface CheckpointRow {
  id: string
  conversation_id: string
  workspace_id: string | null
  label: string
  state_json: string
  git_branch: string | null
  git_commit_sha: string | null
  active_task_ids: string
  created_at: string
}

function toModel(row: CheckpointRow): CheckpointRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    label: row.label,
    stateJson: row.state_json,
    gitBranch: row.git_branch,
    gitCommitSha: row.git_commit_sha,
    activeTaskIds: row.active_task_ids,
    createdAt: row.created_at
  }
}

export class CheckpointRepository {
  /** Create a checkpoint snapshot */
  create(opts: {
    conversationId: string
    workspaceId?: string
    label: string
    state: Record<string, unknown>
    gitBranch?: string
    gitCommitSha?: string
    activeTaskIds?: string[]
  }): CheckpointRecord {
    const db = getDatabase()
    const row = db
      .prepare(
        `INSERT INTO checkpoints (conversation_id, workspace_id, label, state_json, git_branch, git_commit_sha, active_task_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        opts.conversationId,
        opts.workspaceId ?? null,
        opts.label,
        JSON.stringify(opts.state),
        opts.gitBranch ?? null,
        opts.gitCommitSha ?? null,
        JSON.stringify(opts.activeTaskIds ?? [])
      ) as CheckpointRow
    return toModel(row)
  }

  /** Get all checkpoints for a conversation, ordered by most recent first */
  findByConversation(conversationId: string): CheckpointRecord[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM checkpoints WHERE conversation_id = ?
         ORDER BY created_at DESC`
      )
      .all(conversationId) as CheckpointRow[]
    return rows.map(toModel)
  }

  /** Get a specific checkpoint by ID */
  findById(id: string): CheckpointRecord | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as
      | CheckpointRow
      | undefined
    return row ? toModel(row) : null
  }

  /** Delete old checkpoints, keeping only the N most recent per conversation */
  pruneKeepRecent(conversationId: string, keep: number = 5): number {
    const db = getDatabase()
    const result = db
      .prepare(
        `DELETE FROM checkpoints
         WHERE conversation_id = ?
         AND id NOT IN (
           SELECT id FROM checkpoints
           WHERE conversation_id = ?
           ORDER BY created_at DESC
           LIMIT ?
         )`
      )
      .run(conversationId, conversationId, keep)
    return result.changes
  }
}

export const checkpointRepository = new CheckpointRepository()
