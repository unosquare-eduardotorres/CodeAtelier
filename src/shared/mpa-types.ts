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

export interface MpaVerifyReport {
  allComplete: boolean
  totalItems: number
  implemented: number
  partial: number
  missing: number
  issues: MpaVerifyItem[]
  crossCutting: MpaVerifyCrossCutting
  testOutput: string
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
}
