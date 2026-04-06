import { getDatabase } from '../index'

export type GateType = 'test' | 'lint' | 'typecheck' | 'build'

export interface GateResultRecord {
  id: string
  sessionId: string | null
  conversationId: string | null
  taskId: string | null
  agentId: string | null
  gateType: GateType
  passed: boolean
  summary: string
  createdAt: string
}

interface GateResultRow {
  id: string
  session_id: string | null
  conversation_id: string | null
  task_id: string | null
  agent_id: string | null
  gate_type: string
  passed: number
  summary: string
  created_at: string
}

function toModel(row: GateResultRow): GateResultRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    gateType: row.gate_type as GateType,
    passed: row.passed === 1,
    summary: row.summary,
    createdAt: row.created_at
  }
}

export class GateResultRepository {
  /** Record a quality gate result */
  create(opts: {
    gateType: GateType
    passed: boolean
    summary: string
    sessionId?: string
    conversationId?: string
    taskId?: string
    agentId?: string
  }): GateResultRecord {
    const db = getDatabase()
    const row = db
      .prepare(
        `INSERT INTO gate_results (gate_type, passed, summary, session_id, conversation_id, task_id, agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING *`
      )
      .get(
        opts.gateType,
        opts.passed ? 1 : 0,
        opts.summary,
        opts.sessionId ?? null,
        opts.conversationId ?? null,
        opts.taskId ?? null,
        opts.agentId ?? null
      ) as GateResultRow
    return toModel(row)
  }

  /** Get gate results for a conversation */
  findByConversation(conversationId: string): GateResultRecord[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM gate_results WHERE conversation_id = ?
         ORDER BY created_at DESC`
      )
      .all(conversationId) as GateResultRow[]
    return rows.map(toModel)
  }

  /** Get gate results for a specific task */
}

export const gateResultRepository = new GateResultRepository()
