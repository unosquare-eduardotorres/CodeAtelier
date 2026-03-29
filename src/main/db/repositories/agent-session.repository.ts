import { getDatabase } from '../index'

interface AgentSessionRow {
  id: string
  task_id: string | null
  agent_type: string
  pid: number | null
  status: string
  started_at: string
  ended_at: string | null
  token_usage: number
  stdout_log_path: string | null
  conversation_id: string | null
  workspace_id: string | null
  complexity_score: number | null
  model_used: string | null
  complexity_tier: string | null
}

export interface AgentSession {
  id: string
  taskId: string | null
  agentType: string
  pid: number | null
  status: 'running' | 'completed' | 'failed' | 'terminated'
  startedAt: string
  endedAt: string | null
  tokenUsage: number
  conversationId: string | null
  workspaceId: string | null
  complexityScore: number | null
  modelUsed: string | null
  complexityTier: string | null
}

export interface TokenSummary {
  totalTokens: number
  sessionCount: number
  byAgent: { agentType: string; totalTokens: number; sessionCount: number }[]
}

function toModel(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    taskId: row.task_id,
    agentType: row.agent_type,
    pid: row.pid,
    status: row.status as AgentSession['status'],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    tokenUsage: row.token_usage,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    complexityScore: row.complexity_score,
    modelUsed: row.model_used,
    complexityTier: row.complexity_tier
  }
}

export class AgentSessionRepository {
  /** Create a new session record when an agent starts */
  create(
    agentType: string,
    opts: {
      taskId?: string
      pid?: number
      conversationId?: string
      workspaceId?: string
      complexityScore?: number
      modelUsed?: string
      complexityTier?: string
    } = {}
  ): AgentSession {
    const db = getDatabase()
    const row = db
      .prepare(
        `INSERT INTO agent_sessions (agent_type, task_id, pid, conversation_id, workspace_id, complexity_score, model_used, complexity_tier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        agentType,
        opts.taskId ?? null,
        opts.pid ?? null,
        opts.conversationId ?? null,
        opts.workspaceId ?? null,
        opts.complexityScore ?? null,
        opts.modelUsed ?? null,
        opts.complexityTier ?? null
      ) as AgentSessionRow
    return toModel(row)
  }

  /** Update session on completion — set status, endedAt, tokenUsage */
  complete(id: string, status: 'completed' | 'failed' | 'terminated', tokenUsage: number): void {
    const db = getDatabase()
    db.prepare(
      `UPDATE agent_sessions
       SET status = ?, ended_at = datetime('now'), token_usage = ?
       WHERE id = ?`
    ).run(status, tokenUsage, id)
  }

  /** Update token usage on a running session (periodic flush without completing) */
  updateTokenUsage(id: string, tokenUsage: number): void {
    const db = getDatabase()
    db.prepare(`UPDATE agent_sessions SET token_usage = ? WHERE id = ?`).run(tokenUsage, id)
  }

  /** Get all sessions for a workspace */
  findByWorkspace(workspaceId: string): AgentSession[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY started_at DESC')
      .all(workspaceId) as AgentSessionRow[]
    return rows.map(toModel)
  }

  /** Get token summary for a workspace (aggregated) */
  getTokenSummary(workspaceId: string): TokenSummary {
    const db = getDatabase()

    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(token_usage), 0) as total_tokens, COUNT(*) as session_count
         FROM agent_sessions WHERE workspace_id = ?`
      )
      .get(workspaceId) as { total_tokens: number; session_count: number }

    const byAgent = db
      .prepare(
        `SELECT agent_type, COALESCE(SUM(token_usage), 0) as total_tokens, COUNT(*) as session_count
         FROM agent_sessions WHERE workspace_id = ?
         GROUP BY agent_type ORDER BY total_tokens DESC`
      )
      .all(workspaceId) as { agent_type: string; total_tokens: number; session_count: number }[]

    return {
      totalTokens: totals.total_tokens,
      sessionCount: totals.session_count,
      byAgent: byAgent.map((r) => ({
        agentType: r.agent_type,
        totalTokens: r.total_tokens,
        sessionCount: r.session_count
      }))
    }
  }

  /** Get token summary for a specific conversation */
  getConversationTokenSummary(conversationId: string): TokenSummary {
    const db = getDatabase()

    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(token_usage), 0) as total_tokens, COUNT(*) as session_count
         FROM agent_sessions WHERE conversation_id = ?`
      )
      .get(conversationId) as { total_tokens: number; session_count: number }

    const byAgent = db
      .prepare(
        `SELECT agent_type, COALESCE(SUM(token_usage), 0) as total_tokens, COUNT(*) as session_count
         FROM agent_sessions WHERE conversation_id = ?
         GROUP BY agent_type ORDER BY total_tokens DESC`
      )
      .all(conversationId) as { agent_type: string; total_tokens: number; session_count: number }[]

    return {
      totalTokens: totals.total_tokens,
      sessionCount: totals.session_count,
      byAgent: byAgent.map((r) => ({
        agentType: r.agent_type,
        totalTokens: r.total_tokens,
        sessionCount: r.session_count
      }))
    }
  }

  /** Get recent sessions (last N, for display) */
  getRecent(workspaceId: string, limit: number = 50): AgentSession[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        'SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?'
      )
      .all(workspaceId, limit) as AgentSessionRow[]
    return rows.map(toModel)
  }
}

export const agentSessionRepository = new AgentSessionRepository()
