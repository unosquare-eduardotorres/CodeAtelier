/**
 * S3: Local Plan State Persistence — saves plan progress across sessions for local LLMs.
 *
 * Stores discovered context, partial plans, and continuation state in SQLite
 * so that when a local LLM session is interrupted (context overflow, max_turns,
 * error), the next attempt can resume from where it left off.
 *
 * The `local_plan_state` table is created by migration 87.
 */

import { getDatabase } from '../db/index'
import { chatAgentLogger } from '../logger'

const log = chatAgentLogger

// ── Types ──

export interface DiscoveredContext {
  filesExplored: string[]
  keyFindings: string[]
  planItems: string[]
  nextSteps: string[]
}

export interface LocalPlanState {
  id: string
  conversationId: string
  workspaceId: string
  originalRequest: string
  discoveredContext: DiscoveredContext
  planText: string
  status: 'in_progress' | 'completed' | 'abandoned'
  continuationCount: number
  createdAt: string
  updatedAt: string
}

interface PlanStateRow {
  id: string
  conversation_id: string
  workspace_id: string
  original_request: string
  discovered_context: string
  plan_text: string | null
  status: string
  continuation_count: number
  created_at: string
  updated_at: string
}

function mapRow(row: PlanStateRow): LocalPlanState {
  let discoveredContext: DiscoveredContext
  try {
    discoveredContext = JSON.parse(row.discovered_context) as DiscoveredContext
  } catch {
    discoveredContext = { filesExplored: [], keyFindings: [], planItems: [], nextSteps: [] }
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    originalRequest: row.original_request,
    discoveredContext,
    planText: row.plan_text ?? '',
    status: row.status as LocalPlanState['status'],
    continuationCount: row.continuation_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// ── Service ──

export class LocalPlanStateService {
  /**
   * Create or update plan state for a conversation.
   * Uses INSERT OR REPLACE (upsert) keyed on conversation_id.
   */
  upsert(params: {
    conversationId: string
    workspaceId: string
    originalRequest: string
    discoveredContext: DiscoveredContext
    planText?: string
  }): void {
    const db = getDatabase()
    const { conversationId, workspaceId, originalRequest, discoveredContext, planText } = params

    // Check if state already exists for this conversation
    const existing = db
      .prepare('SELECT id, continuation_count FROM local_plan_state WHERE conversation_id = ?')
      .get(conversationId) as { id: string; continuation_count: number } | undefined

    if (existing) {
      db.prepare(
        `UPDATE local_plan_state
         SET discovered_context = ?, plan_text = ?, continuation_count = ?,
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        JSON.stringify(discoveredContext),
        planText ?? '',
        existing.continuation_count + 1,
        existing.id
      )
      log.info(
        `[S3:plan-state-updated] conversationId=${conversationId} continuations=${existing.continuation_count + 1}`
      )
    } else {
      db.prepare(
        `INSERT INTO local_plan_state
           (conversation_id, workspace_id, original_request, discovered_context, plan_text)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        conversationId,
        workspaceId,
        originalRequest,
        JSON.stringify(discoveredContext),
        planText ?? ''
      )
      log.info(`[S3:plan-state-created] conversationId=${conversationId}`)
    }
  }

  /** Get plan state for a specific conversation */
  getForConversation(conversationId: string): LocalPlanState | null {
    const db = getDatabase()
    const row = db
      .prepare('SELECT * FROM local_plan_state WHERE conversation_id = ?')
      .get(conversationId) as PlanStateRow | undefined
    return row ? mapRow(row) : null
  }

  /** Get the latest in-progress plan state for a workspace */
  getLatestForWorkspace(workspaceId: string): LocalPlanState | null {
    const db = getDatabase()
    const row = db
      .prepare(
        `SELECT * FROM local_plan_state
         WHERE workspace_id = ? AND status = 'in_progress'
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(workspaceId) as PlanStateRow | undefined
    return row ? mapRow(row) : null
  }

  /** Mark a plan as completed */
  markCompleted(conversationId: string): void {
    const db = getDatabase()
    db.prepare(
      `UPDATE local_plan_state
       SET status = 'completed', updated_at = datetime('now')
       WHERE conversation_id = ?`
    ).run(conversationId)
  }

  /** Mark a plan as abandoned (e.g. new conversation started in same workspace) */
  markAbandoned(conversationId: string): void {
    const db = getDatabase()
    db.prepare(
      `UPDATE local_plan_state
       SET status = 'abandoned', updated_at = datetime('now')
       WHERE conversation_id = ?`
    ).run(conversationId)
  }

  /**
   * F6: Mark all in-progress plans for a workspace as abandoned,
   * except for the current conversation. Called on conversation switch
   * to prevent stale plans from polluting getLatestForWorkspace().
   */
  markAbandonedForWorkspace(workspaceId: string, excludeConversationId?: string): void {
    const db = getDatabase()
    if (excludeConversationId) {
      db.prepare(
        `UPDATE local_plan_state
         SET status = 'abandoned', updated_at = datetime('now')
         WHERE workspace_id = ? AND status = 'in_progress' AND conversation_id != ?`
      ).run(workspaceId, excludeConversationId)
    } else {
      db.prepare(
        `UPDATE local_plan_state
         SET status = 'abandoned', updated_at = datetime('now')
         WHERE workspace_id = ? AND status = 'in_progress'`
      ).run(workspaceId)
    }
  }
}

export const localPlanStateService = new LocalPlanStateService()
