/**
 * Service Runner Registry — maps E2EServiceRunnerKey → runner function.
 *
 * Imported ONLY by e2e-runner.service.ts. Scenarios reference runners by string
 * key so scenario-catalog.ts stays dependency-light (runs in tsx without Electron).
 */

import type { E2ETranscriptEntry, E2EServiceRunnerKey } from '../../../../shared/types'
import type { StreamPromptOptions } from '../stream-helper'
import { streamPrompt } from '../stream-helper'

// ── Service Runner Context ──

export interface E2EServiceContext {
  workspaceId: string
  workspacePath: string
  modelId: string
  conversationId: string
  signal: AbortSignal
  /** Chat helper — service runners can mix service calls + chat turns */
  streamPrompt: (text: string, opts?: Partial<StreamPromptOptions>) => Promise<E2ETranscriptEntry[]>
}

/** A service runner returns transcript entries (status/text) compatible with assertion framework */
export type E2EServiceRunner = (ctx: E2EServiceContext) => Promise<E2ETranscriptEntry[]>

// ── Runner Imports (lazy to avoid pulling heavy service deps at module level) ──

import { runBlueprintCreate } from './blueprint.runner'
import { runBlueprintPhaseManagement } from './blueprint.runner'
import { runBlueprintProgressTracking } from './blueprint.runner'
import { runBlueprintTaskExecution } from './blueprint.runner'
import { runBlueprintClarifyLive } from './blueprint.runner'
import {
  runMpaPreflight,
  runMpaGoalConditions,
  runMpaOrchestration,
  runMpaCancellation,
  runMpaCampaignSequential,
  runMpaCampaignPauseRetry,
  runMpaCampaignSkip,
  runMpaCampaignReconcile
} from './mpa.runner'
import {
  runRepoDiffDetection,
  runRepoCommit,
  runRepoCommitMessage,
  runBtwQuestion,
  runInsightsTokens,
  runDocsMermaid
} from './workspace-ops.runner'
import { runCodeGraphIndex, runEmbeddingGeneration, runSemanticSearch } from './code-intel.runner'
import {
  runGrillEvaluate,
  runGrillMultiTrack,
  runGrillIteration,
  runGrillCondenseRequirement,
  runGrillGeneratePlan
} from './grill.runner'
import { runAuditStartRun, runAuditFindings, runAuditCoverage } from './audit.runner'
import {
  runCouncilStartSession,
  runCouncilAdvisorOpinions,
  runCouncilSynthesis,
  runCouncilStructuredOutput
} from './council.runner'
import {
  runMemoryTiers,
  runMemoryDedupExact,
  runMemoryDedupNear,
  runMemoryAmbiguous,
  runMemoryIsolation,
  runMemoryScopeBoost,
  runMemorySessionDedupe
} from './memory.runner'
import {
  runCheckpointCapture,
  runCheckpointRestore,
  runCheckpointRewind,
  runCheckpointUntracked
} from './checkpoint.runner'
import {
  runChatEdgeConcurrent,
  runChatEdgeRapidCancel,
  runChatEdgeCompactRace
} from './chat-edge.runner'
import { runIdeaCrud, runIdeaStartGrill, runIdeaConvert, runIdeaToBlueprint } from './idea.runner'
import {
  runSpecialistCrud,
  runSpecialistSkills,
  runSpecialistDispatch,
  runSpecialistOverride
} from './specialist.runner'

// ── Registry ──

export const SERVICE_RUNNERS: Record<E2EServiceRunnerKey, E2EServiceRunner> = {
  // Wave 2 — Deterministic
  'blueprint-create': runBlueprintCreate,
  'blueprint-phase-management': runBlueprintPhaseManagement,
  'blueprint-progress-tracking': runBlueprintProgressTracking,
  'blueprint-task-execution': runBlueprintTaskExecution,
  'blueprint-clarify-live': runBlueprintClarifyLive,
  'mpa-preflight': runMpaPreflight,
  'mpa-goal-conditions': runMpaGoalConditions,
  'code-intel-code-graph-index': runCodeGraphIndex,
  'code-intel-embedding-generation': runEmbeddingGeneration,

  // Wave 3 — LLM
  'grill-evaluate': runGrillEvaluate,
  'grill-multi-track': runGrillMultiTrack,
  'grill-iteration': runGrillIteration,
  'audit-start-run': runAuditStartRun,
  'audit-findings': runAuditFindings,
  'audit-coverage': runAuditCoverage,
  'mpa-orchestration': runMpaOrchestration,
  'mpa-cancellation': runMpaCancellation,
  'code-intel-semantic-search': runSemanticSearch,

  // Wave 4 — Heavy
  'council-start-session': runCouncilStartSession,
  'council-advisor-opinions': runCouncilAdvisorOpinions,
  'council-synthesis': runCouncilSynthesis,
  'council-structured-output': runCouncilStructuredOutput,
  'grill-condense-requirement': runGrillCondenseRequirement,
  'grill-generate-plan': runGrillGeneratePlan,
  'memory-tiers': runMemoryTiers,

  // Wave B — Chat edge concurrency
  'chat-edge-concurrent': runChatEdgeConcurrent,
  'chat-edge-rapid-cancel': runChatEdgeRapidCancel,
  'chat-edge-compact-race': runChatEdgeCompactRace,

  // Wave C — Checkpoints
  'checkpoint-capture': runCheckpointCapture,
  'checkpoint-restore': runCheckpointRestore,
  'checkpoint-rewind': runCheckpointRewind,
  'checkpoint-untracked': runCheckpointUntracked,

  // Wave C — Ideas
  'idea-crud': runIdeaCrud,
  'idea-start-grill': runIdeaStartGrill,
  'idea-convert': runIdeaConvert,
  'idea-to-blueprint': runIdeaToBlueprint,

  // Wave C — Specialists
  'specialist-crud': runSpecialistCrud,
  'specialist-skills': runSpecialistSkills,
  'specialist-dispatch': runSpecialistDispatch,
  'specialist-override': runSpecialistOverride,

  // Wave E — Campaign runners
  'mpa-campaign-sequential': runMpaCampaignSequential,
  'mpa-campaign-pause-retry': runMpaCampaignPauseRetry,
  'mpa-campaign-skip': runMpaCampaignSkip,
  'mpa-campaign-reconcile': runMpaCampaignReconcile,

  // Wave E — Workspace ops
  'repo-diff-detection': runRepoDiffDetection,
  'repo-commit': runRepoCommit,
  'repo-commit-message': runRepoCommitMessage,
  'btw-question': runBtwQuestion,
  'insights-tokens': runInsightsTokens,
  'docs-mermaid': runDocsMermaid,

  // Wave D — Memory edge cases
  'memory-dedup-exact': runMemoryDedupExact,
  'memory-dedup-near': runMemoryDedupNear,
  'memory-ambiguous': runMemoryAmbiguous,
  'memory-isolation': runMemoryIsolation,
  'memory-scope-boost': runMemoryScopeBoost,
  'memory-session-dedupe': runMemorySessionDedupe
}

/**
 * Helper to create the streamPrompt function bound to a specific conversation.
 * Service runners call ctx.streamPrompt(text) for hybrid scenarios.
 */
export function createStreamPromptHelper(
  conversationId: string,
  timeoutMs: number
): (text: string, opts?: Partial<StreamPromptOptions>) => Promise<E2ETranscriptEntry[]> {
  return (text: string, opts?: Partial<StreamPromptOptions>) =>
    streamPrompt({
      conversationId,
      text,
      timeoutMs,
      ...opts
    })
}
