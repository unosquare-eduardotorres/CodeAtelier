/**
 * base.adapter — Abstract base class for handoff source adapters.
 *
 * Every feature (Grill, Audit, Council, Blueprint, Chat, MPA) extends this
 * to implement a uniform toEnvelope() contract. The base class provides:
 *  - ID generation
 *  - Confidence calculation (derived, not guessed)
 *  - Default TTL computation
 *  - Shared validation
 *
 * Pattern inspired by NEO HandoffPacket + Context Passport.
 */

import { randomUUID } from 'node:crypto'
import type {
  HandoffEnvelope,
  HandoffSource,
  HandoffTarget,
  HandoffPriority,
  CompletedStep,
  RemainingStep,
  HandoffDecision,
  HandoffRisk,
  ArtifactRef,
  CodeAnchor
} from '../../../shared/handoff-types'
import { HANDOFF_TTL_DAYS, MAX_ENVELOPE_SIZE_BYTES } from '../../../shared/handoff-types'
import { redactEnvelope } from '../handoff-redaction'

// ── Confidence Calculation (I6 — derived, not guessed) ───────────────

export function calculateConfidence(envelope: Partial<HandoffEnvelope>): number {
  let score = 0.5
  if (envelope.structuredPlanRef) score += 0.2
  if (envelope.decisions && envelope.decisions.length > 0) score += 0.1
  if (envelope.completedWork && envelope.completedWork.length > 0) score += 0.1
  if (envelope.constraints && envelope.constraints.length > 0) score += 0.05
  if (envelope.risks && envelope.risks.length > 0) score += 0.05
  return Math.min(1.0, Math.round(score * 100) / 100)
}

// ── Base Input ───────────────────────────────────────────────────────

export interface BaseAdapterInput {
  workspaceId: string
  target: HandoffTarget
  parentHandoffId?: string
  sourceSessionId?: string
  createdBy?: 'user' | 'system'
  priority?: HandoffPriority
}

// ── Abstract Base ────────────────────────────────────────────────────

export abstract class HandoffSourceAdapter<TInput> {
  abstract readonly source: HandoffSource

  abstract extractIntent(input: TInput): string
  abstract extractOriginalGoal(input: TInput): string
  abstract extractContextSummary(input: TInput): string
  abstract extractCompletedWork(input: TInput): CompletedStep[]
  abstract extractRemainingWork(input: TInput): RemainingStep[]
  abstract extractDecisions(input: TInput): HandoffDecision[]
  abstract extractConstraints(input: TInput): string[]
  abstract extractRisks(input: TInput): HandoffRisk[]
  abstract extractArtifacts(input: TInput): ArtifactRef[]

  // Optional overrides
  extractCodeAnchors(_input: TInput): CodeAnchor[] {
    return []
  }
  extractSuggestedTools(_input: TInput): string[] {
    return []
  }
  extractSuggestedSkills(_input: TInput): string[] {
    return []
  }
  extractFilesToReadFirst(_input: TInput): string[] {
    return []
  }
  extractCommandsToRunFirst(_input: TInput): string[] {
    return []
  }
  extractExtensions(_input: TInput): Record<string, unknown> | undefined {
    return undefined
  }
  extractStructuredPlanRef(_input: TInput): string | undefined {
    return undefined
  }

  /**
   * Build a complete HandoffEnvelope from source-specific input.
   */
  toEnvelope(input: TInput, base: BaseAdapterInput): HandoffEnvelope {
    const partial: Partial<HandoffEnvelope> = {
      completedWork: this.extractCompletedWork(input),
      remainingWork: this.extractRemainingWork(input),
      decisions: this.extractDecisions(input),
      constraints: this.extractConstraints(input),
      risks: this.extractRisks(input),
      structuredPlanRef: this.extractStructuredPlanRef(input)
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + HANDOFF_TTL_DAYS * 24 * 60 * 60 * 1000)

    const envelope: HandoffEnvelope = {
      id: randomUUID(),
      version: 1,
      source: this.source,
      target: base.target,
      workspaceId: base.workspaceId,

      intent: truncate(this.extractIntent(input), 120),
      originalGoal: this.extractOriginalGoal(input),
      contextSummary: this.extractContextSummary(input),

      completedWork: partial.completedWork!,
      remainingWork: partial.remainingWork!,
      decisions: partial.decisions!,
      constraints: partial.constraints!,
      risks: partial.risks!,

      artifacts: this.extractArtifacts(input),
      codeAnchors: this.extractCodeAnchors(input),

      suggestedTools: this.extractSuggestedTools(input),
      suggestedSkills: this.extractSuggestedSkills(input),
      filesToReadFirst: this.extractFilesToReadFirst(input),
      commandsToRunFirst: this.extractCommandsToRunFirst(input),

      structuredPlanRef: partial.structuredPlanRef,
      parentHandoffId: base.parentHandoffId,
      sourceSessionId: base.sourceSessionId,
      extensions: this.extractExtensions(input),

      confidence: calculateConfidence(partial),
      priority: base.priority ?? 'medium',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      createdBy: base.createdBy ?? 'system'
    }

    // Validate envelope size
    const json = JSON.stringify(envelope)
    if (json.length > MAX_ENVELOPE_SIZE_BYTES) {
      throw new Error(
        `HandoffEnvelope exceeds max size (${json.length} bytes > ${MAX_ENVELOPE_SIZE_BYTES} bytes). ` +
          `Reduce contextSummary or artifact references.`
      )
    }

    // Apply redaction pipeline
    return redactEnvelope(envelope)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3) + '...'
}
