import { BaseRepository } from '../base-repository'

/** Allowed event categories — matches CHECK constraint in events table */
export type EventCategory =
  | 'session'
  | 'agent'
  | 'escalation'
  | 'gate'
  | 'abandonment'
  | 'checkpoint'
  | 'hook'
  | 'budget'
  | 'error'

export interface EventRecord {
  id: string
  sessionId: string | null
  conversationId: string | null
  workspaceId: string | null
  eventType: string
  category: EventCategory
  message: string
  dataJson: string
  agentId: string | null
  model: string | null
  sequenceNumber: number | null
  createdAt: string
}

interface EventRow {
  id: string
  session_id: string | null
  conversation_id: string | null
  workspace_id: string | null
  event_type: string
  category: string
  message: string
  data_json: string
  agent_id: string | null
  model: string | null
  sequence_number: number | null
  created_at: string
}

function toModel(row: EventRow): EventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
    category: row.category as EventCategory,
    message: row.message,
    dataJson: row.data_json,
    agentId: row.agent_id,
    model: row.model,
    sequenceNumber: row.sequence_number,
    createdAt: row.created_at
  }
}

export class EventRepository extends BaseRepository<EventRow, EventRecord> {
  protected readonly tableName = 'events'
  protected mapRow(row: EventRow): EventRecord {
    return toModel(row)
  }

  /** Insert a new event record */
  create(opts: {
    eventType: string
    category: EventCategory
    message: string
    sessionId?: string
    conversationId?: string
    workspaceId?: string
    data?: Record<string, unknown>
    agentId?: string
    model?: string
    sequenceNumber?: number
  }): EventRecord {
    const row = this.db()
      .prepare(
        `INSERT INTO events (event_type, category, message, session_id, conversation_id, workspace_id, data_json, agent_id, model, sequence_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        opts.eventType,
        opts.category,
        opts.message,
        opts.sessionId ?? null,
        opts.conversationId ?? null,
        opts.workspaceId ?? null,
        opts.data ? JSON.stringify(opts.data) : '{}',
        opts.agentId ?? null,
        opts.model ?? null,
        opts.sequenceNumber ?? null
      ) as EventRow
    return toModel(row)
  }

  /** Get events for a conversation, ordered by most recent first */
  findByConversation(conversationId: string, limit: number = 100): EventRecord[] {
    return this.findManyBy('conversation_id', conversationId, {
      orderBy: 'created_at DESC',
      limit
    })
  }

  /** Get recent events across all categories */
  getRecent(limit: number = 200): EventRecord[] {
    const rows = this.db()
      .prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?')
      .all(limit) as EventRow[]
    return rows.map(this.mapRow)
  }

  /** Get recent events for a specific workspace */
  getRecentByWorkspace(workspaceId: string, limit: number = 200): EventRecord[] {
    return this.findManyBy('workspace_id', workspaceId, {
      orderBy: 'created_at DESC',
      limit
    })
  }

  /** Prune old events to prevent unbounded DB growth */
  pruneOlderThan(days: number): number {
    return this.db()
      .prepare(`DELETE FROM events WHERE created_at < datetime('now', '-' || ? || ' days')`)
      .run(days).changes
  }
}

export const eventRepository = new EventRepository()
