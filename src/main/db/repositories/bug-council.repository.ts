import { getDatabase } from '../index'
import type { BugCouncilPerspective, BugCouncilResult } from '../../../shared/types'

/**
 * Raw database row shape for bug_council_sessions table.
 * Kept internal to the repository — external consumers use BugCouncilResult.
 */
interface BugCouncilSessionRow {
  id: string
  conversation_id: string | null
  task_id: string
  agent_id: string
  task_description: string
  failure_history_json: string
  perspectives_json: string
  synthesized_solution: string | null
  risk_assessment: string | null
  final_attempt_succeeded: number | null
  status: string
  created_at: string
  completed_at: string | null
}

function mapRow(row: BugCouncilSessionRow): BugCouncilResult {
  return {
    sessionId: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    taskDescription: row.task_description,
    failureHistory: JSON.parse(row.failure_history_json || '[]'),
    perspectives: JSON.parse(row.perspectives_json || '[]'),
    synthesizedSolution: row.synthesized_solution || '',
    riskAssessment: row.risk_assessment || '',
    finalAttemptSucceeded:
      row.final_attempt_succeeded === null ? null : row.final_attempt_succeeded === 1,
    status: row.status as BugCouncilResult['status'],
    createdAt: row.created_at,
    completedAt: row.completed_at
  }
}

export class BugCouncilRepository {
  /** Create a new bug council session. Returns the generated session ID. */
  createSession(params: {
    taskId: string
    agentId: string
    taskDescription: string
    failureHistory: string[]
    conversationId?: string
  }): string {
    const db = getDatabase()
    const row = db
      .prepare(
        `INSERT INTO bug_council_sessions (task_id, agent_id, task_description, failure_history_json, conversation_id)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id`
      )
      .get(
        params.taskId,
        params.agentId,
        params.taskDescription,
        JSON.stringify(params.failureHistory),
        params.conversationId ?? null
      ) as { id: string }
    return row.id
  }

  /** Update session status (e.g. 'running', 'complete', 'failed'). */
  updateStatus(sessionId: string, status: string): void {
    const db = getDatabase()
    db.prepare('UPDATE bug_council_sessions SET status = ? WHERE id = ?').run(status, sessionId)
  }

  /** Persist the diagnostic perspectives JSON. */
  updatePerspectives(sessionId: string, perspectives: BugCouncilPerspective[]): void {
    const db = getDatabase()
    db.prepare('UPDATE bug_council_sessions SET perspectives_json = ? WHERE id = ?').run(
      JSON.stringify(perspectives),
      sessionId
    )
  }

  /** Mark session complete with synthesized solution + risk assessment. */
  updateComplete(sessionId: string, solution: string, riskAssessment: string): void {
    const db = getDatabase()
    db.prepare(
      `UPDATE bug_council_sessions SET
        synthesized_solution = ?,
        risk_assessment = ?,
        status = 'complete',
        completed_at = datetime('now')
       WHERE id = ?`
    ).run(solution, riskAssessment, sessionId)
  }

  /** Record the final attempt result (success/failure after council guidance). */
  updateFinalAttemptResult(sessionId: string, succeeded: boolean): void {
    const db = getDatabase()
    db.prepare(
      `UPDATE bug_council_sessions SET final_attempt_succeeded = ?, completed_at = datetime('now') WHERE id = ?`
    ).run(succeeded ? 1 : 0, sessionId)
  }

  /** Get a council session by ID. */
  findById(sessionId: string): BugCouncilResult | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM bug_council_sessions WHERE id = ?').get(sessionId) as
      | BugCouncilSessionRow
      | undefined
    return row ? mapRow(row) : null
  }

  /** List council sessions for a conversation (newest first). */
  findByConversation(conversationId: string): BugCouncilResult[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        'SELECT * FROM bug_council_sessions WHERE conversation_id = ? ORDER BY created_at DESC'
      )
      .all(conversationId) as BugCouncilSessionRow[]
    return rows.map(mapRow)
  }
}

export const bugCouncilRepository = new BugCouncilRepository()
