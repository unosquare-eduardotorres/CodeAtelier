/**
 * GrillSessionRepository — CRUD for grill_sessions table.
 *
 * Persists grill evaluation state so the grill can run in the background
 * and survive navigation / app restarts.
 */

import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type { GrillTrackId, GrillStructuredPlan } from '../../../shared/types'

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
  plan_json: string | null // JSON
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
  plan: GrillStructuredPlan | null
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
    plan: safeParseJSON<GrillStructuredPlan | null>(row.plan_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ── Repository ──────────────────────────────────────────────────────────────

export class GrillSessionRepository extends BaseRepository<GrillSessionRow, GrillSession> {
  protected readonly tableName = 'grill_sessions'
  protected mapRow(row: GrillSessionRow): GrillSession {
    return mapRow(row)
  }

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
    this.db()
      .prepare(
        `INSERT INTO grill_sessions (id, idea_id, workspace_id, track_id) VALUES (?, ?, ?, ?)`
      )
      .run(id, ideaId, workspaceId, trackId ?? null)

    return this.findById(id)!
  }

  /** Find by primary key */
  override findById(id: string): GrillSession | undefined {
    return this.findOneBy('id', id)
  }

  /** Update session status */
  updateStatus(id: string, status: GrillSessionStatus): void {
    this.db()
      .prepare(`UPDATE grill_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, id)
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
    // GRILL-ITERATION-01: Increment iteration_count so the DB tracks actual
    // re-evaluation count. Without this, iteration_count stays at 0 forever
    // and useGrillSessionRestore() shows stale progress after app restart.
    this.db()
      .prepare(
        `UPDATE grill_sessions
       SET current_score = ?, score_label = ?, feedback = ?,
           iteration_count = iteration_count + 1,
           updated_at = datetime('now')
       WHERE id = ?`
      )
      .run(score, scoreLabel, feedback, id)
  }

  /** Update question states and current iteration (after questions arrive or user answers) */
  updateQuestionStates(
    id: string,
    questionStates: Record<string, unknown> | null,
    currentIteration: unknown | null
  ): void {
    this.db()
      .prepare(
        `UPDATE grill_sessions
       SET question_states = ?, current_iteration = ?,
           updated_at = datetime('now')
       WHERE id = ?`
      )
      .run(
        questionStates ? JSON.stringify(questionStates) : null,
        currentIteration ? JSON.stringify(currentIteration) : null,
        id
      )
  }

  /** Update track ID */
  updateTrackId(id: string, trackId: GrillTrackId | null): void {
    this.db()
      .prepare(`UPDATE grill_sessions SET track_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(trackId, id)
  }

  /** Link a temporary grill session to a newly created workspace */
  linkToWorkspace(sessionId: string, workspaceId: string): void {
    this.db()
      .prepare(
        `UPDATE grill_sessions SET workspace_id = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(workspaceId, sessionId)
  }

  /** Save a structured plan to the session */
  savePlan(sessionId: string, plan: GrillStructuredPlan): void {
    this.db()
      .prepare(`UPDATE grill_sessions SET plan_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(plan), sessionId)
  }

  /** Retrieve the structured plan from a session */
  getPlan(sessionId: string): GrillStructuredPlan | null {
    const row = this.db()
      .prepare(`SELECT plan_json FROM grill_sessions WHERE id = ?`)
      .get(sessionId) as { plan_json: string | null } | undefined
    if (!row || !row.plan_json) return null
    return safeParseJSON<GrillStructuredPlan | null>(row.plan_json, null)
  }

  /**
   * Mark a session completed and strip transient state, keeping the generated plan.
   * Used at the final handoff (Start Goal / Council Sweep / Convert Directly) so
   * re-entry shows a plan-only completed view instead of the full chat.
   */
  completeAndStrip(ideaId: string): void {
    this.db()
      .prepare(
        `UPDATE grill_sessions
       SET status = 'completed',
           messages = '[]',
           history = '[]',
           track_scores = '[]',
           question_states = NULL,
           current_iteration = NULL,
           updated_at = datetime('now')
       WHERE idea_id = ?`
      )
      .run(ideaId)
  }

  /** Delete every grill session row for an idea (explicit "Discard grill"). */
  deleteByIdeaId(ideaId: string): void {
    this.db().prepare(`DELETE FROM grill_sessions WHERE idea_id = ?`).run(ideaId)
  }

  /** Idea IDs in this workspace that have a generated (persisted) plan. */
  findIdeaIdsWithPlan(workspaceId: string): string[] {
    const rows = this.db()
      .prepare(
        `SELECT DISTINCT idea_id FROM grill_sessions
         WHERE workspace_id = ? AND plan_json IS NOT NULL`
      )
      .all(workspaceId) as { idea_id: string }[]
    return rows.map((r) => r.idea_id)
  }

  /**
   * Recover sessions left 'evaluating' by a previous crash/quit (no live
   * process can still be running them). Called on app startup. Sessions with a
   * prior score revert to 'awaiting_answers' (user can continue); otherwise
   * they are marked 'failed'.
   */
  terminateStale(): number {
    const result = this.db()
      .prepare(
        `UPDATE grill_sessions
           SET status = CASE WHEN current_score IS NOT NULL THEN 'awaiting_answers' ELSE 'failed' END,
               updated_at = datetime('now')
         WHERE status = 'evaluating'`
      )
      .run()
    return result.changes
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
