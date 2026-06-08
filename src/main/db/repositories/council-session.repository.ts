/**
 * CouncilSessionRepository — CRUD for council_sessions table.
 *
 * Persists council evaluation state so sessions can be resumed after
 * errors, cancellation, or app restarts. Each advisor's review is
 * persisted incrementally as it completes.
 */

import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type {
  CouncilPhase,
  CouncilInputType,
  CouncilReview,
  CouncilPeerReview,
  CouncilVerdict
} from '../../../shared/types'

// ── Types ───────────────────────────────────────────────────────────────────

export type CouncilSessionStatus = 'running' | 'completed' | 'cancelled' | 'failed'

export interface CouncilSessionRow {
  id: string
  workspace_id: string
  conversation_id: string | null
  input_type: CouncilInputType
  input_content: string
  status: CouncilSessionStatus
  verdict_json: string | null
  transcript_md: string | null
  created_at: string
  completed_at: string | null
  // v96 columns
  grill_session_id: string | null
  structured_plan_json: string | null
  advisor_reviews_json: string // JSON array
  peer_reviews_json: string // JSON array
  phase: string // CouncilPhase subset
  completed_advisors: string // JSON array of role strings
}

export interface CouncilSessionRecord {
  id: string
  workspaceId: string
  conversationId: string | null
  inputType: CouncilInputType
  inputContent: string
  status: CouncilSessionStatus
  verdict: CouncilVerdict | null
  transcriptMd: string | null
  createdAt: string
  completedAt: string | null
  grillSessionId: string | null
  structuredPlanJson: string | null
  advisorReviews: CouncilReview[]
  peerReviews: CouncilPeerReview[]
  phase: CouncilPhase
  completedAdvisors: string[]
}

// ── Row mapper ──────────────────────────────────────────────────────────────

function mapRow(row: CouncilSessionRow): CouncilSessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    inputType: row.input_type,
    inputContent: row.input_content,
    status: row.status,
    verdict: safeParseJSON<CouncilVerdict | null>(row.verdict_json, null),
    transcriptMd: row.transcript_md,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    grillSessionId: row.grill_session_id,
    structuredPlanJson: row.structured_plan_json,
    advisorReviews: safeParseJSON<CouncilReview[]>(row.advisor_reviews_json, []),
    peerReviews: safeParseJSON<CouncilPeerReview[]>(row.peer_reviews_json, []),
    phase: (row.phase || 'framing') as CouncilPhase,
    completedAdvisors: safeParseJSON<string[]>(row.completed_advisors, [])
  }
}

// ── Repository ──────────────────────────────────────────────────────────────

export class CouncilSessionRepository extends BaseRepository<
  CouncilSessionRow,
  CouncilSessionRecord
> {
  protected readonly tableName = 'council_sessions'
  protected mapRow(row: CouncilSessionRow): CouncilSessionRecord {
    return mapRow(row)
  }

  /** Create a new council session */
  createSession(params: {
    workspaceId: string
    inputType: CouncilInputType
    inputContent: string
    grillSessionId?: string
    structuredPlanJson?: string
    conversationId?: string
  }): CouncilSessionRecord {
    const id = crypto.randomUUID().replace(/-/g, '').toLowerCase()
    this.db()
      .prepare(
        `INSERT INTO council_sessions (id, workspace_id, conversation_id, input_type, input_content, grill_session_id, structured_plan_json, phase)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'framing')`
      )
      .run(
        id,
        params.workspaceId,
        params.conversationId ?? null,
        params.inputType,
        params.inputContent,
        params.grillSessionId ?? null,
        params.structuredPlanJson ?? null
      )
    return this.findById(id)!
  }

  /** Update the current phase */
  updatePhase(id: string, phase: CouncilPhase): void {
    this.db().prepare(`UPDATE council_sessions SET phase = ? WHERE id = ?`).run(phase, id)
  }

  /** Append a completed advisor review (incremental persistence) */
  appendAdvisorReview(id: string, review: CouncilReview): void {
    // Read current reviews, append, and write back
    const row = this.db()
      .prepare(`SELECT advisor_reviews_json, completed_advisors FROM council_sessions WHERE id = ?`)
      .get(id) as Pick<CouncilSessionRow, 'advisor_reviews_json' | 'completed_advisors'> | undefined

    if (!row) return

    const reviews = safeParseJSON<CouncilReview[]>(row.advisor_reviews_json, [])
    reviews.push(review)

    const completedAdvisors = safeParseJSON<string[]>(row.completed_advisors, [])
    if (!completedAdvisors.includes(review.advisorRole)) {
      completedAdvisors.push(review.advisorRole)
    }

    this.db()
      .prepare(
        `UPDATE council_sessions
       SET advisor_reviews_json = ?, completed_advisors = ?
       WHERE id = ?`
      )
      .run(JSON.stringify(reviews), JSON.stringify(completedAdvisors), id)
  }

  /** Save all peer reviews at once */
  savePeerReviews(id: string, peerReviews: CouncilPeerReview[]): void {
    this.db()
      .prepare(`UPDATE council_sessions SET peer_reviews_json = ? WHERE id = ?`)
      .run(JSON.stringify(peerReviews), id)
  }

  /** Save the chairman verdict */
  saveVerdict(id: string, verdict: CouncilVerdict): void {
    this.db()
      .prepare(`UPDATE council_sessions SET verdict_json = ? WHERE id = ?`)
      .run(JSON.stringify(verdict), id)
  }

  /** Save transcript markdown */
  saveTranscript(id: string, transcriptMd: string): void {
    this.db()
      .prepare(`UPDATE council_sessions SET transcript_md = ? WHERE id = ?`)
      .run(transcriptMd, id)
  }

  /** Update session status */
  updateStatus(id: string, status: CouncilSessionStatus): void {
    const completedAt =
      status === 'completed' || status === 'failed' || status === 'cancelled'
        ? new Date().toISOString()
        : null
    this.db()
      .prepare(
        `UPDATE council_sessions SET status = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`
      )
      .run(status, completedAt, id)
  }

  /** Delete a council session by ID */
  deleteSession(id: string): boolean {
    const result = this.db().prepare(`DELETE FROM council_sessions WHERE id = ?`).run(id)
    return result.changes > 0
  }

  /** Find sessions for a workspace, newest first */
  findByWorkspace(workspaceId: string, limit = 20): CouncilSessionRecord[] {
    const rows = this.db()
      .prepare(
        `SELECT * FROM council_sessions
         WHERE workspace_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(workspaceId, limit) as CouncilSessionRow[]
    return rows.map(mapRow)
  }

  /** Find the latest resumable session (running or failed — not completed/cancelled) */
  findResumable(workspaceId: string): CouncilSessionRecord | null {
    const row = this.db()
      .prepare(
        `SELECT * FROM council_sessions
         WHERE workspace_id = ? AND status IN ('running', 'failed')
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(workspaceId) as CouncilSessionRow | undefined
    return row ? mapRow(row) : null
  }

  /** Mark stale 'running' sessions as 'failed' (for app restart recovery) */
  markStaleAsFailed(workspaceId?: string): number {
    if (workspaceId) {
      return this.db()
        .prepare(
          `UPDATE council_sessions SET status = 'failed' WHERE workspace_id = ? AND status = 'running'`
        )
        .run(workspaceId).changes
    }
    return this.db()
      .prepare(`UPDATE council_sessions SET status = 'failed' WHERE status = 'running'`)
      .run().changes
  }
}

export const councilSessionRepository = new CouncilSessionRepository()
