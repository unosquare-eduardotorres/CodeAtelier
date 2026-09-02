/**
 * Blueprint types — shared between main and renderer processes.
 *
 * A Blueprint is a structured specification pipeline that takes a feature idea
 * through 7 phases: specify → clarify → plan → tasks → review → build → verify.
 */

import type { ToolActivity } from './types'
import type { GateReport, UnverifiedItem } from './gate-types'

// ── Phase & Status Enums ──

import type { TrackOwnerKind } from './track-types'

export type BlueprintPhaseType =
  | 'specify'
  | 'clarify'
  | 'plan'
  | 'tasks'
  | 'review'
  | 'build'
  /**
   * Layer 4 — adversarial whole-diff review by an external model, between
   * BUILD and VERIFY. Skipped (`BlueprintPhaseStatus 'skipped'`) when the
   * `blueprint:code-review` role is bound off.
   */
  | 'code-review'
  | 'verify'

export type BlueprintStatus =
  | 'draft'
  | 'specifying'
  | 'clarifying'
  | 'planning'
  | 'tasking'
  | 'reviewing'
  | 'building'
  | 'codeReviewing'
  | 'verifying'
  | 'complete'
  | 'failed'
  | 'cancelled'

export type BlueprintPhaseStatus = 'pending' | 'active' | 'complete' | 'skipped' | 'failed'

export type BlueprintPriority = 'P1' | 'P2' | 'P3'

export type BlueprintTaskStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'

/**
 * How a task was closed, as opposed to merely that it closed. Kept off `status`
 * on purpose: `blueprint_tasks.status` carries a CHECK constraint, so a new
 * status value costs a table rebuild and every switch in main/preload/renderer.
 */
export type BlueprintTaskOutcomeKind =
  /** Claimed files exist and were written during this run. */
  | 'verified'
  /** Claimed files exist, but none could be proven fresh. Passed with a warning. */
  | 'unproven'
  /** Agent declared the files already correct and deliberately did not rewrite them. */
  | 'preexisting'
  /** A human closed the task out — the work is done, just not provable here. */
  | 'accepted_by_user'

// ── Work Packets ──

/**
 * One acceptance criterion, and the mechanical check that settles it.
 *
 * `howVerified` is required by contract. A criterion without one is an opinion:
 * two models will disagree about whether it holds, and neither the gates nor
 * the lead reviewer has anything to point at.
 */
export interface AcceptanceCriterion {
  text: string
  /** e.g. "`npm test src/foo.test.ts` passes" or "`GET /health` returns 200". */
  howVerified: string
}

/** A pre-read code excerpt handed to the builder so it never has to explore. */
export interface ContextExcerpt {
  path: string
  excerpt: string
  /** Why this was included — keeps a weak builder from pattern-matching the wrong part. */
  note?: string
}

/**
 * Everything a builder needs to do ONE task without exploring the codebase.
 *
 * The packet is also the gate contract: `allowedFiles` is the write-set G4
 * enforces, `testFiles` are the tests G5 protects and G6 runs, and
 * `acceptanceCriteria` is what the lead reviewer diffs against. A task with no
 * packet still builds — those gates just report `unverifiable` / `no_packet`.
 */
export interface BlueprintWorkPacket {
  /** Pre-read snippets, pasted into the build prompt verbatim. */
  contextExcerpts?: ContextExcerpt[]
  /** Signatures / scaffolds to implement against. */
  interfaces?: string[]
  acceptanceCriteria?: AcceptanceCriterion[]
  /** The write-set. Anything changed outside this fails G4. */
  allowedFiles?: string[]
  /** Explicitly off-limits paths (migrations, generated code, other tasks' files). */
  forbiddenFiles?: string[]
  /** Pre-authored failing tests. Modifying these fails G5. */
  testFiles?: string[]
  /** 3–5 task-relevant rules only — a full convention dump crowds out the task. */
  conventions?: string[]
  /**
   * Runner-specific command that executes just this task's tests. Optional:
   * without it the gates run the full resolved test command, because targeting
   * syntax differs per runner and guessing it produces a spawn error that looks
   * exactly like a red test.
   */
  testCommand?: string
}

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
  completedAt: string | null
  /**
   * Accumulated ledger of checks that could not be run across the whole run.
   * Non-empty at completion means the blueprint finished UNPROVEN, not wrong.
   */
  unverifiedJson: UnverifiedItem[] | null
}

/**
 * A blueprint that finished but could not prove all of its work.
 *
 * Derived rather than stored: a persisted flag can drift from the ledger it
 * describes, and there is exactly one right answer given the ledger.
 */
export function isCompletedWithWarnings(blueprint: {
  status: BlueprintStatus
  unverifiedJson: UnverifiedItem[] | null
}): boolean {
  return blueprint.status === 'complete' && (blueprint.unverifiedJson?.length ?? 0) > 0
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
  /** SIZE-GUARD: true when `contentMd` was truncated for the IPC payload — full text remains in the DB / on disk. */
  truncated?: boolean
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
  completionJson: {
    filesCreated: string[]
    filesModified: string[]
    filesVerifiedUnchanged?: string[]
  } | null
  /**
   * ISO timestamp of a deliberate user skip, or null. Separate from `status`
   * because the failure cascade writes `status = 'skipped'` on its own and a
   * retry resets `status` — neither may forge or erase a human decision.
   */
  skippedByUserAt: string | null
  /**
   * Why the last attempt failed, persisted rather than emitted-and-forgotten.
   * Survives the retry reset so the next attempt can be told what went wrong.
   */
  failureReason: string | null
  outcomeKind: BlueprintTaskOutcomeKind | null
  /** Optional human note recorded when a task is accepted as done. */
  resolutionNote: string | null
  /** Work packet authored by the TASKS phase. Null for pre-packet blueprints. */
  packetJson: BlueprintWorkPacket | null
  /** Last deterministic gate run for this task. */
  gatesJson: GateReport | null
  /** Gate checks that could not run — warnings, never blockers. */
  unverifiedJson: UnverifiedItem[] | null
  /** Builder attempts spent on this task, including the first. */
  attempts: number
  /** Role the task was escalated to after builder retries ran out, if any. */
  escalatedTo: string | null
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

// ── Branch selection ──

/**
 * How a blueprint run picks the branch it works on.
 *
 * Git allows a branch in exactly one worktree repo-wide, so "share a branch"
 * can only mean one of two things, and they are different enough to need
 * different modes: `fork` runs beside the other work on a branch of its own
 * taken from theirs, while `takeover` moves the branch from its current owner
 * to this blueprint. Concurrent shared writing is deliberately absent — it is
 * the exact failure the track system exists to remove.
 *
 *  - `auto`     — `blueprint/<slug>-<id8>` off primary HEAD. The default, and
 *                 what every blueprint did before branch selection existed.
 *  - `fork`     — a new branch cut from a chosen base (typically a chat's
 *                 branch). Both keep running, fully parallel.
 *  - `takeover` — work directly on an existing branch, taking ownership of it.
 *  - `primary`  — run in the workspace checkout under the primary-tree lock.
 *                 Not a failure state: it is the only option on a repo with no
 *                 commits, and the honest answer when the user wants output in
 *                 their own working copy.
 */
export type BlueprintBranchMode = 'auto' | 'fork' | 'takeover' | 'primary'

export interface BlueprintBranchChoice {
  mode: BlueprintBranchMode
  /** `fork`: the base to branch from. `takeover`: the branch to work on. */
  branch?: string
  /** `fork` only — overrides the generated branch name. */
  name?: string
}

/** One selectable branch, with what the picker needs to disable and explain it. */
export interface BlueprintBranchOption {
  name: string
  /**
   * The workspace checkout is sitting on this branch.
   *
   * Git allows a branch in one worktree only, so taking this one over runs in
   * the primary tree with no isolation at all. Not an error — but it has to be
   * said at pick time rather than discovered when build output lands in the
   * user's working copy.
   */
  isPrimaryHead: boolean
  /** The track holding this branch, when one does. */
  heldBy: {
    ownerKind: TrackOwnerKind
    /** Null for retained work — nobody owns it, so it is free to take. */
    ownerId: string | null
    /** Chat title where resolvable; otherwise the owner id. */
    label: string | null
  } | null
}

export interface BlueprintBranchOptions {
  branches: BlueprintBranchOption[]
  /**
   * False on a repo with no commits, where `primary` is the only workable mode:
   * there are no branches to show and nothing to isolate from yet.
   */
  repoHasCommits: boolean
  /** The workspace checkout's branch, or null on an unborn HEAD. */
  currentBranch: string | null
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
  /**
   * Every change the human has asked for on this blueprint, oldest first.
   *
   * Threaded into PLAN/TASKS/REVIEW on every run — not just the next one. A
   * re-run that cannot see round 1's feedback happily regresses the thing you
   * agreed two rounds ago, which is indistinguishable from the agent ignoring
   * you.
   */
  revisionRequests?: BlueprintRevisionRequest[]
  /**
   * Tier-scaled char budget for the formatted artifacts block. Set when the
   * phase's model context window was known at assembly time
   * (`assemblePhaseContext(…, contextWindowTokens)`); absent → the prompt
   * loader's static default (ARTIFACT_BUDGET_CHARS).
   */
  artifactBudgetChars?: number
  /**
   * Context-window tier the assembler resolved for this phase's model. Set
   * alongside `artifactBudgetChars`; absent → the prompt loader treats the
   * phase as `medium`, which equals the historical static caps.
   *
   * Kept as the tier rather than another char budget because more than one
   * block scales with it (constitution, workspace docs).
   *
   * Spelled out rather than imported: this is `ContextWindowTier` from
   * `main/services/context-management`, and shared/ must not import from main/.
   */
  contextTier?: 'small' | 'medium' | 'large'
  /** Structured retry context — populated only when retrying a failed phase */
  retryContext?: {
    attempt: number
    previousError: string
    previousPhase: string
    filesModified: string[]
    filesCreated: string[]
    tasksCompleted: number
    totalTasks: number
  }
}

/**
 * One human "change this" on a blueprint plan.
 *
 * Lives on `blueprints.settingsJson`, deliberately NOT on
 * `blueprint_phases.contextSnapshot`: rewindToPhase() nulls every snapshot from
 * the target phase forward, so a snapshot-stored request would be erased by the
 * very rewind it is meant to survive.
 */
export interface BlueprintRevisionRequest {
  /** 1-based round number — how many times the human has asked for changes. */
  round: number
  /** ISO timestamp of the request. */
  at: string
  /** The phase whose output was being judged when the request was made. */
  phase: BlueprintPhaseType
  /** Verbatim human text. Never summarised — the wording is the requirement. */
  feedback: string
  /** How it was handled: an in-place plan revision, or a full rewind to PLAN. */
  disposition: 'revised' | 'rewound'
  /**
   * True when the text was longer than the per-request cap and was cut.
   * Surfaced at the gate: silently truncating a requirement and then acting on
   * the remainder is the same failure as dropping it, only harder to notice.
   */
  truncated?: boolean
}

/** Result of one plan-revision turn at the approval gate. */
export interface BlueprintPlanRevision {
  /** One or two sentences: what changed and why. */
  summary: string
  /** One bullet per concrete change. */
  changes: string[]
  /** Agent pushback — why a request may be mistaken or infeasible. Empty when none. */
  concerns: string[]
  /** The COMPLETE revised plan, not a diff. Absent/empty ⇒ the turn is rejected. */
  planMarkdown: string
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
  /** Build-phase task ID — routes progress into the correct per-task lane. */
  taskId?: string
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
  /** True when verify found gaps and a remediation build round is starting. */
  remediationTriggered?: boolean
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
  /**
   * The revised plan, when this gate was re-raised by a revision turn.
   * Never folded into `reviewMarkdown`: a plan shown as a review report claims
   * a review that has not happened yet.
   */
  revisedPlanMarkdown?: string
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

/**
 * Deterministic gate verdict for one task attempt, streamed to the UI.
 *
 * Emitted on every attempt rather than only the last: watching a task fail the
 * write-set gate and then pass on retry is the signal that tells a user their
 * builder model is too weak, and only the last report would hide it.
 */
export interface BlueprintTaskGatesPayload {
  blueprintId: string
  workspaceId: string
  taskId: string
  report: GateReport
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
  'code-review',
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
  'code-review': 'codeReviewing',
  verify: 'verifying'
}
