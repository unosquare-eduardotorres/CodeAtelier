import { getDatabase as getDb } from '..'
import { dbLogger } from '../../logger'

const log = dbLogger

export type AgentContextType = 'finding' | 'decision' | 'artifact' | 'summary'

export interface AgentContextRecord {
  id: string
  conversation_id: string
  agent_id: string
  task_id: string | null
  context_type: AgentContextType
  content: string
  token_estimate: number
  created_at: string
}

/**
 * Repository for agent_context table — persistent per-conversation agent memory.
 *
 * Follows the Anthropic "lightweight refs" pattern: agents persist key findings,
 * decisions, and artifacts so that future runs in the same conversation can
 * access summarized context without re-processing.
 */
export class AgentContextRepository {
  /**
   * Store a new context entry for an agent within a conversation.
   */
  create(
    conversationId: string,
    agentId: string,
    contextType: AgentContextType,
    content: string,
    taskId?: string
  ): AgentContextRecord {
    const db = getDb()
    // Estimate tokens as ~4 chars per token (rough approximation)
    const tokenEstimate = Math.ceil(content.length / 4)

    const stmt = db.prepare(`
      INSERT INTO agent_context (conversation_id, agent_id, task_id, context_type, content, token_estimate)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    const id = (
      db.prepare("SELECT lower(hex(randomblob(16))) as id").get() as { id: string }
    ).id

    stmt.run(conversationId, agentId, taskId ?? null, contextType, content, tokenEstimate)

    log.debug(`[agent-context] Stored ${contextType} for ${agentId} in ${conversationId} (${tokenEstimate} est. tokens)`)

    return {
      id,
      conversation_id: conversationId,
      agent_id: agentId,
      task_id: taskId ?? null,
      context_type: contextType,
      content,
      token_estimate: tokenEstimate,
      created_at: new Date().toISOString()
    }
  }

  /**
   * Get all context entries for a conversation, ordered by creation time.
   * Optionally filter by agent or context type.
   */
  findByConversation(
    conversationId: string,
    opts?: { agentId?: string; contextType?: AgentContextType; limit?: number }
  ): AgentContextRecord[] {
    const db = getDb()
    let sql = 'SELECT * FROM agent_context WHERE conversation_id = ?'
    const params: unknown[] = [conversationId]

    if (opts?.agentId) {
      sql += ' AND agent_id = ?'
      params.push(opts.agentId)
    }
    if (opts?.contextType) {
      sql += ' AND context_type = ?'
      params.push(opts.contextType)
    }

    sql += ' ORDER BY created_at ASC'

    if (opts?.limit) {
      sql += ' LIMIT ?'
      params.push(opts.limit)
    }

    return db.prepare(sql).all(...params) as AgentContextRecord[]
  }

  /**
   * Build a formatted context string for injection into specialist prompts.
   * Respects a token budget to avoid exceeding context windows.
   *
   * Returns empty string if no relevant context exists.
   */
  buildContextForPrompt(
    conversationId: string,
    maxTokens: number = 3000
  ): string {
    const entries = this.findByConversation(conversationId)
    if (entries.length === 0) return ''

    let usedTokens = 0
    const selected: AgentContextRecord[] = []

    // Prioritize: summaries > findings > decisions > artifacts
    const priorityOrder: AgentContextType[] = ['summary', 'finding', 'decision', 'artifact']
    const byType = new Map<AgentContextType, AgentContextRecord[]>()
    for (const entry of entries) {
      const list = byType.get(entry.context_type) ?? []
      list.push(entry)
      byType.set(entry.context_type, list)
    }

    for (const type of priorityOrder) {
      const typeEntries = byType.get(type) ?? []
      for (const entry of typeEntries) {
        if (usedTokens + entry.token_estimate > maxTokens) continue
        selected.push(entry)
        usedTokens += entry.token_estimate
      }
    }

    if (selected.length === 0) return ''

    const lines = selected.map(
      (e) => `[${e.context_type}] (${e.agent_id}) ${e.content}`
    )
    return `<agent-context>\nPrevious findings and decisions from this conversation:\n${lines.join('\n')}\n</agent-context>`
  }

  /**
   * Get total token estimate for a conversation's context.
   */
  getTokenEstimate(conversationId: string): number {
    const db = getDb()
    const row = db
      .prepare('SELECT COALESCE(SUM(token_estimate), 0) as total FROM agent_context WHERE conversation_id = ?')
      .get(conversationId) as { total: number }
    return row.total
  }

  /**
   * Delete all context for a conversation (cleanup on conversation delete).
   */
  deleteByConversation(conversationId: string): void {
    const db = getDb()
    db.prepare('DELETE FROM agent_context WHERE conversation_id = ?').run(conversationId)
  }
}

export const agentContextRepository = new AgentContextRepository()
