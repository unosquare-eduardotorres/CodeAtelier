/**
 * handoff.service — Central singleton orchestrating all cross-feature handoffs.
 *
 * Responsibilities:
 *  - Create and validate HandoffEnvelope instances
 *  - Persist to handoff_events table
 *  - Route to target adapters
 *  - Manage lifecycle (accept, reject, expire)
 *  - Track lineage chains
 *  - Enforce rate limits and size constraints
 *
 * Non-breaking: existing IPC channels keep working. This is a protocol
 * layer that wraps existing flows.
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import log from 'electron-log'
import { handoffRepository } from '../db/repositories/handoff.repository'
import { redactEnvelope } from './handoff-redaction'
import { resolveTargetAction, renderEnvelopeMarkdown } from './handoff-adapters/target-adapters'
import type {
  HandoffEnvelope,
  HandoffRecord,
  CreateHandoffParams,
  HandoffRenderFormat
} from '../../shared/handoff-types'
import { MAX_CHAIN_DEPTH, MAX_ENVELOPE_SIZE_BYTES, HANDOFF_TTL_DAYS } from '../../shared/handoff-types'
import { calculateConfidence } from './handoff-adapters/base.adapter'
import type { TargetAction } from './handoff-adapters/target-adapters'

const handoffLog = log.scope('handoff-service')

// ── Rate Limiting ────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const MAX_HANDOFFS_PER_MINUTE = 10

interface RateLimitEntry {
  timestamps: number[]
}

// ── Service ──────────────────────────────────────────────────────────

export class HandoffService extends EventEmitter {
  private rateLimits = new Map<string, RateLimitEntry>()

  // ── Create ──────────────────────────────────────────────────────

  /**
   * Create a HandoffEnvelope from raw params. Validates, generates ID,
   * calculates confidence, and applies redaction.
   */
  createEnvelope(params: CreateHandoffParams): HandoffEnvelope {
    // Validate intent length
    if (!params.intent || params.intent.length === 0) {
      throw new Error('HandoffEnvelope requires a non-empty intent')
    }
    if (!params.workspaceId) {
      throw new Error('HandoffEnvelope requires a workspaceId')
    }

    const VALID_SOURCES: Set<string> = new Set(['chat', 'grill', 'audit', 'council', 'blueprint', 'mpa'])
    const VALID_TARGETS: Set<string> = new Set(['chat', 'grill', 'audit', 'council', 'blueprint', 'goals'])
    if (!VALID_SOURCES.has(params.source)) {
      throw new Error(`Invalid handoff source: '${params.source}'. Valid: ${[...VALID_SOURCES].join(', ')}`)
    }
    if (!VALID_TARGETS.has(params.target)) {
      throw new Error(`Invalid handoff target: '${params.target}'. Valid: ${[...VALID_TARGETS].join(', ')}`)
    }

    const now = new Date()
    const expiresAt = params.expiresAt ??
      new Date(now.getTime() + HANDOFF_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

    const envelope: HandoffEnvelope = {
      id: randomUUID(),
      version: 1,
      source: params.source,
      target: params.target,
      workspaceId: params.workspaceId,

      intent: params.intent.slice(0, 120),
      originalGoal: params.originalGoal,
      contextSummary: params.contextSummary,

      completedWork: params.completedWork ?? [],
      remainingWork: params.remainingWork ?? [],
      decisions: params.decisions ?? [],
      constraints: params.constraints ?? [],
      risks: params.risks ?? [],
      artifacts: params.artifacts ?? [],
      codeAnchors: params.codeAnchors,

      suggestedTools: params.suggestedTools ?? [],
      suggestedSkills: params.suggestedSkills ?? [],
      filesToReadFirst: params.filesToReadFirst ?? [],
      commandsToRunFirst: params.commandsToRunFirst ?? [],

      structuredPlanRef: params.structuredPlanRef,
      parentHandoffId: params.parentHandoffId,
      sourceSessionId: params.sourceSessionId,
      extensions: params.extensions,

      confidence: 0, // Calculated below
      priority: params.priority ?? 'medium',
      createdAt: now.toISOString(),
      expiresAt,
      createdBy: params.createdBy ?? 'system',
    }

    // Validate extensions are JSON-serializable
    if (envelope.extensions) {
      try {
        JSON.stringify(envelope.extensions)
      } catch {
        throw new Error(
          'HandoffEnvelope extensions must be JSON-serializable (no circular references, functions, or BigInt)'
        )
      }
    }

    // Calculate confidence (I6 — derived, not set)
    envelope.confidence = calculateConfidence(envelope)

    // Validate envelope size
    const json = JSON.stringify(envelope)
    if (json.length > MAX_ENVELOPE_SIZE_BYTES) {
      throw new Error(
        `HandoffEnvelope exceeds max size (${json.length} > ${MAX_ENVELOPE_SIZE_BYTES} bytes)`
      )
    }

    // Apply redaction pipeline
    return redactEnvelope(envelope)
  }

  // ── Persist ─────────────────────────────────────────────────────

  /**
   * Persist a HandoffEnvelope to the database. Returns the saved record.
   * Enforces rate limits and chain depth.
   */
  persist(envelope: HandoffEnvelope): HandoffRecord {
    // Rate limit check
    this.checkRateLimit(envelope.workspaceId)

    // Chain depth check
    if (envelope.parentHandoffId) {
      const chain = handoffRepository.getChain(envelope.parentHandoffId)
      if (chain.length >= MAX_CHAIN_DEPTH) {
        throw new Error(
          `Handoff chain depth exceeds maximum (${MAX_CHAIN_DEPTH}). ` +
          `Chain: ${chain.map((r) => `${r.source}→${r.target}`).join(' → ')}`
        )
      }

      // Reuse the already-fetched chain (was: handoffRepository.detectLoop which re-fetches)
      if (handoffRepository.detectLoopInChain(chain, envelope.source, envelope.target)) {
        handoffLog.warn(
          `[handoff] Loop detected: ${envelope.source}→${envelope.target} appears 3+ times in chain`
        )
      }
    }

    const record = handoffRepository.create(envelope)

    handoffLog.info(
      `[handoff:created] id=${record.id} source=${envelope.source} target=${envelope.target} ` +
      `confidence=${envelope.confidence} intent="${envelope.intent}"`
    )

    this.emit('handoffCreated', record)
    return record
  }

  // ── Execute ─────────────────────────────────────────────────────

  /**
   * Execute a handoff: persist the envelope and resolve the target action.
   * Returns the action descriptor for the caller to execute.
   *
   * The actual target execution (creating conversations, sessions, etc.)
   * is handled by the IPC layer using the returned TargetAction.
   */
  executeHandoff(envelope: HandoffEnvelope): { record: HandoffRecord; action: TargetAction } {
    const record = this.persist(envelope)
    const action = resolveTargetAction(envelope)

    handoffLog.info(
      `[handoff:execute] id=${record.id} target=${action.type}`
    )

    this.emit('handoffExecuted', { record, action })
    return { record, action }
  }

  // ── Accept ──────────────────────────────────────────────────────

  /**
   * Mark a handoff as accepted and link the target session.
   */
  accept(handoffId: string, targetSessionId: string): void {
    const updated = handoffRepository.accept(handoffId, targetSessionId)
    if (!updated) {
      throw new Error(`Handoff '${handoffId}' not found or not in 'pending' status`)
    }

    handoffLog.info(
      `[handoff:accepted] id=${handoffId} targetSession=${targetSessionId}`
    )

    this.emit('handoffAccepted', { handoffId, targetSessionId })
  }

  // ── Reject ──────────────────────────────────────────────────────

  /**
   * Mark a handoff as rejected with a reason.
   */
  reject(handoffId: string, reason: string): void {
    const updated = handoffRepository.reject(handoffId, reason)
    if (!updated) {
      throw new Error(`Handoff '${handoffId}' not found or not in 'pending' status`)
    }

    handoffLog.info(
      `[handoff:rejected] id=${handoffId} reason="${reason}"`
    )

    this.emit('handoffRejected', { handoffId, reason })
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Expire stale handoffs past their TTL. Returns count of expired records.
   */
  expireStale(workspaceId: string): number {
    const count = handoffRepository.expireStale(workspaceId)
    if (count > 0) {
      handoffLog.info(`[handoff:expire] Expired ${count} stale handoff(s) for workspace ${workspaceId}`)
    }
    return count
  }

  // ── Queries ─────────────────────────────────────────────────────

  /**
   * Get handoff history for a workspace.
   */
  getHistory(workspaceId: string, limit: number = 50): HandoffRecord[] {
    return handoffRepository.getForWorkspace(workspaceId, limit)
  }

  /**
   * Get pending handoffs for a workspace.
   */
  getPending(workspaceId: string): HandoffRecord[] {
    return handoffRepository.getPending(workspaceId)
  }

  /**
   * Get the full lineage chain for a handoff.
   */
  getChain(handoffId: string): HandoffRecord[] {
    return handoffRepository.getChain(handoffId)
  }

  /**
   * Get a single handoff by ID.
   */
  getById(id: string): HandoffRecord | null {
    return handoffRepository.getById(id)
  }

  // ── Preview ─────────────────────────────────────────────────────

  /**
   * Generate a preview of a handoff without persisting.
   * Returns the envelope + rendered markdown.
   */
  preview(params: CreateHandoffParams, format: HandoffRenderFormat = 'standard'): {
    envelope: HandoffEnvelope
    markdown: string
    action: TargetAction
  } {
    const envelope = this.createEnvelope(params)
    return {
      envelope,
      markdown: renderEnvelopeMarkdown(envelope, format),
      action: resolveTargetAction(envelope),
    }
  }

  // ── Render ──────────────────────────────────────────────────────

  /**
   * Render an envelope as markdown (delegates to target-adapters).
   */
  renderMarkdown(envelope: HandoffEnvelope, format: HandoffRenderFormat = 'standard'): string {
    return renderEnvelopeMarkdown(envelope, format)
  }

  // ── Rate Limiting ───────────────────────────────────────────────

  private checkRateLimit(workspaceId: string): void {
    const now = Date.now()
    let entry = this.rateLimits.get(workspaceId)

    if (!entry) {
      entry = { timestamps: [] }
      this.rateLimits.set(workspaceId, entry)
    }

    // Prune old timestamps
    entry.timestamps = entry.timestamps.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS)

    if (entry.timestamps.length >= MAX_HANDOFFS_PER_MINUTE) {
      throw new Error(
        `Rate limit exceeded: max ${MAX_HANDOFFS_PER_MINUTE} handoffs per minute per workspace`
      )
    }

    entry.timestamps.push(now)
  }
}

// ── Singleton ────────────────────────────────────────────────────────

export const handoffService = new HandoffService()
