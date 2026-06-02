import { BaseRepository } from '../base-repository'

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

export class CheckpointRepository extends BaseRepository<CheckpointRow, CheckpointRecord> {
  protected readonly tableName = 'checkpoints'
  protected mapRow(row: CheckpointRow): CheckpointRecord {
    return toModel(row)
  }

  /** Get all checkpoints for a conversation, ordered by most recent first */
  findByConversation(conversationId: string): CheckpointRecord[] {
    return this.findManyBy('conversation_id', conversationId, {
      orderBy: 'created_at DESC'
    })
  }

  // findById is inherited from BaseRepository
}

export const checkpointRepository = new CheckpointRepository()
