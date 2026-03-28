export { AgentBaseService, summarizeToolInput } from './agent-base.service'
export type { StreamChunk } from './agent-base.service'
export { GeneralistService, generalistService } from './generalist.service'
export type { GrillCompleteEvent } from './generalist.service'
export { OrchestratorService, orchestratorService } from './orchestrator.service'
export { FileService, fileService } from './file.service'
export { SkillService, skillService } from './skill.service'

// Prompt assembly — centralized in PromptBuilder
export { PromptBuilder, promptBuilder } from './prompt-builder'
export type { PromptBuildOptions, PromptRole } from './prompt-builder'

// Backward-compatible re-exports of prompt constants (from prompt-builder)
export {
  PLAN_MODE_SYSTEM_PROMPT,
  BUILD_MODE_SYSTEM_PROMPT,
  DECOMPOSITION_SYSTEM_PROMPT,
  SPECIALIST_TASK_SYSTEM_PROMPT
} from './prompt-builder'

// Agent registry — YAML single source of truth
export { AgentRegistry, agentRegistry } from './agent-registry'
export type { AgentDefinition } from './agent-registry'

export { SpecialistPoolService, specialistPoolService } from './specialist-pool.service'
export { GitWorktreeService, gitWorktreeService } from './git-worktree.service'
export type { MergeResult, MergeAllResult } from './git-worktree.service'

export { WorkspaceDeployService, workspaceDeployService } from './workspace-deploy.service'
export { memoryService } from './memory.service'
export { memoryFeedService } from './memory-feed.service'
export { dreamService } from './dream.service'
export { idleService } from './idle.service'
export {
  validateComplexityScore,
  getTierFromScore,
  resolveModel,
  getModelId,
  enrichTasksWithComplexity
} from './complexity-scorer.service'
export { GitHubService, githubService } from './github.service'
export { RepoService, repoService } from './repo.service'

// Audit & observability services (DevTeam practice alignment)
export { hookRunnerService } from './hook-runner.service'
export { eventLoggerService } from './event-logger.service'
export { costTrackerService, estimateCostCents, estimateCostFromTotal, MODEL_PRICING } from './cost-tracker.service'
export type { CostSummary, BudgetStatus } from './cost-tracker.service'
export { checkpointService } from './checkpoint.service'
export type { CheckpointState } from './checkpoint.service'
export { detectAbandonment, detectQualityGates } from './abandonment-detector.service'
export type { AbandonmentResult, QualityGateResult } from './abandonment-detector.service'
