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
  prefix_tokens: number | null
  model: string | null
  provider: string | null
  blueprint_id: string | null
  task_id: string | null
  attempt: number | null
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
  /**
   * Prompt size of the FIRST API round-trip of the turn — the invariant prefix
   * (system prompt + tool schemas + user message) before any tool result was
   * appended. `contextTokens` above is a LAST-round-trip snapshot, i.e.
   * end-of-loop occupancy, so the two are different quantities and only this
   * one can measure prefix-reduction work.
   *
   * NULL on pre-v152 rows and on backends that report no per-call usage
   * (OpenCode) — deliberately not defaulted to 0, which would be read as a
   * measured zero.
   */
  prefixTokens: number | null
  model: string | null
  /**
   * LLM provider that served the turn: 'claude' | 'local-llm' | 'glm'.
   * The executor backend is derivable ('claude' → cli, else opencode).
   * Null on pre-v150 rows — not inferable after the fact.
   */
  provider: string | null
  blueprintId: string | null
  taskId: string | null
  attempt: number | null
  createdAt: string
}

function toModel(row: TurnUsageRow): TurnUsage {
  return {
    id: row.id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    turnNumber: row.turn_number,
    // TURN-TOMODEL-NULL-01: Guard all token fields against NULL from SQLite.
    // Without these, null + number = NaN which propagates through aggregation
    // (cache hit rates, cost estimates) and produces impossible values.
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheCreationTokens: row.cache_creation_tokens ?? 0,
    contextTokens: row.context_tokens ?? 0,
    // NOT ?? 0 like the fields above: for prefix_tokens a NULL means "never
    // measured", and collapsing that into 0 would drag any average down
    // silently. An absence is analysable; a fabricated zero is not.
    prefixTokens: row.prefix_tokens ?? null,
    model: row.model,
    provider: row.provider ?? null,
    blueprintId: row.blueprint_id ?? null,
    taskId: row.task_id ?? null,
    attempt: row.attempt ?? null,
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
    /** LLM provider that served the turn: 'claude' | 'local-llm' | 'glm'. */
    provider?: string | null
    blueprintId?: string | null
    taskId?: string | null
    attempt?: number | null
  }): TurnUsage {
    const db = this.db()
    const row = db
      .prepare(
        `INSERT INTO turn_usage (session_id, conversation_id, turn_number, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, provider, blueprint_id, task_id, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        opts.model ?? null,
        opts.provider ?? null,
        opts.blueprintId ?? null,
        opts.taskId ?? null,
        opts.attempt ?? null
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
   *
   * `prefixTokens` (the first round-trip's prompt size) is written in the SAME
   * statement rather than by a second method: both target "the newest row for
   * this conversation", and a second lookup is exactly the pattern that already
   * produced a mis-targeted write. Omitted or non-positive leaves the existing
   * value alone — NULL means "never measured", not zero.
   */
  updateLastTurnContextTokens(
    conversationId: string,
    contextTokens: number,
    prefixTokens?: number
  ): void {
    const db = this.db()
    const prefix = prefixTokens != null && prefixTokens > 0 ? prefixTokens : null
    db.prepare(
      `UPDATE turn_usage
       SET context_tokens = ?, prefix_tokens = COALESCE(?, prefix_tokens)
       WHERE id = (
         SELECT id FROM turn_usage
         WHERE conversation_id = ?
         ORDER BY turn_number DESC LIMIT 1
       )`
    ).run(contextTokens, prefix, conversationId)
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
