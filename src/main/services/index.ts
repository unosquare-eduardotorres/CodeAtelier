export { AgentBaseService, summarizeToolInput } from './agent-base.service'
export type { StreamChunk } from './agent-base.service'
export { GeneralistService, generalistService } from './generalist.service'
export { FileService, fileService } from './file.service'
export { SkillService, skillService } from './skill.service'

// Prompt assembly — centralized in PromptBuilder
export { PromptBuilder, promptBuilder } from './prompt-builder'

export { SpecialistPoolService, specialistPoolService } from './specialist-pool.service'
export { GitWorktreeService, gitWorktreeService } from './git-worktree.service'

export { WorkspaceDeployService, workspaceDeployService } from './workspace-deploy.service'
export { memoryService } from './memory.service'
export { memoryFeedService } from './memory-feed.service'
export { dreamService } from './dream.service'
export { idleService } from './idle.service'
export {
  validateComplexityScore,
  getTierFromScore,
  resolveModel,
  enrichTasksWithComplexity
} from './complexity-scorer.service'
export { GitHubService, githubService } from './github.service'
export { RepoService, repoService } from './repo.service'

// Audit & observability services (DevTeam practice alignment)
export { eventLoggerService } from './event-logger.service'
export {
  costTrackerService,
  estimateCostCents,
  estimateCostFromTotal
} from './cost-tracker.service'
export { checkpointService } from './checkpoint.service'
export { detectAbandonment, detectQualityGates } from './abandonment-detector.service'

// Auth & SDK abstractions
export { authProvider } from './auth-provider'
export type { AuthProvider } from './auth-provider'
export { sdkExecutor, SDKExecutor } from './sdk-executor'

// Task pipeline — consolidated prepare/execute for handoff, plan execution, investigation fix
export { taskPipeline, initTaskPipeline, TaskPipelineService } from './task-pipeline.service'
export type {
  HandoffPrepare,
  InvestigationFixPrepare,
  PrepareOptions,
  ExecuteOptions
} from './task-pipeline.service'
// Generalist streaming lifecycle — owns stream/stop/compact + event forwarding
export {
  generalistStreamService,
  initGeneralistStream,
  GeneralistStreamService
} from './generalist-stream.service'
export type { PipelineCallbacks } from './generalist-stream.service'

// Intent detection + routing — replaces scattered detect*() methods and EventEmitter forwarders
export { IntentDetector, intentDetector } from './intent-detector'
export { IntentRouter } from './intent-router'

// Extracted generalist sub-services (Phase 5-9 decomposition)
export { GeneralistTokenTracker } from './generalist-token-tracker'
export type { TurnBreakdownEntry, CacheEfficiencyReport } from './generalist-token-tracker'
export { GeneralistCircuitBreaker } from './generalist-circuit-breaker'
export { GeneralistMcpConfig } from './generalist-mcp-config'
export type { McpFeatureFlags, McpConfigResult } from './generalist-mcp-config'
export { DecompositionService, decompositionService } from './decomposition.service'
