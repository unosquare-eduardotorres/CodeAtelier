/**
 * handoff-types — Unified Handoff Protocol type definitions.
 *
 * Every cross-feature handoff (Grill → Chat, Audit → Chat, Council → Chat,
 * Blueprint → Chat, Chat → Grill, etc.) produces a HandoffEnvelope that
 * standardizes what crosses the boundary.
 *
 * Inspired by: NEO HandoffPacket, Context Passport envelope,
 * OpenLegion Blackboard-Pointer pattern, Context Pack MCP anchors.
 */

// ── Source & Target ──────────────────────────────────────────────────

export type HandoffSource = 'chat' | 'grill' | 'audit' | 'council' | 'blueprint' | 'mpa'
export type HandoffTarget = 'chat' | 'grill' | 'audit' | 'council' | 'blueprint' | 'goals'

// ── Handoff Status ───────────────────────────────────────────────────

export type HandoffStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'failed'

// ── Sub-types ────────────────────────────────────────────────────────

export interface CompletedStep {
  title: string
  outcome: string
  filesModified?: string[]
}

export interface RemainingStep {
  title: string
  description: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  estimatedComplexity?: number // 1-10
}

export interface HandoffDecision {
  what: string
  why: string
  alternatives?: string[]
}

export interface HandoffRisk {
  risk: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  mitigation?: string
}

export type ArtifactType =
  'plan' | 'spec' | 'adr' | 'blueprint' | 'issue' | 'commit' | 'diff' | 'finding'

export interface ArtifactRef {
  type: ArtifactType
  path: string // File path, URL, or ID reference
  description: string // ≤100 chars
}

export interface CodeAnchor {
  file: string
  startLine: number
  endLine: number
  title: string // e.g. "Database migration for user preferences"
}

// ── The Envelope ─────────────────────────────────────────────────────

export type HandoffPriority = 'low' | 'medium' | 'high' | 'critical'

export interface HandoffEnvelope {
  // Identity
  id: string // UUID
  version: 1 // Schema version for future migration
  source: HandoffSource
  target: HandoffTarget
  workspaceId: string

  // Intent (what and why)
  intent: string // ≤120 chars: "Fix 5 critical audit findings"
  originalGoal: string // The user's original request (preserved across chain)
  contextSummary: string // ≤500 words: structured summary of prior work

  // State Transfer (what's done and what's left)
  completedWork: CompletedStep[]
  remainingWork: RemainingStep[]
  decisions: HandoffDecision[]
  constraints: string[]
  risks: HandoffRisk[]

  // Artifact References (NEVER content duplication — blackboard-pointer pattern)
  artifacts: ArtifactRef[]

  // Code Anchors (precise entry points for the receiving agent)
  codeAnchors?: CodeAnchor[]

  // Recommendations for Receiving Agent
  suggestedTools: string[]
  suggestedSkills: string[]
  filesToReadFirst: string[]
  commandsToRunFirst: string[]

  // Structured Plan (reference by ID — not inline content)
  structuredPlanRef?: string // plan record ID — receiver calls planRepository.getById()

  // Lineage (chain tracking)
  parentHandoffId?: string // Previous handoff in the chain
  sourceSessionId?: string // Conversation/session that produced this

  // Source-specific extensions (escape hatch for feature-specific metadata)
  extensions?: Record<string, unknown>

  // Metadata
  confidence: number // 0.0-1.0: auto-calculated from completedWork/remainingWork
  priority: HandoffPriority
  createdAt: string // ISO 8601
  expiresAt?: string // Optional TTL
  createdBy: 'user' | 'system' // Who initiated the handoff
}

// ── Persisted Record ─────────────────────────────────────────────────

export interface HandoffRecord {
  id: string
  workspaceId: string
  source: HandoffSource
  target: HandoffTarget
  envelopeJson: string // Full HandoffEnvelope JSON
  status: HandoffStatus
  sourceSessionId: string | null
  targetSessionId: string | null
  parentHandoffId: string | null
  intent: string // Denormalized for fast queries
  priority: HandoffPriority
  confidence: number
  createdAt: string
  acceptedAt: string | null
  expiresAt: string | null
  rejectionReason: string | null
}

// ── Create Params ────────────────────────────────────────────────────

export interface CreateHandoffParams {
  source: HandoffSource
  target: HandoffTarget
  workspaceId: string
  intent: string
  originalGoal: string
  contextSummary: string

  completedWork?: CompletedStep[]
  remainingWork?: RemainingStep[]
  decisions?: HandoffDecision[]
  constraints?: string[]
  risks?: HandoffRisk[]
  artifacts?: ArtifactRef[]
  codeAnchors?: CodeAnchor[]

  suggestedTools?: string[]
  suggestedSkills?: string[]
  filesToReadFirst?: string[]
  commandsToRunFirst?: string[]

  structuredPlanRef?: string
  parentHandoffId?: string
  sourceSessionId?: string
  extensions?: Record<string, unknown>

  priority?: HandoffPriority
  createdBy?: 'user' | 'system'
  expiresAt?: string
}

// ── Serialization Formats ────────────────────────────────────────────

export type HandoffRenderFormat = 'full' | 'standard' | 'compact'

// ── Constants ────────────────────────────────────────────────────────

export const MAX_CHAIN_DEPTH = 10
export const MAX_ENVELOPE_SIZE_BYTES = 64 * 1024 // 64KB
export const HANDOFF_TTL_DAYS = 30
export const HANDOFF_RETENTION_LIMIT = 100
