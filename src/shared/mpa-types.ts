// ── Multi-Phased Agent (MPA) Pipeline Types ──────────────────────────────────

/** Phase types in the MPA pipeline */
export type MpaPhaseType = 'plan' | 'execute' | 'verify'

/** Goal classification categories */
export type MpaGoalType = 'feature' | 'refactor' | 'bugfix' | 'tests'

/** Run status lifecycle */
export type MpaRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

/** Phase status lifecycle */
export type MpaPhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

/** Artifact types produced by phases */
export type MpaArtifactType = 'plan' | 'verify_report' | 'goal_spec'

/** User gate response for plan approval */
export interface MpaGateResponse {
  approved: boolean
  feedback?: string
}

// ── Plan Artifact ──

export interface MpaPlanItem {
  id: string
  title: string
  description: string
  files: string[]
  scope: 'backend' | 'frontend' | 'database' | 'shared' | 'tests'
  dependsOn: string[]
  includesTests: boolean
}

export interface MpaPlanArtifact {
  goalType: MpaGoalType
  summary: string
  items: MpaPlanItem[]
  risks: string[]
  existingPatterns: string[]
}

// ── Verify Report ──

export interface MpaVerifyItem {
  planItemId: string
  status: 'implemented' | 'partial' | 'missing'
  detail: string
  filesChecked: string[]
}

export interface MpaVerifyCrossCutting {
  frontendBackendConnected: boolean
  backendDatabaseConnected: boolean
  routesRegistered: boolean
  testsPass: boolean
}

/** Per-success-criterion verification result (campaign goals). */
export interface MpaCriterionResult {
  criterion: string
  status: 'pass' | 'fail'
  detail: string
}

export interface MpaVerifyReport {
  allComplete: boolean
  totalItems: number
  implemented: number
  partial: number
  missing: number
  issues: MpaVerifyItem[]
  crossCutting: MpaVerifyCrossCutting
  testOutput: string
  /** Per-criterion pass/fail when the run was given explicit success criteria. */
  criteriaResults?: MpaCriterionResult[]
}

// ── DB Models ──

export interface MpaRun {
  id: string
  workspaceId: string
  conversationId: string | null
  grillSessionId: string | null
  title: string
  goal: string
  goalType: MpaGoalType
  status: MpaRunStatus
  currentPhase: string | null
  configJson: Record<string, unknown>
  createdAt: string
  completedAt: string | null
  totalTokens: number
  /** Campaign linkage (null for standalone/legacy runs). */
  campaignId: string | null
  orderIndex: number | null
  /** Blueprint linkage (null for non-blueprint runs). */
  blueprintId: string | null
  blueprintPhaseId: string | null
}

/** Persisted campaign record (sequential measurable-goal run group). */
export interface MpaCampaign {
  id: string
  workspaceId: string
  title: string
  originalPlanMd: string
  status: MpaCampaignStatus
  createdAt: string
  completedAt: string | null
}

export interface MpaPhase {
  id: string
  runId: string
  phaseType: MpaPhaseType
  iteration: number
  status: MpaPhaseStatus
  agentRole: string
  goalCondition: string | null
  inputArtifactId: string | null
  outputArtifactId: string | null
  startedAt: string | null
  completedAt: string | null
  tokensUsed: number
  streamContent: string
}

export interface MpaArtifact {
  id: string
  runId: string
  phaseId: string | null
  artifactType: MpaArtifactType
  contentJson: MpaPlanArtifact | MpaVerifyReport | Record<string, unknown>
  contentMd: string | null
  version: number
  createdAt: string
}

// ── Grill Decision (for plan context) ──

export interface GrillDecision {
  header: string
  selectedOption: string
  reason: string
}

// ── Orchestration Params ──

export interface MpaOrchestrateParams {
  workspaceId: string
  workspacePath: string
  goal: string
  title: string
  goalType: MpaGoalType
  phases: MpaPhaseType[]
  grillSessionId?: string
  grillDecisions?: GrillDecision[]
  /** Campaign linkage + per-goal success criteria (campaign runs only). */
  campaignId?: string
  orderIndex?: number
  successCriteria?: string[]
}

// ── Pre-flight Classification Result ──

export interface MpaClassifyResult {
  goalType: MpaGoalType
  phases: MpaPhaseType[]
  isValid: boolean
  rejectionReason?: string
  suggestedGoal?: string
}

// ── IPC Event Payloads ──

export interface MpaPhaseStartPayload {
  runId: string
  phaseId: string
  phaseType: MpaPhaseType
  iteration: number
  agentRole: string
}

export interface MpaPhaseProgressPayload {
  runId: string
  phaseId: string
  phaseType: MpaPhaseType
  streamChunk: string
}

export interface MpaPhaseCompletePayload {
  runId: string
  phaseId: string
  phaseType: MpaPhaseType
  status: MpaPhaseStatus
  artifactId?: string
  tokensUsed: number
}

export interface MpaFeedbackLoopPayload {
  runId: string
  fromPhase: MpaPhaseType
  toPhase: MpaPhaseType
  iteration: number
  reason: string
}

export interface MpaApprovalNeededPayload {
  runId: string
  phaseId: string
  artifactId: string
  artifact: MpaPlanArtifact
}

export interface MpaPipelineCompletePayload {
  runId: string
  status: MpaRunStatus
  continuationConversationId?: string
  totalTokens: number
}

// ── Status for UI ──

export interface MpaStatus {
  status: MpaRunStatus | 'idle'
  runId: string | null
  currentPhase: MpaPhaseType | null
  phaseIndex: number
  totalPhases: number
  iteration: number
  awaitingApproval: boolean
}

// ── Pre-loaded Goal (from Grill → Goals flow) ──

export interface MpaPreloadedGoal {
  text: string
  grillSessionId?: string
  grillDecisions?: GrillDecision[]
  /** When true, the campaign panel auto-decomposes the text into goals on mount
   *  (set on a successful greenfield handoff so the user lands on editable
   *  goals rather than a raw text box). Left false on a degraded handoff so the
   *  user reviews the fallback notice first. */
  autoDecompose?: boolean
}

// ── Measurable Goals (decomposer → campaign) ──

/** A single measurable goal produced by the goal decomposer. Each goal becomes
 *  its own sequential MPA run within a campaign. */
export interface MeasurableGoal {
  id: string
  title: string
  /** The concrete outcome this goal achieves. */
  outcome: string
  /** Checkable, independently-verifiable success criteria. */
  successCriteria: string[]
  goalType: MpaGoalType
  /** Phases derived locally from goalType (PHASE_TEMPLATES). */
  phases: MpaPhaseType[]
}

/** Result of decomposing a plan / typed input into measurable goals. */
export interface GoalDecomposeResult {
  goals: MeasurableGoal[]
}

// ── Campaign (sequential measurable-goal runs) ──

export type MpaCampaignStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export type MpaCampaignGoalStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

/** How the user resolves a paused campaign (verify/run failure on a goal). */
export type MpaCampaignPauseAction = 'retry' | 'skip' | 'stop'

export interface MpaCampaignStartParams {
  workspaceId: string
  title: string
  /** Original plan / typed input the goals were decomposed from. */
  originalPlanMd: string
  goals: MeasurableGoal[]
}

/** Per-goal state tracked by the in-memory campaign supervisor. */
export interface MpaCampaignGoalState {
  goal: MeasurableGoal
  orderIndex: number
  status: MpaCampaignGoalStatus
  runId: string | null
}

// ── Campaign IPC Event Payloads ──

export interface MpaCampaignStartedPayload {
  campaignId: string
  workspaceId: string
  title: string
  totalGoals: number
}

export interface MpaCampaignGoalStartPayload {
  campaignId: string
  orderIndex: number
  goalId: string
  title: string
}

export interface MpaCampaignGoalCompletePayload {
  campaignId: string
  orderIndex: number
  goalId: string
  status: MpaCampaignGoalStatus
  runId: string | null
}

export interface MpaCampaignPausedPayload {
  campaignId: string
  orderIndex: number
  goalId: string
  runId: string | null
  reason: string
}

export interface MpaCampaignCompletePayload {
  campaignId: string
  status: MpaCampaignStatus
  completedGoals: number
  totalGoals: number
}
