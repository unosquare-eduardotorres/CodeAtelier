import { getDatabase } from '../index'
import type { Conversation, ConversationMode } from '../../../shared/types'

interface ConversationRow {
  id: string
  workspace_id: string
  title: string
  mode: 'plan' | 'build'
  created_at: string
  status: 'active' | 'archived'
  summary: string | null
  claude_session_id: string | null
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
    claudeSessionId: row.claude_session_id ?? undefined
  }
}

export class ConversationRepository {
  create(workspaceId: string, title?: string, mode?: ConversationMode): Conversation {
    const db = getDatabase()
    const stmt = db.prepare(`
      INSERT INTO conversations (workspace_id, title, mode)
      VALUES (?, ?, ?)
      RETURNING *
    `)
    const row = stmt.get(
      workspaceId,
      title ?? 'New Conversation',
      mode ?? 'plan'
    ) as ConversationRow
    return mapRow(row)
  }

  findByWorkspace(workspaceId: string): Conversation[] {
    const db = getDatabase()
    const stmt = db.prepare(
      'SELECT * FROM conversations WHERE workspace_id = ? ORDER BY created_at DESC'
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
    // Delete file changes, messages, then the conversation
    db.prepare('DELETE FROM conversation_file_changes WHERE conversation_id = ?').run(id)
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
}

export const conversationRepository = new ConversationRepository()
