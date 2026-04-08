import { getDatabase } from '../index'
import type { MessageType, AgentMessage } from '../../services/specialist/message-bus'

interface AgentMessageRow {
  id: string
  conversation_id: string | null
  run_id: string | null
  from_agent: string
  to_agent: string | null
  type: string
  content: string
  task_id: string | null
  metadata_json: string
  created_at: string
}

function toModel(row: AgentMessageRow): AgentMessage {
  return {
    id: row.id,
    from: row.from_agent,
    to: row.to_agent ?? undefined,
    type: row.type as MessageType,
    content: row.content,
    timestamp: row.created_at,
    taskId: row.task_id ?? undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined
  }
}

/**
 * Repository for persisting inter-agent messages to SQLite.
 * Used by the MessageBus persistence layer to survive crashes
 * and provide an audit trail of agent-to-agent communication.
 */
export class AgentMessageRepository {
  /** Persist a single message */
  create(message: AgentMessage, opts?: { conversationId?: string; runId?: string }): void {
    const db = getDatabase()
    db.prepare(
      `INSERT OR IGNORE INTO agent_messages (id, conversation_id, run_id, from_agent, to_agent, type, content, task_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      message.id,
      opts?.conversationId ?? null,
      opts?.runId ?? null,
      message.from,
      message.to ?? null,
      message.type,
      message.content,
      message.taskId ?? null,
      message.metadata ? JSON.stringify(message.metadata) : '{}',
      message.timestamp
    )
  }

  /** Get all messages for a specific task */
  findByTaskId(taskId: string): AgentMessage[] {
    const db = getDatabase()
    const rows = db
      .prepare(`SELECT * FROM agent_messages WHERE task_id = ? ORDER BY created_at ASC`)
      .all(taskId) as AgentMessageRow[]
    return rows.map(toModel)
  }

  /** Prune messages older than a given date */
  pruneOlderThan(date: string): number {
    const db = getDatabase()
    const result = db.prepare(`DELETE FROM agent_messages WHERE created_at < ?`).run(date)
    return result.changes
  }
}

export const agentMessageRepository = new AgentMessageRepository()
