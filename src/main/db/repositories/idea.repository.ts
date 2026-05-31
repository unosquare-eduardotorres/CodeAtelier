import { BaseRepository } from '../base-repository'
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

export class IdeaRepository extends BaseRepository<IdeaRow, Idea> {
  protected readonly tableName = 'ideas'
  protected mapRow(row: IdeaRow): Idea { return mapRow(row) }

  create(workspaceId: string, title: string, description: string): Idea {
    const stmt = this.db().prepare(`
      INSERT INTO ideas (workspace_id, title, description)
      VALUES (?, ?, ?)
      RETURNING *
    `)
    const row = stmt.get(workspaceId, title, description) as IdeaRow
    return this.mapRow(row)
  }

  findByWorkspace(workspaceId: string): Idea[] {
    return this.findManyBy('workspace_id', workspaceId, { orderBy: 'created_at DESC' })
  }

  // findById inherited from BaseRepository

  findByGrillConversation(conversationId: string): Idea | undefined {
    return this.findOneBy('grill_conversation_id', conversationId)
  }

  update(id: string, data: { title?: string; description?: string }): Idea | undefined {
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

    const stmt = this.db().prepare(`
      UPDATE ideas SET ${sets.join(', ')}
      WHERE id = ?
      RETURNING *
    `)
    const row = stmt.get(...values) as IdeaRow | undefined
    return row ? this.mapRow(row) : undefined
  }

  /** Helper for single-field updates that return the updated row */
  private updateField(id: string, column: string, value: unknown): Idea | undefined {
    const row = this.db()
      .prepare(`UPDATE ideas SET ${column} = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`)
      .get(value, id) as IdeaRow | undefined
    return row ? this.mapRow(row) : undefined
  }

  updateStatus(id: string, status: 'draft' | 'grilling' | 'completed'): Idea | undefined {
    return this.updateField(id, 'status', status)
  }

  setGrillConversation(id: string, conversationId: string): Idea | undefined {
    return this.updateField(id, 'grill_conversation_id', conversationId)
  }

  setGrillSummary(id: string, summary: string): Idea | undefined {
    return this.updateField(id, 'grill_summary', summary)
  }

  setConvertedConversation(id: string, conversationId: string): Idea | undefined {
    return this.updateField(id, 'converted_conversation_id', conversationId)
  }

  saveGrillDecisions(id: string, decisions: string): Idea | undefined {
    return this.updateField(id, 'grill_decisions', decisions)
  }

  delete(id: string): void {
    this.deleteById(id)
  }
}

export const ideaRepository = new IdeaRepository()
