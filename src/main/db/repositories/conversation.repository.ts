import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type {
  CommunicationTone,
  Conversation,
  ConversationMode,
  ConversationModelSnapshot,
  ConversationType,
  LLMProvider,
  ThinkingEffort
} from '../../../shared/types'

interface ConversationRow {
  id: string
  workspace_id: string
  title: string
  mode: 'plan' | 'build' | 'danger'
  type: 'chat' | 'blueprint'
  created_at: string
  status: 'active' | 'archived'
  summary: string | null
  claude_session_id: string | null
  pr_number: number | null
  pr_url: string | null
  branch_name: string | null
  sort_order: number | null
  persona_specialist_id: string | null
  llm_provider: string | null
  mcp_overrides_json: string | null
  communication_tone: string | null
  effort: string | null
  preset_id: string | null
  handoff_context: string | null
  model_config_json: string | null
  source_audit_run_id: string | null
  source_branch: string | null
}

function parseMcpOverrides(json: string | null): Record<string, boolean> | undefined {
  if (!json || json === '{}') return undefined
  // DB-07: Use safeParseJSON for logged fallback on corrupted JSON
  const parsed = safeParseJSON<Record<string, boolean> | null>(json, null)
  if (!parsed) return undefined
  // Only return if there are any truthy entries
  return Object.values(parsed).some(Boolean) ? parsed : undefined
}

function mapRow(row: ConversationRow): Conversation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    mode: row.mode,
    type: row.type ?? 'chat',
    createdAt: row.created_at,
    status: row.status,
    summary: row.summary ?? undefined,
    claudeSessionId: row.claude_session_id ?? undefined,
    prNumber: row.pr_number ?? undefined,
    prUrl: row.pr_url ?? undefined,
    branchName: row.branch_name ?? undefined,
    sortOrder: row.sort_order ?? undefined,
    personaSpecialistId: row.persona_specialist_id ?? null,
    llmProvider: (row.llm_provider as LLMProvider) ?? 'claude',
    mcpOverrides: parseMcpOverrides(row.mcp_overrides_json),
    communicationTone: (row.communication_tone as CommunicationTone) ?? null,
    effort: (row.effort as ThinkingEffort) ?? 'high',
    handoffContext: row.handoff_context ?? null,
    modelConfigSnapshot: row.model_config_json
      ? safeParseJSON<ConversationModelSnapshot | null>(row.model_config_json, null)
      : null,
    sourceAuditRunId: row.source_audit_run_id ?? null,
    sourceBranch: row.source_branch ?? undefined
  }
}

export class ConversationRepository extends BaseRepository<ConversationRow, Conversation> {
  protected readonly tableName = 'conversations'
  protected mapRow(row: ConversationRow): Conversation {
    return mapRow(row)
  }

  create(
    workspaceId: string,
    title?: string,
    mode?: ConversationMode,
    personaSpecialistId?: string,
    llmProvider?: LLMProvider,
    mcpOverrides?: Record<string, boolean>,
    communicationTone?: CommunicationTone | null,
    type?: ConversationType,
    modelConfigSnapshot?: ConversationModelSnapshot | null,
    sourceAuditRunId?: string
  ): Conversation {
    const row = this.db()
      .prepare(
        `INSERT INTO conversations (workspace_id, title, mode, persona_specialist_id, llm_provider, mcp_overrides_json, communication_tone, preset_id, type, model_config_json, source_audit_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        workspaceId,
        title ?? 'New Conversation',
        mode ?? 'plan',
        personaSpecialistId ?? null,
        llmProvider ?? 'claude',
        mcpOverrides ? JSON.stringify(mcpOverrides) : '{}',
        communicationTone ?? null,
        null, // preset_id — deprecated, always null
        type ?? 'chat',
        modelConfigSnapshot ? JSON.stringify(modelConfigSnapshot) : null,
        sourceAuditRunId ?? null
      ) as ConversationRow
    return mapRow(row)
  }

  findByWorkspace(workspaceId: string): Conversation[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM conversations WHERE workspace_id = ? AND type = 'chat' ORDER BY sort_order ASC, created_at DESC`
      )
      .all(workspaceId) as ConversationRow[]
    return rows.map(mapRow)
  }

  updateTitle(id: string, title: string): Conversation | undefined {
    const row = this.db()
      .prepare(`UPDATE conversations SET title = ? WHERE id = ? RETURNING *`)
      .get(title, id) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  delete(id: string): void {
    this.runTransaction(() => {
      // Tables without FK cascade — clean explicitly to prevent orphaned rows
      this.db().prepare('DELETE FROM checkpoints WHERE conversation_id = ?').run(id)
      this.db().prepare('DELETE FROM turn_usage WHERE conversation_id = ?').run(id)
      // events are kept for audit (time-pruned separately via pruneOlderThan) — do NOT delete here

      // FK-cascaded tables (explicit delete for messages; attachments cascade from messages)
      this.db().prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
      this.db().prepare('DELETE FROM conversations WHERE id = ?').run(id)
    })
  }

  updateMode(id: string, mode: ConversationMode): Conversation | undefined {
    const row = this.db()
      .prepare(`UPDATE conversations SET mode = ? WHERE id = ? RETURNING *`)
      .get(mode, id) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  archive(id: string): void {
    this.db().prepare("UPDATE conversations SET status = 'archived' WHERE id = ?").run(id)
  }

  updateSessionId(id: string, sessionId: string): void {
    this.db()
      .prepare('UPDATE conversations SET claude_session_id = ? WHERE id = ?')
      .run(sessionId, id)
  }

  getSessionId(id: string): string | undefined {
    const row = this.db()
      .prepare('SELECT claude_session_id FROM conversations WHERE id = ?')
      .get(id) as { claude_session_id: string | null } | undefined
    return row?.claude_session_id ?? undefined
  }

  getWorkspaceId(id: string): string | undefined {
    const row = this.db().prepare('SELECT workspace_id FROM conversations WHERE id = ?').get(id) as
      { workspace_id: string } | undefined
    return row?.workspace_id
  }

  updateBranchName(id: string, branchName: string): void {
    this.db().prepare('UPDATE conversations SET branch_name = ? WHERE id = ?').run(branchName, id)
  }

  updateSourceBranch(id: string, sourceBranch: string): void {
    this.db()
      .prepare('UPDATE conversations SET source_branch = ? WHERE id = ?')
      .run(sourceBranch, id)
  }

  updatePrInfo(id: string, prUrl: string, prNumber: number, branchName: string): void {
    this.db()
      .prepare('UPDATE conversations SET pr_url = ?, pr_number = ?, branch_name = ? WHERE id = ?')
      .run(prUrl, prNumber, branchName, id)
  }

  updateMcpOverrides(
    conversationId: string,
    overrides: Record<string, boolean>
  ): Conversation | undefined {
    const row = this.db()
      .prepare(`UPDATE conversations SET mcp_overrides_json = ? WHERE id = ? RETURNING *`)
      .get(JSON.stringify(overrides), conversationId) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  /** Update per-conversation thinking effort level */
  updateEffort(conversationId: string, effort: ThinkingEffort): Conversation | undefined {
    const row = this.db()
      .prepare(`UPDATE conversations SET effort = ? WHERE id = ? RETURNING *`)
      .get(effort, conversationId) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  /** Update per-conversation communication tone override (null = use workspace default) */
  updateTone(conversationId: string, tone: CommunicationTone | null): Conversation | undefined {
    const row = this.db()
      .prepare(`UPDATE conversations SET communication_tone = ? WHERE id = ? RETURNING *`)
      .get(tone, conversationId) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  /**
   * S6: Update the conversation summary for cross-message context.
   * The `summary` column already exists in the schema.
   */
  updateSummary(id: string, summary: string): void {
    this.db().prepare('UPDATE conversations SET summary = ? WHERE id = ?').run(summary, id)
  }

  /**
   * S6: Get the stored conversation summary.
   * Returns undefined if no summary has been captured yet.
   */
  getSummary(id: string): string | undefined {
    const row = this.db().prepare('SELECT summary FROM conversations WHERE id = ?').get(id) as
      { summary: string | null } | undefined
    return row?.summary ?? undefined
  }

  /**
   * Read the handoff context this conversation was created with.
   *
   * A fact about the conversation's origin, not a one-shot queue — it is never
   * cleared, so a rebuilt or poisoned session can re-learn where the work came
   * from on its next cold start.
   */
  getHandoffContext(conversationId: string): string | null {
    const row = this.db()
      .prepare('SELECT handoff_context FROM conversations WHERE id = ?')
      .get(conversationId) as { handoff_context: string | null } | undefined
    return row?.handoff_context ?? null
  }

  /** Update handoff context injected when switching providers mid-chat */
  updateHandoffContext(conversationId: string, handoffContext: string | null): void {
    this.db()
      .prepare('UPDATE conversations SET handoff_context = ? WHERE id = ?')
      .run(handoffContext, conversationId)
  }

  /**
   * Update the frozen model config snapshot for a conversation.
   * Used by per-chat model switching to re-route an existing conversation
   * without affecting other chats.
   */
  updateModelSnapshot(
    conversationId: string,
    snapshot: ConversationModelSnapshot,
    llmProvider: LLMProvider
  ): Conversation | undefined {
    const row = this.db()
      .prepare(
        `UPDATE conversations SET model_config_json = ?, llm_provider = ? WHERE id = ? RETURNING *`
      )
      .get(JSON.stringify(snapshot), llmProvider, conversationId) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  /** Find all conversations sourced from a specific audit run. */
  findByAuditRunId(auditRunId: string): Conversation[] {
    const rows = this.db()
      .prepare('SELECT * FROM conversations WHERE source_audit_run_id = ? ORDER BY created_at DESC')
      .all(auditRunId) as ConversationRow[]
    return rows.map(mapRow)
  }

  reorderConversations(orderedIds: string[]): void {
    const stmt = this.db().prepare('UPDATE conversations SET sort_order = ? WHERE id = ?')
    this.runTransaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id))
    })
  }
}

export const conversationRepository = new ConversationRepository()
