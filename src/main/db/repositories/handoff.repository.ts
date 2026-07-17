/**
 * handoff.repository — CRUD for the unified handoff_events table.
 *
 * Persists HandoffEnvelope records with lifecycle tracking (pending →
 * accepted / rejected / expired / failed). Supports chain lineage
 * queries for tracing handoff history across features.
 */

import { BaseRepository } from '../base-repository'
import { safeParseJSON } from '../json-utils'
import type {
  HandoffRecord,
  HandoffStatus,
  HandoffSource,
  HandoffTarget,
  HandoffPriority,
  HandoffEnvelope
} from '../../../shared/handoff-types'
import { HANDOFF_RETENTION_LIMIT, MAX_CHAIN_DEPTH } from '../../../shared/handoff-types'

// ── Row shape (snake_case from DB) ───────────────────────────────────

interface HandoffRow {
  id: string
  workspace_id: string
  source: HandoffSource
  target: HandoffTarget
  envelope_json: string
  status: HandoffStatus
  source_session_id: string | null
  target_session_id: string | null
  parent_handoff_id: string | null
  intent: string
  priority: HandoffPriority
  confidence: number
  created_at: string
  accepted_at: string | null
  expires_at: string | null
  rejection_reason: string | null
}

function mapRow(row: HandoffRow): HandoffRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    source: row.source,
    target: row.target,
    envelopeJson: row.envelope_json,
    status: row.status,
    sourceSessionId: row.source_session_id,
    targetSessionId: row.target_session_id,
    parentHandoffId: row.parent_handoff_id,
    intent: row.intent,
    priority: row.priority,
    confidence: row.confidence,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    expiresAt: row.expires_at,
    rejectionReason: row.rejection_reason
  }
}

// ── Repository ───────────────────────────────────────────────────────

export class HandoffRepository extends BaseRepository<HandoffRow, HandoffRecord> {
  protected readonly tableName = 'handoff_events'

  protected mapRow(row: HandoffRow): HandoffRecord {
    return mapRow(row)
  }

  /** Persist a handoff envelope. Returns the saved record. */
  create(envelope: HandoffEnvelope): HandoffRecord {
    const row = this.db()
      .prepare(
        `INSERT INTO handoff_events (
          id, workspace_id, source, target, envelope_json, status,
          source_session_id, target_session_id, parent_handoff_id,
          intent, priority, confidence, expires_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
        RETURNING *`
      )
      .get(
        envelope.id,
        envelope.workspaceId,
        envelope.source,
        envelope.target,
        JSON.stringify(envelope),
        envelope.sourceSessionId ?? null,
        null, // target_session_id — set on accept
        envelope.parentHandoffId ?? null,
        envelope.intent,
        envelope.priority,
        envelope.confidence,
        envelope.expiresAt ?? null
      ) as HandoffRow

    // Enforce retention per workspace
    this.enforceRetention(envelope.workspaceId)

    return mapRow(row)
  }

  /** Get a single handoff by ID. */
  getById(id: string): HandoffRecord | null {
    const row = this.db()
      .prepare('SELECT * FROM handoff_events WHERE id = ?')
      .get(id) as HandoffRow | undefined
    return row ? mapRow(row) : null
  }

  /** Get handoffs for a workspace, newest first. */
  getForWorkspace(workspaceId: string, limit: number = 50): HandoffRecord[] {
    const rows = this.db()
      .prepare(
        'SELECT * FROM handoff_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?'
      )
      .all(workspaceId, limit) as HandoffRow[]
    return rows.map(mapRow)
  }

  /** Get pending handoffs for a workspace. */
  getPending(workspaceId: string): HandoffRecord[] {
    const rows = this.db()
      .prepare(
        "SELECT * FROM handoff_events WHERE workspace_id = ? AND status = 'pending' ORDER BY created_at DESC"
      )
      .all(workspaceId) as HandoffRow[]
    return rows.map(mapRow)
  }

  /** Mark a handoff as accepted and link the target session. Returns true if updated. */
  accept(handoffId: string, targetSessionId: string): boolean {
    const result = this.db()
      .prepare(
        `UPDATE handoff_events
         SET status = 'accepted', target_session_id = ?, accepted_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      )
      .run(targetSessionId, handoffId)
    return result.changes > 0
  }

  /** Mark a handoff as rejected with a reason. Returns true if updated. */
  reject(handoffId: string, reason: string): boolean {
    const result = this.db()
      .prepare(
        `UPDATE handoff_events
         SET status = 'rejected', rejection_reason = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(reason, handoffId)
    return result.changes > 0
  }

  /** Mark a handoff as failed. Returns true if updated. */
  markFailed(handoffId: string): boolean {
    const result = this.db()
      .prepare(
        `UPDATE handoff_events SET status = 'failed'
         WHERE id = ? AND status IN ('pending', 'accepted')`
      )
      .run(handoffId)
    return result.changes > 0
  }

  /** Expire stale handoffs past their TTL. Returns count of expired records. */
  expireStale(workspaceId: string): number {
    const result = this.db()
      .prepare(
        `UPDATE handoff_events
         SET status = 'expired'
         WHERE workspace_id = ? AND status = 'pending'
           AND expires_at IS NOT NULL AND expires_at < datetime('now')`
      )
      .run(workspaceId)
    return result.changes
  }

  /** Walk the parentHandoffId chain to reconstruct full lineage. */
  getChain(handoffId: string): HandoffRecord[] {
    const chain: HandoffRecord[] = []
    let currentId: string | null = handoffId

    // Walk backwards through parentHandoffId, bounded by MAX_CHAIN_DEPTH
    while (currentId && chain.length < MAX_CHAIN_DEPTH * 2) {
      const record = this.getById(currentId)
      if (!record) break
      chain.push(record)
      currentId = record.parentHandoffId
    }

    return chain.reverse() // Oldest first
  }

  /** Get handoffs originating from a specific session. */
  getBySourceSession(sourceSessionId: string): HandoffRecord[] {
    const rows = this.db()
      .prepare(
        'SELECT * FROM handoff_events WHERE source_session_id = ? ORDER BY created_at DESC'
      )
      .all(sourceSessionId) as HandoffRow[]
    return rows.map(mapRow)
  }

  /** Check if a source→target pair appears too many times in a pre-fetched chain (loop detection). */
  detectLoopInChain(chain: HandoffRecord[], source: HandoffSource, target: HandoffTarget): boolean {
    let pairCount = 0
    for (const record of chain) {
      if (record.source === source && record.target === target) {
        pairCount++
      }
    }
    return pairCount >= 3 // Warn if same pair appears 3+ times
  }

  /** Delete a handoff by ID. Returns true if deleted. */
  deleteHandoff(id: string): boolean {
    const result = this.db()
      .prepare('DELETE FROM handoff_events WHERE id = ?')
      .run(id)
    return result.changes > 0
  }

  /** Keep only the newest N handoffs per workspace. */
  enforceRetention(workspaceId: string, limit: number = HANDOFF_RETENTION_LIMIT): void {
    this.db()
      .prepare(
        `DELETE FROM handoff_events WHERE workspace_id = ? AND id NOT IN (
          SELECT id FROM handoff_events WHERE workspace_id = ?
          ORDER BY created_at DESC LIMIT ?
        )`
      )
      .run(workspaceId, workspaceId, limit)
  }

  /** Parse the envelope JSON from a record. */
  parseEnvelope(record: HandoffRecord): HandoffEnvelope | null {
    return safeParseJSON<HandoffEnvelope | null>(record.envelopeJson, null)
  }
}

export const handoffRepository = new HandoffRepository()
