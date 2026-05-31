/**
 * GrillSessionRepository — CRUD for grill_sessions table.
 *
 * Persists grill evaluation state so the grill can run in the background
 * and survive navigation / app restarts.
 */

import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type { GrillTrackId } from '../../../shared/types'

// ── Types ───────────────────────────────────────────────────────────────────

export type GrillSessionStatus =
  | 'idle'
  | 'evaluating'
  | 'awaiting_answers'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface GrillSessionRow {
  id: string
  idea_id: string
  workspace_id: string
  track_id: string | null
  status: GrillSessionStatus
  current_score: number | null
  score_label: string | null
  feedback: string | null
  iteration_count: number
  messages: string // JSON
  track_scores: string // JSON
  history: string // JSON
  question_states: string | null // JSON
  current_iteration: string | null // JSON
  created_at: string
  updated_at: string
}

export interface GrillSession {
  id: string
  ideaId: string
  workspaceId: string
  trackId: GrillTrackId | null
  status: GrillSessionStatus
  currentScore: number | null
  scoreLabel: string | null
  feedback: string | null
  iterationCount: number
  messages: unknown[]
  trackScores: unknown[]
  history: unknown[]
  questionStates: Record<string, unknown> | null
  currentIteration: unknown | null
  createdAt: string
  updatedAt: string
}

// ── Row mapper ──────────────────────────────────────────────────────────────

function mapRow(row: GrillSessionRow): GrillSession {
  return {
    id: row.id,
    ideaId: row.idea_id,
    workspaceId: row.workspace_id,
    trackId: row.track_id as GrillTrackId | null,
    status: row.status,
    currentScore: row.current_score,
    scoreLabel: row.score_label,
    feedback: row.feedback,
    iterationCount: row.iteration_count,
    messages: safeParseJSON<unknown[]>(row.messages, []),
    trackScores: safeParseJSON<unknown[]>(row.track_scores, []),
    history: safeParseJSON<unknown[]>(row.history, []),
    questionStates: safeParseJSON<Record<string, unknown> | null>(row.question_states, null),
    currentIteration: safeParseJSON<unknown | null>(row.current_iteration, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ── Repository ──────────────────────────────────────────────────────────────

export class GrillSessionRepository extends BaseRepository<GrillSessionRow, GrillSession> {
  protected readonly tableName = 'grill_sessions'
  protected mapRow(row: GrillSessionRow): GrillSession { return mapRow(row) }

  /** Find the latest grill session for an idea */
  findByIdeaId(ideaId: string): GrillSession | null {
    const row = this.db()
      .prepare(`SELECT * FROM grill_sessions WHERE idea_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(ideaId) as GrillSessionRow | undefined
    return row ? mapRow(row) : null
  }


  /** Create a new session */
  create(ideaId: string, workspaceId: string, trackId?: GrillTrackId): GrillSession {
    const id = crypto.randomUUID().replace(/-/g, '').toLowerCase()
    this.db().prepare(
      `INSERT INTO grill_sessions (id, idea_id, workspace_id, track_id) VALUES (?, ?, ?, ?)`
    ).run(id, ideaId, workspaceId, trackId ?? null)

    return this.findById(id)!
  }

  /** Find by primary key */
  override findById(id: string): GrillSession | undefined {
    return this.findOneBy('id', id)
  }

  /** Update session status */
  updateStatus(id: string, status: GrillSessionStatus): void {
    this.db().prepare(
      `UPDATE grill_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(status, id)
  }


  /** Bulk-append messages (more efficient than one-by-one) */
  appendMessages(id: string, messages: unknown[]): void {
    if (messages.length === 0) return
    const stmt = this.db().prepare(
      `UPDATE grill_sessions
       SET messages = json_insert(messages, '$[#]', json(?)),
           updated_at = datetime('now')
       WHERE id = ?`
    )
    this.runTransaction(() => {
      for (const msg of messages) {
        stmt.run(JSON.stringify(msg), id)
      }
    })
  }

  /** Update score, label, and feedback after evaluation */
  updateScore(id: string, score: number, scoreLabel: string, feedback: string): void {
    this.db().prepare(
      `UPDATE grill_sessions
       SET current_score = ?, score_label = ?, feedback = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(score, scoreLabel, feedback, id)
  }

  /** Update question states and current iteration (after questions arrive or user answers) */
  updateQuestionStates(
    id: string,
    questionStates: Record<string, unknown> | null,
    currentIteration: unknown | null
  ): void {
    this.db().prepare(
      `UPDATE grill_sessions
       SET question_states = ?, current_iteration = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      questionStates ? JSON.stringify(questionStates) : null,
      currentIteration ? JSON.stringify(currentIteration) : null,
      id
    )
  }


  /** Update track ID */
  updateTrackId(id: string, trackId: GrillTrackId | null): void {
    this.db().prepare(
      `UPDATE grill_sessions SET track_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(trackId, id)
  }

  /** Link a temporary grill session to a newly created workspace */
  linkToWorkspace(sessionId: string, workspaceId: string): void {
    this.db().prepare(
      `UPDATE grill_sessions SET workspace_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(workspaceId, sessionId)
  }

  /** Get active sessions for a workspace (evaluating or awaiting_answers) */
  getActiveForWorkspace(workspaceId: string): GrillSession[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM grill_sessions
         WHERE workspace_id = ? AND status IN ('evaluating', 'awaiting_answers')
         ORDER BY updated_at DESC`
      )
      .all(workspaceId) as GrillSessionRow[]
    return rows.map(mapRow)
  }
}

export const grillSessionRepository = new GrillSessionRepository()
