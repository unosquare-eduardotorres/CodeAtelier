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
    /**
     * First round-trip prompt size (the invariant prefix). Written here rather
     * than back-filled: the caller already holds it when the row is inserted, so
     * a second statement would only add a window in which it can be lost.
     * Omitted or non-positive stores NULL — "never measured", not zero.
     */
    prefixTokens?: number | null
  }): TurnUsage {
    const db = this.db()
    const prefixTokens =
      opts.prefixTokens != null && opts.prefixTokens > 0 ? opts.prefixTokens : null
    const row = db
      .prepare(
        `INSERT INTO turn_usage (session_id, conversation_id, turn_number, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, prefix_tokens, model, provider, blueprint_id, task_id, attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        prefixTokens,
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

  /**
   * Get the most recent turn's usage for a conversation (for growth rate analysis).
   *
   * Tie-broken on `created_at`/`rowid`: `turn_number` is not unique by
   * construction, and on a tie SQLite returns whichever row the scan reaches
   * first — the OLDEST. Every blueprint-build conversation stores its single
   * turn as `turn_number = 1`, so a duplicate would silently resolve backwards.
   */
  getLastTurn(conversationId: string): TurnUsage | null {
    const db = this.db()
    const row = db
      .prepare(
        `SELECT * FROM turn_usage WHERE conversation_id = ?
         ORDER BY turn_number DESC, created_at DESC, rowid DESC LIMIT 1`
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
   * Deliberately does NOT write `prefix_tokens`: that value is known when the
   * row is inserted, so `record()` writes it there. This method targets "the
   * newest row for the conversation" rather than a row it owns, which is the
   * shape that has already produced one mis-targeted write.
   */
  updateLastTurnContextTokens(conversationId: string, contextTokens: number): void {
    const db = this.db()
    db.prepare(
      `UPDATE turn_usage
       SET context_tokens = ?
       WHERE id = (
         SELECT id FROM turn_usage
         WHERE conversation_id = ?
         ORDER BY turn_number DESC, created_at DESC, rowid DESC LIMIT 1
       )`
    ).run(contextTokens, conversationId)
  }

  /**
   * Gate T: the prefix floor over blueprint BUILD turns.
   *
   * BUILD turns are identified by `task_id IS NOT NULL`: every blueprint phase
   * stamps `blueprint_id`, but only per-task BUILD work carries a task id. No
   * join to `usage_log` is needed — that was only ever a way to reach `feature`
   * before the v150 attribution columns existed.
   *
   * `measured` is deliberately separate from `turns`: the expected failure mode
   * of this metric is not a wrong number but an absent one (OpenCode records no
   * per-call snapshot, and neither does any pre-v152 row), and a floor computed
   * over three rows out of two hundred should not be read as a floor at all.
   *
   * Use MIN, not AVG, to judge prefix work: the first-call prompt includes the
   * per-task user message, so the average moves with task size while the floor
   * tracks the invariant part.
   */
  getBlueprintPrefixStats(blueprintId?: string): {
    turns: number
    measured: number
    minPrefixTokens: number | null
    avgPrefixTokens: number | null
    maxPrefixTokens: number | null
  } {
    const db = this.db()
    const row = db
      .prepare(
        `SELECT COUNT(*)             AS turns,
                COUNT(prefix_tokens) AS measured,
                MIN(prefix_tokens)   AS min_prefix,
                AVG(prefix_tokens)   AS avg_prefix,
                MAX(prefix_tokens)   AS max_prefix
         FROM turn_usage
         WHERE blueprint_id IS NOT NULL
           AND task_id IS NOT NULL
           AND (? IS NULL OR blueprint_id = ?)`
      )
      .get(blueprintId ?? null, blueprintId ?? null) as {
      turns: number
      measured: number
      min_prefix: number | null
      avg_prefix: number | null
      max_prefix: number | null
    }

    return {
      turns: row.turns ?? 0,
      measured: row.measured ?? 0,
      minPrefixTokens: row.min_prefix ?? null,
      avgPrefixTokens: row.avg_prefix != null ? Math.round(row.avg_prefix) : null,
      maxPrefixTokens: row.max_prefix ?? null
    }
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
