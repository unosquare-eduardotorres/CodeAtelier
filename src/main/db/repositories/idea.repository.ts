import { getDatabase } from '../index'
import type { Idea } from '../../../shared/types'

interface IdeaRow {
  id: string
  workspace_id: string
  title: string
  description: string
  status: 'draft' | 'grilling' | 'completed'
  grill_conversation_id: string | null
  grill_summary: string | null
  grill_decisions: string | null
  converted_conversation_id: string | null
  created_at: string
  updated_at: string
}

function mapRow(row: IdeaRow): Idea {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.description,
    status: row.status,
    grillConversationId: row.grill_conversation_id ?? undefined,
    grillSummary: row.grill_summary ?? undefined,
    grillDecisions: row.grill_decisions ?? undefined,
    convertedConversationId: row.converted_conversation_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class IdeaRepository {
  create(workspaceId: string, title: string, description: string): Idea {
    const db = getDatabase()
    const stmt = db.prepare(`
      INSERT INTO ideas (workspace_id, title, description)
      VALUES (?, ?, ?)
      RETURNING *
    `)
    const row = stmt.get(workspaceId, title, description) as IdeaRow
    return mapRow(row)
  }

  findByWorkspace(workspaceId: string): Idea[] {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM ideas WHERE workspace_id = ? ORDER BY created_at DESC')
    const rows = stmt.all(workspaceId) as IdeaRow[]
    return rows.map(mapRow)
  }

  findById(id: string): Idea | undefined {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM ideas WHERE id = ?')
    const row = stmt.get(id) as IdeaRow | undefined
    return row ? mapRow(row) : undefined
  }

  findByGrillConversation(conversationId: string): Idea | undefined {
    const db = getDatabase()
    const stmt = db.prepare('SELECT * FROM ideas WHERE grill_conversation_id = ?')
    const row = stmt.get(conversationId) as IdeaRow | undefined
    return row ? mapRow(row) : undefined
  }

  update(id: string, data: { title?: string; description?: string }): Idea | undefined {
    const db = getDatabase()
    const sets: string[] = []
    const values: string[] = []

    if (data.title !== undefined) {
      sets.push('title = ?')
      values.push(data.title)
    }
    if (data.description !== undefined) {
      sets.push('description = ?')
      values.push(data.description)
    }

    if (sets.length === 0) return this.findById(id)

    sets.push("updated_at = datetime('now')")
    values.push(id)

    const stmt = db.prepare(`
      UPDATE ideas SET ${sets.join(', ')}
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(...values) as IdeaRow | undefined
    return row ? mapRow(row) : undefined
  }

  updateStatus(id: string, status: 'draft' | 'grilling' | 'completed'): Idea | undefined {
    const db = getDatabase()
    const stmt = db.prepare(`
      UPDATE ideas SET status = ?, updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(status, id) as IdeaRow | undefined
    return row ? mapRow(row) : undefined
  }

  setGrillConversation(id: string, conversationId: string): Idea | undefined {
    const db = getDatabase()
    const stmt = db.prepare(`
      UPDATE ideas SET grill_conversation_id = ?, updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(conversationId, id) as IdeaRow | undefined
    return row ? mapRow(row) : undefined
  }

  setGrillSummary(id: string, summary: string): Idea | undefined {
    const db = getDatabase()
    const stmt = db.prepare(`
      UPDATE ideas SET grill_summary = ?, updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(summary, id) as IdeaRow | undefined
    return row ? mapRow(row) : undefined
  }

  setConvertedConversation(id: string, conversationId: string): Idea | undefined {
    const db = getDatabase()
    const stmt = db.prepare(`
      UPDATE ideas SET converted_conversation_id = ?, updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(conversationId, id) as IdeaRow | undefined
    return row ? mapRow(row) : undefined
  }

  saveGrillDecisions(id: string, decisions: string): Idea | undefined {
    const db = getDatabase()
    const stmt = db.prepare(`
      UPDATE ideas SET grill_decisions = ?, updated_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(decisions, id) as IdeaRow | undefined
    return row ? mapRow(row) : undefined
  }

  delete(id: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM ideas WHERE id = ?').run(id)
  }
}

export const ideaRepository = new IdeaRepository()
