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
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
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
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  conversationId: string | null
  workspaceId: string | null
  complexityScore: number | null
  modelUsed: string | null
  complexityTier: string | null
}

export interface TokenSummary {
  totalTokens: number
  sessionCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
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
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheCreationTokens: row.cache_creation_tokens ?? 0,
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

  /** Update session on completion with granular token breakdown */
  completeWithBreakdown(
    id: string,
    status: 'completed' | 'failed' | 'terminated',
    tokens: {
      total: number
      input: number
      output: number
      cacheRead: number
      cacheCreation: number
    }
  ): void {
    const db = getDatabase()
    db.prepare(
      `UPDATE agent_sessions
       SET status = ?, ended_at = datetime('now'),
           token_usage = ?, input_tokens = ?, output_tokens = ?,
           cache_read_tokens = ?, cache_creation_tokens = ?
       WHERE id = ?`
    ).run(
      status,
      tokens.total,
      tokens.input,
      tokens.output,
      tokens.cacheRead,
      tokens.cacheCreation,
      id
    )
  }

  /** Link a session to a conversation after the conversation ID becomes known */
  updateConversationId(id: string, conversationId: string): void {
    const db = getDatabase()
    db.prepare(`UPDATE agent_sessions SET conversation_id = ? WHERE id = ?`).run(conversationId, id)
  }

  /** Update token usage on a running session (periodic flush without completing) */
  updateTokenUsage(
    id: string,
    tokenUsage: number,
    breakdown?: { input: number; output: number; cacheRead: number; cacheCreation: number }
  ): void {
    const db = getDatabase()
    if (breakdown) {
      db.prepare(
        `UPDATE agent_sessions
         SET token_usage = ?, input_tokens = ?, output_tokens = ?,
             cache_read_tokens = ?, cache_creation_tokens = ?
         WHERE id = ?`
      ).run(
        tokenUsage,
        breakdown.input,
        breakdown.output,
        breakdown.cacheRead,
        breakdown.cacheCreation,
        id
      )
    } else {
      db.prepare(`UPDATE agent_sessions SET token_usage = ? WHERE id = ?`).run(tokenUsage, id)
    }
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
        `SELECT COALESCE(SUM(token_usage), 0) as total_tokens,
                COUNT(*) as session_count,
                COALESCE(SUM(input_tokens), 0) as total_input_tokens,
                COALESCE(SUM(output_tokens), 0) as total_output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens
         FROM agent_sessions WHERE workspace_id = ?`
      )
      .get(workspaceId) as {
      total_tokens: number
      session_count: number
      total_input_tokens: number
      total_output_tokens: number
      total_cache_read_tokens: number
      total_cache_creation_tokens: number
    }

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
      totalInputTokens: totals.total_input_tokens,
      totalOutputTokens: totals.total_output_tokens,
      totalCacheReadTokens: totals.total_cache_read_tokens,
      totalCacheCreationTokens: totals.total_cache_creation_tokens,
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
        `SELECT COALESCE(SUM(token_usage), 0) as total_tokens,
                COUNT(*) as session_count,
                COALESCE(SUM(input_tokens), 0) as total_input_tokens,
                COALESCE(SUM(output_tokens), 0) as total_output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) as total_cache_read_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) as total_cache_creation_tokens
         FROM agent_sessions WHERE conversation_id = ?`
      )
      .get(conversationId) as {
      total_tokens: number
      session_count: number
      total_input_tokens: number
      total_output_tokens: number
      total_cache_read_tokens: number
      total_cache_creation_tokens: number
    }

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
      totalInputTokens: totals.total_input_tokens,
      totalOutputTokens: totals.total_output_tokens,
      totalCacheReadTokens: totals.total_cache_read_tokens,
      totalCacheCreationTokens: totals.total_cache_creation_tokens,
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
