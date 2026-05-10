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
}

export const checkpointRepository = new CheckpointRepository()
