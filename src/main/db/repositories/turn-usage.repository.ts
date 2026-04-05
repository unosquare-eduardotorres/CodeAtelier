import { getDatabase } from '../index'

interface TurnUsageRow {
  id: string
  session_id: string
  conversation_id: string
  turn_number: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  model: string | null
  created_at: string
}

export interface TurnUsage {
  id: string
  sessionId: string
  conversationId: string
  turnNumber: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  model: string | null
  createdAt: string
}

function toModel(row: TurnUsageRow): TurnUsage {
  return {
    id: row.id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    turnNumber: row.turn_number,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    model: row.model,
    createdAt: row.created_at
  }
}

export class TurnUsageRepository {
  /** Record token usage for a single turn */
  record(opts: {
    sessionId: string
    conversationId: string
    turnNumber: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    model?: string
  }): TurnUsage {
    const db = getDatabase()
    const row = db
      .prepare(
        `INSERT INTO turn_usage (session_id, conversation_id, turn_number, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        opts.sessionId,
        opts.conversationId,
        opts.turnNumber,
        opts.inputTokens,
        opts.outputTokens,
        opts.cacheReadTokens,
        opts.cacheCreationTokens,
        opts.model ?? null
      ) as TurnUsageRow
    return toModel(row)
  }

  /** Get all turn usage records for a conversation, ordered by turn */
  findByConversation(conversationId: string): TurnUsage[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM turn_usage WHERE conversation_id = ?
         ORDER BY turn_number ASC`
      )
      .all(conversationId) as TurnUsageRow[]
    return rows.map(toModel)
  }

  /** Get all turn usage records for a session, ordered by turn */
  findBySession(sessionId: string): TurnUsage[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM turn_usage WHERE session_id = ?
         ORDER BY turn_number ASC`
      )
      .all(sessionId) as TurnUsageRow[]
    return rows.map(toModel)
  }

  /** Get the most recent turn's usage for a conversation (for growth rate analysis) */
  getLastTurn(conversationId: string): TurnUsage | null {
    const db = getDatabase()
    const row = db
      .prepare(
        `SELECT * FROM turn_usage WHERE conversation_id = ?
         ORDER BY turn_number DESC LIMIT 1`
      )
      .get(conversationId) as TurnUsageRow | undefined
    return row ? toModel(row) : null
  }

  /** Get turn-over-turn token growth rate for a conversation */
  getTokenGrowthRate(conversationId: string): { turnNumber: number; inputTokens: number; growthRate: number }[] {
    const turns = this.findByConversation(conversationId)
    return turns.map((turn, i) => {
      const prev = i > 0 ? turns[i - 1].inputTokens : 0
      const growthRate = prev > 0 ? (turn.inputTokens - prev) / prev : 0
      return {
        turnNumber: turn.turnNumber,
        inputTokens: turn.inputTokens,
        growthRate
      }
    })
  }

  /** Prune old turn usage records to prevent unbounded growth */
  pruneOlderThan(days: number): number {
    const db = getDatabase()
    const result = db
      .prepare(`DELETE FROM turn_usage WHERE created_at < datetime('now', '-' || ? || ' days')`)
      .run(days)
    return result.changes
  }
}

export const turnUsageRepository = new TurnUsageRepository()
