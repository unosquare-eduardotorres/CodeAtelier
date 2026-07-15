/**
 * Blueprint types — shared between main and renderer processes.
 *
 * A Blueprint is a structured specification pipeline that takes a feature idea
 * through 7 phases: specify → clarify → plan → tasks → review → build → verify.
 */

import type { ToolActivity } from './types'

// ── Phase & Status Enums ──

export type BlueprintPhaseType =
  | 'specify'
  | 'clarify'
  | 'plan'
  | 'tasks'
  | 'review'
  | 'build'
  | 'verify'

export type BlueprintStatus =
  | 'draft'
  | 'specifying'
  | 'clarifying'
  | 'planning'
  | 'tasking'
  | 'reviewing'
  | 'building'
  | 'verifying'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type BlueprintPhaseStatus = 'pending' | 'active' | 'complete' | 'skipped' | 'failed'

export type BlueprintPriority = 'P1' | 'P2' | 'P3'

export type BlueprintTaskStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'

// ── Core Entities ──

export interface Blueprint {
  id: string
  workspaceId: string
  title: string
  shortName: string
  description: string
  status: BlueprintStatus
  currentPhase: BlueprintPhaseType
  priority: BlueprintPriority
  sourceIdeaId: string | null
  constitutionSnapshot: string | null
  settingsJson: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface BlueprintPhase {
  id: string
  blueprintId: string
  phase: BlueprintPhaseType
  status: BlueprintPhaseStatus
  conversationId: string | null
  artifactsJson: BlueprintArtifact[]
  contextSnapshot: string | null
  startedAt: string | null
  completedAt: string | null
}

export interface BlueprintArtifact {
  type: string
  filePath?: string
  contentMd?: string
  contentJson?: Record<string, unknown>
}

export interface BlueprintTask {
  id: string
  blueprintId: string
  taskId: string
  wave: number
  userStory: string | null
  description: string
  filePathsJson: string[]
  isParallel: boolean
  dependsOnJson: string[]
  status: BlueprintTaskStatus
  executorRunId: string | null
  startedAt: string | null
  completedAt: string | null
}

// ── Composite / Joined Types ──

export interface BlueprintWithPhases extends Blueprint {
  phases: BlueprintPhase[]
}

export interface BlueprintWithDetails extends BlueprintWithPhases {
  tasks: BlueprintTask[]
}

// ── Reference Documents ──

export interface ReferenceDocument {
  type: 'file' | 'workspace-file' | 'url'
  path: string
  name: string
  url?: string
  label?: string
}

// ── Create / Update Params ──

export interface CreateBlueprintParams {
  workspaceId: string
  title: string
  description?: string
  priority?: BlueprintPriority
  sourceIdeaId?: string
  settingsJson?: Record<string, unknown>
}

export interface CreateFromIdeaParams {
  ideaId: string
  workspaceId: string
}

// ── Phase Context (assembled for prompt injection) ──

export interface PhaseContext {
  blueprint: {
    id: string
    title: string
    shortName: string
    description: string
    priority: BlueprintPriority
    currentPhase: BlueprintPhaseType
    settings: Record<string, unknown>
  }
  constitution: string | null
  previousArtifacts: BlueprintArtifact[]
  specFilePath: string
  blueprintDir: string
  grillDecisions?: GrillDecisionForBlueprint[]
  /** Pre-loaded workspace docs (CLAUDE.md, README.md, package.json, PLAN.md) for prompt injection */
  workspaceDocs?: string
}

export interface GrillDecisionForBlueprint {
  header: string
  selectedOption: string
  reason: string
}

// ── Phase Completion (parsed from agent output) ──

export interface BlueprintPhaseCompletion {
  phase: BlueprintPhaseType
  status: 'complete' | 'needs_clarification'
  artifacts?: Array<{ type: string; path: string }>
  [key: string]: unknown
}

// ── IPC Event Payloads ──

export interface BlueprintPhaseStartPayload {
  blueprintId: string
  workspaceId: string
  phase: BlueprintPhaseType
  /** Goal condition string for this phase — displayed in UI status bar. */
  goal?: string
  /** Total task count across all waves (build phase only). */
  totalTasks?: number
  /** Total wave count (build phase only). */
  totalWaves?: number
}

export interface BlueprintPhaseProgressPayload {
  blueprintId: string
  workspaceId: string
  phase: BlueprintPhaseType
  text: string
  /** 'tool' for tool-use events (tool name in text), 'text' or omitted for normal text chunks */
  kind?: 'text' | 'tool'
  /** Full tool activity data — enables expandable input/output panels in the UI */
  toolActivity?: Partial<ToolActivity> & { id: string; toolName: string }
}

export interface BlueprintPhaseCompletePayload {
  blueprintId: string
  workspaceId: string
  phase: BlueprintPhaseType
  status: BlueprintPhaseStatus
  completion?: BlueprintPhaseCompletion
  /** Error message when status is 'failed' — surfaced in the UI retry banner. */
  error?: string
  /** When true, an automatic retry has been scheduled for this transient failure. */
  autoRetry?: boolean
  /** Phase completion metrics (tasksCompleted, filesCreated, recommendation, etc.) */
  completionMetrics?: Record<string, unknown>
}

export interface BlueprintPhaseArtifactPayload {
  blueprintId: string
  workspaceId: string
  phase: BlueprintPhaseType
  artifact: BlueprintArtifact
}

export interface BlueprintClarifyAwaitingInputPayload {
  blueprintId: string
  workspaceId: string
}

export interface BlueprintClarifyFindingsPayload {
  blueprintId: string
  workspaceId: string
  findings: import('./blueprint-clarify-parsers').ClarifyFindingsBlock
}

export interface BlueprintClarifyQuestionsPayload {
  blueprintId: string
  workspaceId: string
  questions: import('./blueprint-clarify-parsers').ClarifyQuestionsBlock
}

export interface BlueprintClarifyGatePayload {
  blueprintId: string
  workspaceId: string
  findings: import('./blueprint-clarify-parsers').ClarifyFindingsBlock | null
  questions: import('./blueprint-clarify-parsers').ClarifyQuestionsBlock | null
}

export interface BlueprintApprovalNeededPayload {
  blueprintId: string
  workspaceId: string
  phase: BlueprintPhaseType
  planSummary: string
  /** Structured phase completion metrics (coverage, findings counts, recommendation, etc.) */
  completion?: BlueprintPhaseCompletion
  /** Full review report markdown (detailed findings, gaps, risks) */
  reviewMarkdown?: string
}

export interface BlueprintWaveStartPayload {
  blueprintId: string
  workspaceId: string
  wave: number
  taskCount: number
}

export interface BlueprintWaveTaskStartPayload {
  blueprintId: string
  workspaceId: string
  wave: number
  taskId: string
  description: string
  /** Per-task goal condition — shown in execution panel task detail. */
  goal?: string
}

export interface BlueprintWaveTaskCompletePayload {
  blueprintId: string
  workspaceId: string
  wave: number
  taskId: string
  status: BlueprintTaskStatus
}

export interface BlueprintWaveCompletePayload {
  blueprintId: string
  workspaceId: string
  wave: number
  status: 'complete' | 'failed'
}

// ── Pipeline Status (for UI) ──

export interface BlueprintPipelineStatus {
  status: 'idle' | 'running' | 'paused' | 'complete' | 'failed'
  blueprintId: string | null
  currentPhase: BlueprintPhaseType | null
  activeWave: number | null
  awaitingApproval: boolean
}

// ── Ordered phases (useful for iteration) ──

export const BLUEPRINT_PHASE_ORDER: readonly BlueprintPhaseType[] = [
  'specify',
  'clarify',
  'plan',
  'tasks',
  'review',
  'build',
  'verify'
] as const

/** Map blueprint phase → active status name for the blueprint record */
export const PHASE_TO_STATUS: Record<BlueprintPhaseType, BlueprintStatus> = {
  specify: 'specifying',
  clarify: 'clarifying',
  plan: 'planning',
  tasks: 'tasking',
  review: 'reviewing',
  build: 'building',
  verify: 'verifying'
}
