import { BaseRepository } from '../base-repository'
import type {
  CommunicationTone,
  Conversation,
  ConversationMode,
  LLMProvider,
  ThinkingEffort
} from '../../../shared/types'

interface ConversationRow {
  id: string
  workspace_id: string
  title: string
  mode: 'plan' | 'build' | 'danger'
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
}

function parseMcpOverrides(json: string | null): Record<string, boolean> | undefined {
  if (!json || json === '{}') return undefined
  try {
    const parsed = JSON.parse(json) as Record<string, boolean>
    // Only return if there are any truthy entries
    return Object.values(parsed).some(Boolean) ? parsed : undefined
  } catch {
    return undefined
  }
}

function mapRow(row: ConversationRow): Conversation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    mode: row.mode,
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
    effort: (row.effort as ThinkingEffort) ?? 'high'
  }
}

export class ConversationRepository extends BaseRepository<ConversationRow, Conversation> {
  protected readonly tableName = 'conversations'
  protected mapRow(row: ConversationRow): Conversation { return mapRow(row) }

  create(
    workspaceId: string,
    title?: string,
    mode?: ConversationMode,
    personaSpecialistId?: string,
    llmProvider?: LLMProvider,
    mcpOverrides?: Record<string, boolean>,
    communicationTone?: CommunicationTone | null
  ): Conversation {
    const row = this.db()
      .prepare(
        `INSERT INTO conversations (workspace_id, title, mode, persona_specialist_id, llm_provider, mcp_overrides_json, communication_tone)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        workspaceId,
        title ?? 'New Conversation',
        mode ?? 'plan',
        personaSpecialistId ?? null,
        llmProvider ?? 'claude',
        mcpOverrides ? JSON.stringify(mcpOverrides) : '{}',
        communicationTone ?? null
      ) as ConversationRow
    return mapRow(row)
  }

  updatePersona(
    conversationId: string,
    personaSpecialistId: string | null
  ): Conversation | undefined {
    const row = this.db()
      .prepare(`UPDATE conversations SET persona_specialist_id = ? WHERE id = ? RETURNING *`)
      .get(personaSpecialistId, conversationId) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  findByWorkspace(workspaceId: string): Conversation[] {
    return this.findManyBy('workspace_id', workspaceId, {
      orderBy: 'sort_order ASC, created_at DESC'
    })
  }

  updateTitle(id: string, title: string): Conversation | undefined {
    const row = this.db()
      .prepare(`UPDATE conversations SET title = ? WHERE id = ? RETURNING *`)
      .get(title, id) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  delete(id: string): void {
    this.runTransaction(() => {
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
    this.db()
      .prepare("UPDATE conversations SET status = 'archived' WHERE id = ?")
      .run(id)
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

  updateBranchName(id: string, branchName: string): void {
    this.db()
      .prepare('UPDATE conversations SET branch_name = ? WHERE id = ?')
      .run(branchName, id)
  }

  updatePrInfo(id: string, prUrl: string, prNumber: number, branchName: string): void {
    this.db()
      .prepare(
        'UPDATE conversations SET pr_url = ?, pr_number = ?, branch_name = ? WHERE id = ?'
      )
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
    this.db()
      .prepare('UPDATE conversations SET summary = ? WHERE id = ?')
      .run(summary, id)
  }

  /**
   * S6: Get the stored conversation summary.
   * Returns undefined if no summary has been captured yet.
   */
  getSummary(id: string): string | undefined {
    const row = this.db()
      .prepare('SELECT summary FROM conversations WHERE id = ?')
      .get(id) as { summary: string | null } | undefined
    return row?.summary ?? undefined
  }

  reorderConversations(orderedIds: string[]): void {
    const stmt = this.db().prepare('UPDATE conversations SET sort_order = ? WHERE id = ?')
    this.runTransaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id))
    })
  }
}

export const conversationRepository = new ConversationRepository()
