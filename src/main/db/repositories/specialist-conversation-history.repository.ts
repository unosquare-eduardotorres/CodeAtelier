import { getDatabase } from '../index'

export type SpecialistConversationHistoryAction = 'activated' | 'deactivated'

interface SpecialistConversationHistoryRow {
  id: string
  conversation_id: string
  specialist_id: string
  action: SpecialistConversationHistoryAction
  created_at: string
}

export interface SpecialistConversationHistoryRecord {
  id: string
  conversationId: string
  specialistId: string
  action: SpecialistConversationHistoryAction
  createdAt: string
}

function mapRow(row: SpecialistConversationHistoryRow): SpecialistConversationHistoryRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    specialistId: row.specialist_id,
    action: row.action,
    createdAt: row.created_at
  }
}

export class SpecialistConversationHistoryRepository {
  create(
    conversationId: string,
    specialistId: string,
    action: SpecialistConversationHistoryAction
  ): SpecialistConversationHistoryRecord {
    const db = getDatabase()
    const row = db
      .prepare(
        `
        INSERT INTO specialist_conversation_history (conversation_id, specialist_id, action)
        VALUES (?, ?, ?)
        RETURNING *
      `
      )
      .get(conversationId, specialistId, action) as SpecialistConversationHistoryRow
    return mapRow(row)
  }

  findByConversation(
    conversationId: string,
    limit: number = 200
  ): SpecialistConversationHistoryRecord[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `
        SELECT * FROM specialist_conversation_history
        WHERE conversation_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(conversationId, limit) as SpecialistConversationHistoryRow[]
    return rows.map(mapRow)
  }

  findByConversationAndSpecialist(
    conversationId: string,
    specialistId: string,
    limit: number = 100
  ): SpecialistConversationHistoryRecord[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `
        SELECT * FROM specialist_conversation_history
        WHERE conversation_id = ? AND specialist_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(conversationId, specialistId, limit) as SpecialistConversationHistoryRow[]
    return rows.map(mapRow)
  }

  clearByConversation(conversationId: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM specialist_conversation_history WHERE conversation_id = ?').run(
      conversationId
    )
  }
}

export const specialistConversationHistoryRepository = new SpecialistConversationHistoryRepository()
