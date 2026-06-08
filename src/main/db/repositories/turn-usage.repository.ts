import { BaseRepository } from '../base-repository'

interface TurnUsageRow {
  id: string
  session_id: string
  conversation_id: string
  turn_number: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  context_tokens: number
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
  /** SDK-reported context window total (from getContextUsage().totalTokens) */
  contextTokens: number
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
    contextTokens: row.context_tokens ?? 0,
    model: row.model,
    createdAt: row.created_at
  }
}

export class TurnUsageRepository extends BaseRepository<TurnUsageRow, TurnUsage> {
  protected readonly tableName = 'turn_usage'
  protected mapRow(row: TurnUsageRow): TurnUsage {
    return toModel(row)
  }

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
    const db = this.db()
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
    const db = this.db()
    const rows = db
      .prepare(
        `SELECT * FROM turn_usage WHERE conversation_id = ?
         ORDER BY turn_number ASC`
      )
      .all(conversationId) as TurnUsageRow[]
    return rows.map(toModel)
  }

  /** Get the most recent turn's usage for a conversation (for growth rate analysis) */
  getLastTurn(conversationId: string): TurnUsage | null {
    const db = this.db()
    const row = db
      .prepare(
        `SELECT * FROM turn_usage WHERE conversation_id = ?
         ORDER BY turn_number DESC LIMIT 1`
      )
      .get(conversationId) as TurnUsageRow | undefined
    return row ? toModel(row) : null
  }

  /**
   * @deprecated Use updateLastTurnContextTokens() instead.
   * This method overwrote cache_read_tokens and cache_creation_tokens with 0, destroying
   * the original API-reported cache data. Kept for reference but should not be called.
   */
  updateLastTurnTokens(
    conversationId: string,
    tokens: { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
  ): void {
    const db = this.db()
    db.prepare(
      `UPDATE turn_usage
       SET input_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?
       WHERE id = (
         SELECT id FROM turn_usage
         WHERE conversation_id = ?
         ORDER BY turn_number DESC LIMIT 1
       )`
    ).run(tokens.inputTokens, tokens.cacheReadTokens, tokens.cacheCreationTokens, conversationId)
  }

  /**
   * Store the SDK's context window total on the most recent turn WITHOUT touching
   * the original API-reported input_tokens, cache_read_tokens, or cache_creation_tokens.
   * This preserves cache data for analysis while still recording the full context size.
   */
  updateLastTurnContextTokens(conversationId: string, contextTokens: number): void {
    const db = this.db()
    db.prepare(
      `UPDATE turn_usage
       SET context_tokens = ?
       WHERE id = (
         SELECT id FROM turn_usage
         WHERE conversation_id = ?
         ORDER BY turn_number DESC LIMIT 1
       )`
    ).run(contextTokens, conversationId)
  }

  /** Prune old turn usage records to prevent unbounded growth */
  pruneOlderThan(days: number): number {
    const db = this.db()
    const result = db
      .prepare(`DELETE FROM turn_usage WHERE created_at < datetime('now', '-' || ? || ' days')`)
      .run(days)
    return result.changes
  }
}

export const turnUsageRepository = new TurnUsageRepository()
