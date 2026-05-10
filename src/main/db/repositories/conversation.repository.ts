import { getDatabase } from '../index'
import type { Conversation, ConversationMode, LLMProvider } from '../../../shared/types'

interface ConversationRow {
  id: string
  workspace_id: string
  title: string
  mode: 'plan' | 'build'
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
    mcpOverrides: parseMcpOverrides(row.mcp_overrides_json)
  }
}

export class ConversationRepository {
  create(
    workspaceId: string,
    title?: string,
    mode?: ConversationMode,
    personaSpecialistId?: string,
    llmProvider?: LLMProvider,
    mcpOverrides?: Record<string, boolean>
  ): Conversation {
    const db = getDatabase()
    const stmt = db.prepare(`
      INSERT INTO conversations (workspace_id, title, mode, persona_specialist_id, llm_provider, mcp_overrides_json)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING *
    `)
    const row = stmt.get(
      workspaceId,
      title ?? 'New Conversation',
      mode ?? 'plan',
      personaSpecialistId ?? null,
      llmProvider ?? 'claude',
      mcpOverrides ? JSON.stringify(mcpOverrides) : '{}'
    ) as ConversationRow
    return mapRow(row)
  }

  updatePersona(
    conversationId: string,
    personaSpecialistId: string | null
  ): Conversation | undefined {
    const db = getDatabase()
    const stmt = db.prepare(`
      UPDATE conversations SET persona_specialist_id = ? WHERE id = ? RETURNING *
    `)
    const row = stmt.get(personaSpecialistId, conversationId) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  findByWorkspace(workspaceId: string): Conversation[] {
    const db = getDatabase()
    const stmt = db.prepare(
      'SELECT * FROM conversations WHERE workspace_id = ? ORDER BY sort_order ASC, created_at DESC'
    )
    const rows = stmt.all(workspaceId) as ConversationRow[]
    return rows.map(mapRow)
  }

  findById(id: string): Conversation | undefined {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM conversations WHERE id = ?')
    const row = stmt.get(id) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  updateTitle(id: string, title: string): Conversation | undefined {
    const db = getDatabase()
    const stmt = db.prepare(`
      UPDATE conversations SET title = ?
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(title, id) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  delete(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id)
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  updateMode(id: string, mode: ConversationMode): Conversation | undefined {
    const db = getDatabase()
    const stmt = db.prepare(`
      UPDATE conversations SET mode = ?
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(mode, id) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  archive(id: string): void {
    const db = getDatabase()
    const stmt = db.prepare("UPDATE conversations SET status = 'archived' WHERE id = ?")
    stmt.run(id)
  }

  updateSessionId(id: string, sessionId: string): void {
    const db = getDatabase()
    const stmt = db.prepare('UPDATE conversations SET claude_session_id = ? WHERE id = ?')
    stmt.run(sessionId, id)
  }

  getSessionId(id: string): string | undefined {
    const db = getDatabase()
    const stmt = db.prepare('SELECT claude_session_id FROM conversations WHERE id = ?')
    const row = stmt.get(id) as { claude_session_id: string | null } | undefined
    return row?.claude_session_id ?? undefined
  }

  updateBranchName(id: string, branchName: string): void {
    const db = getDatabase()
    db.prepare('UPDATE conversations SET branch_name = ? WHERE id = ?').run(branchName, id)
  }

  updatePrInfo(id: string, prUrl: string, prNumber: number, branchName: string): void {
    const db = getDatabase()
    db.prepare(
      'UPDATE conversations SET pr_url = ?, pr_number = ?, branch_name = ? WHERE id = ?'
    ).run(prUrl, prNumber, branchName, id)
  }

  updateMcpOverrides(
    conversationId: string,
    overrides: Record<string, boolean>
  ): Conversation | undefined {
    const db = getDatabase()
    const stmt = db.prepare(`
      UPDATE conversations SET mcp_overrides_json = ? WHERE id = ? RETURNING *
    `)
    const row = stmt.get(JSON.stringify(overrides), conversationId) as ConversationRow | undefined
    return row ? mapRow(row) : undefined
  }

  reorderConversations(orderedIds: string[]): void {
    const db = getDatabase()
    const stmt = db.prepare('UPDATE conversations SET sort_order = ? WHERE id = ?')
    const tx = db.transaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id))
    })
    tx()
  }
}

export const conversationRepository = new ConversationRepository()
