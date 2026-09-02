import { BaseRepository } from '../base-repository'

interface UsageLogRow {
  id: string
  feature: string
  agent_type: string | null
  model: string | null
  workspace_id: string | null
  conversation_id: string | null
  session_id: string | null
  turn_number: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_cents: number
  provider: string | null
  blueprint_id: string | null
  task_id: string | null
  attempt: number | null
  created_at: string
}

export interface UsageLogEntry {
  id: string
  feature: string
  agentType: string | null
  model: string | null
  workspaceId: string | null
  conversationId: string | null
  sessionId: string | null
  turnNumber: number | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costCents: number
  /**
   * LLM provider that served the call: 'claude' | 'local-llm' | 'glm'.
   * The executor backend is derivable ('claude' → cli, else opencode).
   * Null on pre-v150 rows — not inferable after the fact.
   */
  provider: string | null
  blueprintId: string | null
  taskId: string | null
  attempt: number | null
  createdAt: string
}

export interface RecordUsageLogInput {
  feature: string
  agentType?: string | null
  model?: string | null
  workspaceId?: string | null
  conversationId?: string | null
  sessionId?: string | null
  turnNumber?: number | null
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costCents?: number
  /** LLM provider that served the call: 'claude' | 'local-llm' | 'glm'. */
  provider?: string | null
  blueprintId?: string | null
  taskId?: string | null
  attempt?: number | null
}

export interface FeatureUsage {
  feature: string
  tokens: number
  costCents: number
  calls: number
}

export interface UsageSummary {
  totalTokens: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  totalCostCents: number
  byFeature: FeatureUsage[]
}

function toModel(row: UsageLogRow): UsageLogEntry {
  return {
    id: row.id,
    feature: row.feature,
    agentType: row.agent_type,
    model: row.model,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    turnNumber: row.turn_number,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    costCents: row.cost_cents,
    provider: row.provider ?? null,
    blueprintId: row.blueprint_id ?? null,
    taskId: row.task_id ?? null,
    attempt: row.attempt ?? null,
    createdAt: row.created_at
  }
}

interface SummaryAggregateRow {
  total_input: number
  total_output: number
  total_cache_read: number
  total_cache_creation: number
  total_cost_cents: number
}

interface FeatureAggregateRow {
  feature: string
  tokens: number
  cost_cents: number
  calls: number
}

export class UsageLogRepository extends BaseRepository<UsageLogRow, UsageLogEntry> {
  protected readonly tableName = 'usage_log'
  protected mapRow(row: UsageLogRow): UsageLogEntry {
    return toModel(row)
  }

  /** Record a single token-consumption event. */
  record(input: RecordUsageLogInput): UsageLogEntry {
    const db = this.db()
    const row = db
      .prepare(
        `INSERT INTO usage_log (
           feature, agent_type, model, workspace_id, conversation_id, session_id, turn_number,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_cents,
           provider, blueprint_id, task_id, attempt
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        input.feature,
        input.agentType ?? null,
        input.model ?? null,
        input.workspaceId ?? null,
        input.conversationId ?? null,
        input.sessionId ?? null,
        input.turnNumber ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cacheReadTokens ?? 0,
        input.cacheCreationTokens ?? 0,
        input.costCents ?? 0,
        input.provider ?? null,
        input.blueprintId ?? null,
        input.taskId ?? null,
        input.attempt ?? null
      ) as UsageLogRow
    return toModel(row)
  }

  private buildSummary(whereClause: string, params: unknown[]): UsageSummary {
    const db = this.db()
    const totals = db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0) AS total_input,
           COALESCE(SUM(output_tokens), 0) AS total_output,
           COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
           COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
           COALESCE(SUM(cost_cents), 0) AS total_cost_cents
         FROM usage_log ${whereClause}`
      )
      .get(...params) as SummaryAggregateRow

    const byFeatureRows = db
      .prepare(
        `SELECT
           feature,
           COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS tokens,
           COALESCE(SUM(cost_cents), 0) AS cost_cents,
           COUNT(*) AS calls
         FROM usage_log ${whereClause}
         GROUP BY feature
         ORDER BY tokens DESC`
      )
      .all(...params) as FeatureAggregateRow[]

    const totalTokens =
      totals.total_input +
      totals.total_output +
      totals.total_cache_read +
      totals.total_cache_creation

    return {
      totalTokens,
      totalInput: totals.total_input,
      totalOutput: totals.total_output,
      totalCacheRead: totals.total_cache_read,
      totalCacheCreation: totals.total_cache_creation,
      totalCostCents: totals.total_cost_cents,
      byFeature: byFeatureRows.map((r) => ({
        feature: r.feature,
        tokens: r.tokens,
        costCents: r.cost_cents,
        calls: r.calls
      }))
    }
  }

  /** Unified usage summary for a workspace, broken down by feature. */
  getWorkspaceSummary(workspaceId: string): UsageSummary {
    return this.buildSummary('WHERE workspace_id = ?', [workspaceId])
  }

  /** Unified usage summary for a single conversation, broken down by feature. */
  getConversationSummary(conversationId: string): UsageSummary {
    return this.buildSummary('WHERE conversation_id = ?', [conversationId])
  }

  /** Unified usage summary across all workspaces (includes workspace-less ops). */
  getGlobalSummary(): UsageSummary {
    return this.buildSummary('', [])
  }

  /** Prune old usage records to prevent unbounded growth. Returns rows deleted. */
  pruneOlderThan(days: number): number {
    const db = this.db()
    const result = db
      .prepare(`DELETE FROM usage_log WHERE created_at < datetime('now', '-' || ? || ' days')`)
      .run(days)
    return result.changes
  }
}

export const usageLogRepository = new UsageLogRepository()
