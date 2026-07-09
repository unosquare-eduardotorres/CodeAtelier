export { AgentBaseService } from './agent-base.service'
export { summarizeToolInput } from './tool-input-summarizer'
export type { StreamChunk } from './agent-base.service'
export { ChatAgentService, chatAgentService } from './chat-agent.service'
export { FileService, fileService } from './file.service'
export { SkillService, skillService } from './skill.service'

// Prompt assembly — centralized in PromptBuilder
export { PromptBuilder, promptBuilder } from './prompt-builder'

export { WorkspaceDeployService, workspaceDeployService } from './workspace-deploy.service'
// Memory engine services (Phase 1-4 replacement)
export { memoryEngineService } from './memory-engine.service'
export { memoryRetrievalService } from './memory-retrieval.service'
export { memoryExtractionService } from './memory-extraction.service'
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

// Auth abstractions
export { authProvider } from './auth-provider'
export type { AuthProvider } from './auth-provider'

// Chat streaming lifecycle — owns stream/stop/compact + event forwarding
export { chatStreamService, initChatStream, ChatStreamService } from './chat-stream.service'
export type { PipelineCallbacks } from './chat-stream.service'

// Intent detection + routing — replaces scattered detect*() methods and EventEmitter forwarders
export { IntentDetector, intentDetector } from './intent-detector'
export { IntentRouter } from './intent-router'

// Extracted generalist sub-services (Phase 5-9 decomposition)
export { AgentTokenTracker } from './agent-token-tracker'
export type { TurnBreakdownEntry, CacheEfficiencyReport } from './agent-token-tracker'
export { AgentCircuitBreaker } from './agent-circuit-breaker'
export { buildWorkspaceMcpConfig } from './workspace-mcp-config'
export type { McpFeatureFlags, McpConfigResult } from './workspace-mcp-config'

// Multi-workspace session event routing
export {
  SessionEventRouter,
  initSessionEventRouter,
  getSessionEventRouter
} from './session-event-router'
