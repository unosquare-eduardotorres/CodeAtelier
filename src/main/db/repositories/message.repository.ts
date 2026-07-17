import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type { Message, ToolActivity } from '../../../shared/types'

interface MessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'specialist'
  agent_id: string | null
  content_md: string
  attachments_json: string
  created_at: string
  parent_message_id: string | null
  tool_activities_json: string | null
  plan_action: string | null
}

function mapRow(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    agentId: row.agent_id ?? undefined,
    contentMd: row.content_md,
    attachmentsJson: row.attachments_json,
    createdAt: row.created_at,
    parentMessageId: row.parent_message_id ?? undefined,
    // DB-01: Use safeParseJSON to prevent a corrupted row from crashing conversation load
    toolActivities: safeParseJSON<ToolActivity[] | undefined>(row.tool_activities_json, undefined),
    planAction: row.plan_action ?? undefined
  }
}

export class MessageRepository extends BaseRepository<MessageRow, Message> {
  protected readonly tableName = 'messages'
  protected mapRow(row: MessageRow): Message {
    return mapRow(row)
  }

  create(
    conversationId: string,
    role: 'user' | 'specialist',
    contentMd: string,
    agentId?: string,
    attachmentsJson?: string
  ): Message {
    const db = this.db()
    const stmt = db.prepare(`
      INSERT INTO messages (conversation_id, role, content_md, agent_id, attachments_json)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `)
    const row = stmt.get(
      conversationId,
      role,
      contentMd,
      agentId ?? null,
      attachmentsJson ?? '[]'
    ) as MessageRow
    return mapRow(row)
  }

  findByConversation(conversationId: string): Message[] {
    const db = this.db()
    const stmt = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC'
    )
    const rows = stmt.all(conversationId) as MessageRow[]
    return rows.map(mapRow)
  }

  /**
   * F5: Fetch only the most recent N messages for a conversation.
   * Uses SQL LIMIT + DESC ordering to avoid loading the entire history,
   * then reverses to chronological order in code.
   */
  findRecentByConversation(conversationId: string, limit: number): Message[] {
    const db = this.db()
    const stmt = db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
    )
    const rows = stmt.all(conversationId, limit) as MessageRow[]
    return rows.reverse().map(mapRow)
  }

  findById(id: string): Message | undefined {
    const db = this.db()
    const stmt = db.prepare('SELECT * FROM messages WHERE id = ?')
    const row = stmt.get(id) as MessageRow | undefined
    return row ? mapRow(row) : undefined
  }

  /**
   * Delete all messages in a conversation created after a given timestamp.
   * Used by /rewind to truncate conversation history at a checkpoint.
   * Returns the number of deleted rows.
   */
  truncateAfterTimestamp(conversationId: string, afterTimestamp: string): number {
    const db = this.db()
    const result = db
      .prepare('DELETE FROM messages WHERE conversation_id = ? AND created_at > ?')
      .run(conversationId, afterTimestamp)
    return result.changes
  }

  /**
   * Persist tool activities for a saved message.
   * Called after stream completion when tool activities have been accumulated.
   */
  updateToolActivities(messageId: string, activities: ToolActivity[]): void {
    if (activities.length === 0) return
    this.db()
      .prepare('UPDATE messages SET tool_activities_json = ? WHERE id = ?')
      .run(JSON.stringify(activities), messageId)
  }

  updatePlanAction(messageId: string, action: string): void {
    this.db()
      .prepare('UPDATE messages SET plan_action = ? WHERE id = ?')
      .run(action, messageId)
  }
}

export const messageRepository = new MessageRepository()
