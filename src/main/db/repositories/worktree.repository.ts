import { getDatabase } from '../index'

interface WorktreeRow {
  id: string
  conversation_id: string
  agent_id: string
  task_id: string
  worktree_path: string
  branch_name: string
  base_branch: string
  status: string
  created_at: string
  merged_at: string | null
}

export interface AgentWorktree {
  id: string
  conversationId: string
  agentId: string
  taskId: string
  worktreePath: string
  branchName: string
  baseBranch: string
  status: 'active' | 'merging' | 'merged' | 'conflict' | 'abandoned' | 'pruned'
  createdAt: string
  mergedAt: string | null
}

export type WorktreeStatus = AgentWorktree['status']

function mapRow(row: WorktreeRow): AgentWorktree {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    baseBranch: row.base_branch,
    status: row.status as AgentWorktree['status'],
    createdAt: row.created_at,
    mergedAt: row.merged_at
  }
}

export class WorktreeRepository {
  /** Create a new worktree record */
  create(
    conversationId: string,
    agentId: string,
    taskId: string,
    worktreePath: string,
    branchName: string,
    baseBranch: string
  ): AgentWorktree {
    const db = getDatabase()
    const row = db
      .prepare(
        `
        INSERT INTO agent_worktrees (conversation_id, agent_id, task_id, worktree_path, branch_name, base_branch)
        VALUES (?, ?, ?, ?, ?, ?)
        RETURNING *
      `
      )
      .get(conversationId, agentId, taskId, worktreePath, branchName, baseBranch) as WorktreeRow
    return mapRow(row)
  }

  /** Find all worktrees for a conversation */
  findByConversation(conversationId: string): AgentWorktree[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM agent_worktrees WHERE conversation_id = ? ORDER BY created_at')
      .all(conversationId) as WorktreeRow[]
    return rows.map(mapRow)
  }

  /** Find all active worktrees (across all conversations) */
  findActive(): AgentWorktree[] {
    const db = getDatabase()
    const rows = db
      .prepare("SELECT * FROM agent_worktrees WHERE status = 'active' ORDER BY created_at")
      .all() as WorktreeRow[]
    return rows.map(mapRow)
  }

  /** Find a specific worktree by ID */
  findById(id: string): AgentWorktree | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM agent_worktrees WHERE id = ?').get(id) as
      | WorktreeRow
      | undefined
    return row ? mapRow(row) : null
  }

  /** Find worktree by task ID */
  findByTaskId(taskId: string): AgentWorktree | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM agent_worktrees WHERE task_id = ?').get(taskId) as
      | WorktreeRow
      | undefined
    return row ? mapRow(row) : null
  }

  /** Update worktree status and optionally set merged_at timestamp */
  updateStatus(id: string, status: WorktreeStatus, mergedAt?: string): void {
    const db = getDatabase()
    if (mergedAt) {
      db.prepare('UPDATE agent_worktrees SET status = ?, merged_at = ? WHERE id = ?').run(
        status,
        mergedAt,
        id
      )
    } else {
      db.prepare('UPDATE agent_worktrees SET status = ? WHERE id = ?').run(status, id)
    }
  }

  /** Delete all worktrees for a conversation */
  deleteByConversation(conversationId: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM agent_worktrees WHERE conversation_id = ?').run(conversationId)
  }

  /** Mark stale worktrees as pruned (for cleanup) */
  markPruned(ids: string[]): void {
    if (ids.length === 0) return
    const db = getDatabase()
    const placeholders = ids.map(() => '?').join(',')
    db.prepare(`UPDATE agent_worktrees SET status = 'pruned' WHERE id IN (${placeholders})`).run(
      ...ids
    )
  }
}

export const worktreeRepository = new WorktreeRepository()
