import { BaseRepository } from '../base-repository'
import type { ConversationSpecialist } from '../../../shared/types'

interface ConversationSpecialistRow {
  id: string
  conversation_id: string
  specialist_id: string
  is_active: number
  created_at: string
  updated_at: string
}

function mapRow(row: ConversationSpecialistRow): ConversationSpecialist {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    specialistId: row.specialist_id,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class ConversationSpecialistRepository extends BaseRepository<ConversationSpecialistRow, ConversationSpecialist> {
  protected readonly tableName = 'conversation_specialists'
  protected mapRow(row: ConversationSpecialistRow): ConversationSpecialist { return mapRow(row) }

  /** Get all overrides for a conversation */
  findByConversation(conversationId: string): ConversationSpecialist[] {
    const db = this.db()
    const rows = db
      .prepare(
        `
        SELECT cs.* FROM conversation_specialists cs
        INNER JOIN specialists s ON s.id = cs.specialist_id
        WHERE cs.conversation_id = ?
        ORDER BY s.priority ASC, cs.created_at ASC
      `
      )
      .all(conversationId) as ConversationSpecialistRow[]
    return rows.map(mapRow)
  }

  /** Find a single override for a conversation + specialist pair */
  findByConversationAndSpecialist(
    conversationId: string,
    specialistId: string
  ): ConversationSpecialist | null {
    const db = this.db()
    const row = db
      .prepare(
        `SELECT * FROM conversation_specialists WHERE conversation_id = ? AND specialist_id = ?`
      )
      .get(conversationId, specialistId) as ConversationSpecialistRow | undefined
    return row ? mapRow(row) : null
  }

  /** Upsert a specialist override for a conversation */
  upsert(
    conversationId: string,
    specialistId: string,
    data: {
      isActive?: boolean
    }
  ): void {
    const db = this.db()
    const existing = this.findByConversationAndSpecialist(conversationId, specialistId)

    if (existing) {
      const updates: string[] = []
      const params: unknown[] = []

      if (data.isActive !== undefined) {
        updates.push('is_active = ?')
        params.push(data.isActive ? 1 : 0)
      }

      if (updates.length > 0) {
        updates.push("updated_at = datetime('now')")
        params.push(conversationId, specialistId)
        db.prepare(
          `UPDATE conversation_specialists SET ${updates.join(', ')} WHERE conversation_id = ? AND specialist_id = ?`
        ).run(...params)
      }
    } else {
      db.prepare(
        `
        INSERT INTO conversation_specialists (conversation_id, specialist_id, is_active)
        VALUES (?, ?, ?)
      `
      ).run(conversationId, specialistId, data.isActive !== undefined ? (data.isActive ? 1 : 0) : 1)
    }
  }

  /** Remove override (revert to workspace default) */
  remove(conversationId: string, specialistId: string): void {
    const db = this.db()
    db.prepare(
      'DELETE FROM conversation_specialists WHERE conversation_id = ? AND specialist_id = ?'
    ).run(conversationId, specialistId)
  }

  /** Remove all overrides for a conversation */
  removeAll(conversationId: string): void {
    const db = this.db()
    db.prepare('DELETE FROM conversation_specialists WHERE conversation_id = ?').run(conversationId)
  }

  /** Initialize conversation with workspace defaults (called on conversation creation) */
  initFromWorkspaceDefaults(conversationId: string): void {
    const db = this.db()
    db.prepare(
      `
      INSERT OR IGNORE INTO conversation_specialists (conversation_id, specialist_id, is_active)
      SELECT ?, id, 1 FROM specialists WHERE is_active = 1 AND is_core = 0
    `
    ).run(conversationId)
  }

  /** Replace all conversation specialists (bulk operation) */
  replaceConversationSpecialists(
    conversationId: string,
    specialistIds: string[]
  ): ConversationSpecialist[] {
    const db = this.db()
    const uniqueIds = [...new Set(specialistIds)]

    db.transaction(() => {
      db.prepare('DELETE FROM conversation_specialists WHERE conversation_id = ?').run(
        conversationId
      )

      const insert = db.prepare(
        `INSERT INTO conversation_specialists (conversation_id, specialist_id) VALUES (?, ?)`
      )
      for (const specialistId of uniqueIds) {
        insert.run(conversationId, specialistId)
      }
    })()

    return this.findByConversation(conversationId)
  }
}

export const conversationSpecialistRepository = new ConversationSpecialistRepository()
