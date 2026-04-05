import { getDatabase } from '../index'
import type { ConversationSpecialist } from '../../../shared/types'

interface ConversationSpecialistRow {
  id: string
  conversation_id: string
  specialist_id: string
  is_active: number
  skills_enabled: number
  skill_overrides: string | null
  created_at: string
  updated_at: string
}

function mapRow(row: ConversationSpecialistRow): ConversationSpecialist {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    specialistId: row.specialist_id,
    isActive: row.is_active === 1,
    skillsEnabled: row.skills_enabled === 1,
    skillOverrides: row.skill_overrides ? JSON.parse(row.skill_overrides) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class ConversationSpecialistRepository {
  /** Get all overrides for a conversation */
  findByConversation(conversationId: string): ConversationSpecialist[] {
    const db = getDatabase()
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
    const db = getDatabase()
    const row = db
      .prepare(
        `SELECT * FROM conversation_specialists WHERE conversation_id = ? AND specialist_id = ?`
      )
      .get(conversationId, specialistId) as ConversationSpecialistRow | undefined
    return row ? mapRow(row) : null
  }

  /** Get specialist IDs that are active for a conversation */
  findActiveSpecialistIds(conversationId: string): string[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `
        SELECT cs.specialist_id FROM conversation_specialists cs
        INNER JOIN specialists s ON s.id = cs.specialist_id
        WHERE cs.conversation_id = ? AND cs.is_active = 1
        ORDER BY s.priority ASC
      `
      )
      .all(conversationId) as { specialist_id: string }[]
    return rows.map((row) => row.specialist_id)
  }

  /** Upsert a specialist override for a conversation */
  upsert(
    conversationId: string,
    specialistId: string,
    data: {
      isActive?: boolean
      skillsEnabled?: boolean
      skillOverrides?: string[] | null
    }
  ): void {
    const db = getDatabase()
    const existing = this.findByConversationAndSpecialist(conversationId, specialistId)

    if (existing) {
      const updates: string[] = []
      const params: unknown[] = []

      if (data.isActive !== undefined) {
        updates.push('is_active = ?')
        params.push(data.isActive ? 1 : 0)
      }
      if (data.skillsEnabled !== undefined) {
        updates.push('skills_enabled = ?')
        params.push(data.skillsEnabled ? 1 : 0)
      }
      if (data.skillOverrides !== undefined) {
        updates.push('skill_overrides = ?')
        params.push(data.skillOverrides ? JSON.stringify(data.skillOverrides) : null)
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
        INSERT INTO conversation_specialists (conversation_id, specialist_id, is_active, skills_enabled, skill_overrides)
        VALUES (?, ?, ?, ?, ?)
      `
      ).run(
        conversationId,
        specialistId,
        data.isActive !== undefined ? (data.isActive ? 1 : 0) : 1,
        data.skillsEnabled !== undefined ? (data.skillsEnabled ? 1 : 0) : 1,
        data.skillOverrides ? JSON.stringify(data.skillOverrides) : null
      )
    }
  }

  /** Remove override (revert to workspace default) */
  remove(conversationId: string, specialistId: string): void {
    const db = getDatabase()
    db.prepare(
      'DELETE FROM conversation_specialists WHERE conversation_id = ? AND specialist_id = ?'
    ).run(conversationId, specialistId)
  }

  /** Remove all overrides for a conversation */
  removeAll(conversationId: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM conversation_specialists WHERE conversation_id = ?').run(conversationId)
  }

  /** Initialize conversation with workspace defaults (called on conversation creation) */
  initFromWorkspaceDefaults(conversationId: string): void {
    const db = getDatabase()
    db.prepare(
      `
      INSERT OR IGNORE INTO conversation_specialists (conversation_id, specialist_id, is_active, skills_enabled)
      SELECT ?, id, 1, 1 FROM specialists WHERE is_active = 1 AND is_core = 0
    `
    ).run(conversationId)
  }

  /** Replace all conversation specialists (bulk operation) */
  replaceConversationSpecialists(
    conversationId: string,
    specialistIds: string[]
  ): ConversationSpecialist[] {
    const db = getDatabase()
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
