import type {
  AgentRole,
  GrillTrackId,
  GrillTrack,
  AuditTrackId,
  AuditTrack,
  ModelAction
} from './types'

export const IPC_CHANNELS = {
  // Workspace
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_OPEN: 'workspace:open',
  WORKSPACE_DELETE: 'workspace:delete',
  WORKSPACE_GET_SETTINGS: 'workspace:get-settings',
  WORKSPACE_UPDATE_SETTINGS: 'workspace:update-settings',
  WORKSPACE_UPDATE_AUTH: 'workspace:update-auth',

  // Chat
  CHAT_SEND: 'chat:sendMessage',
  CHAT_GET_CONVERSATIONS: 'chat:getConversations',
  CHAT_CREATE_CONVERSATION: 'chat:createConversation',
  CHAT_GET_MESSAGES: 'chat:getMessages',
  CHAT_MESSAGE_CHUNK: 'chat:messageChunk',
  CHAT_MESSAGE_COMPLETE: 'chat:messageComplete',
  CHAT_DELETE_CONVERSATION: 'chat:deleteConversation',
  CHAT_UPDATE_MODE: 'chat:updateMode',
  CHAT_UPDATE_PERSONA: 'chat:updatePersona',
  CHAT_RENAME: 'chat:renameConversation',
  CHAT_STOP: 'chat:stop',
  CHAT_COMPACT: 'chat:compact',
  /** Swap DaVinci out for the workspace's ready Project Specialist — triggered by user accepting the swap proposal */
  CHAT_SWAP_TO_SPECIALIST: 'chat:swapToSpecialist',
  CHAT_GRILL_COMPLETE: 'chat:grillComplete',
  CHAT_GRILL_QUESTION: 'chat:grillQuestion',
  CHAT_GRILL_EVALUATION: 'chat:grillEvaluation',
  CHAT_ASK_QUESTION: 'chat:askQuestion',
  CHAT_PLAN: 'chat:plan',
  CHAT_COMPLETE: 'chat:complete',
  CHAT_CLOSE: 'chat:close',
  CHAT_GET_FILE_CHANGES: 'chat:getFileChanges',
  CHAT_SWITCH_BRANCH: 'chat:switchBranch',
  /** Session recovery: stale session auto-heal progress events */
  CHAT_SESSION_RECOVERY: 'chat:sessionRecovery',
  /** State machine transitions — renderer mirrors backend conversation state */
  CHAT_STATE_CHANGE: 'chat:stateChange',

  // Agents
  AGENT_GET_STATUSES: 'agent:getStatuses',
  AGENT_STATUS_UPDATE: 'agent:statusUpdate',
  AGENT_STOP_ALL: 'agent:stopAll',
  /** Strategy M: Cache efficiency metrics for dashboard */
  AGENT_CACHE_EFFICIENCY: 'agent:cacheEfficiency',

  // Agent lifecycle
  AGENT_START: 'agent:start',
  AGENT_READY: 'agent:ready',

  // Dialog
  DIALOG_SELECT_DIRECTORY: 'dialog:selectDirectory',
  SAVE_CLIPBOARD_IMAGE: 'dialog:saveClipboardImage',
  READ_IMAGE_BASE64: 'dialog:readImageBase64',

  // Specialists
  SPECIALIST_LIST: 'specialist:list',
  SPECIALIST_GET: 'specialist:get',
  SPECIALIST_CREATE: 'specialist:create',
  SPECIALIST_UPDATE: 'specialist:update',
  SPECIALIST_DELETE: 'specialist:delete',
  SPECIALIST_ASSIGN_SKILL: 'specialist:assignSkill',
  SPECIALIST_REMOVE_SKILL: 'specialist:removeSkill',
  SPECIALIST_REORDER: 'specialist:reorder',

  // Conversation Specialist Activation (with skill gating) — single row per conversation post-migration 66
  CONV_SPECIALIST_LIST: 'convSpecialist:list',
  CONV_SPECIALIST_UPSERT: 'convSpecialist:upsert',
  CONV_SPECIALIST_REMOVE: 'convSpecialist:remove',
  CONV_SPECIALIST_RESET: 'convSpecialist:reset',
  CONV_SPECIALIST_ESTIMATE: 'convSpecialist:estimate',

  // App Preferences
  APP_PREFERENCE_GET_ALL: 'appPreference:getAll',
  APP_PREFERENCE_SET: 'appPreference:set',

  // Project Specialist (Phase 2 of the Project Specialist refactor)
  PROJECT_SPECIALIST_GET: 'project-specialist:get',
  PROJECT_SPECIALIST_BUILD: 'project-specialist:build',
  PROJECT_SPECIALIST_REBUILD_PROMPT: 'project-specialist:rebuild-prompt',
  PROJECT_SPECIALIST_REBUILD_SKILLS: 'project-specialist:rebuild-skills',
  PROJECT_SPECIALIST_UPDATE_PROMPT: 'project-specialist:update-prompt',
  PROJECT_SPECIALIST_TOGGLE_SKILL: 'project-specialist:toggle-skill',
  PROJECT_SPECIALIST_ATTACH_SKILL: 'project-specialist:attach-skill',
  PROJECT_SPECIALIST_DETACH_SKILL: 'project-specialist:detach-skill',
  PROJECT_SPECIALIST_GET_DRIFT: 'project-specialist:get-drift',
  PROJECT_SPECIALIST_BUILD_PROGRESS: 'project-specialist:build-progress',
  PROJECT_SPECIALIST_REFRESH_RECOMMENDATIONS: 'project-specialist:refresh-recommendations',

  // Skills
  SKILL_LIST: 'skill:list',
  SKILL_GET: 'skill:get',
  SKILL_IMPORT: 'skill:import',
  SKILL_UPDATE: 'skill:update',
  SKILL_DELETE: 'skill:delete',
  SKILL_ACTIVATE: 'skill:activate',
  SKILL_DEACTIVATE: 'skill:deactivate',
  SKILL_SELECT_FILE: 'skill:selectFile',

  // Workspace Agents/Skills deployment
  WORKSPACE_SCAN_CLAUDE: 'workspace:scanClaude',
  WORKSPACE_ACTIVATE_AGENTS: 'workspace:activateAgents',
  WORKSPACE_READ_FILE: 'workspace:readFile',
  WORKSPACE_WRITE_FILE: 'workspace:writeFile',
  WORKSPACE_SCAN_SKILLS: 'workspace:scanSkills',
  WORKSPACE_SCAN_AGENTS: 'workspace:scanAgents',
  WORKSPACE_CONFIRM_CLAUDE_MD: 'workspace:confirmClaudeMd',
  WORKSPACE_ACTIVATION_PROGRESS: 'workspace:activationProgress',
  WORKSPACE_CANCEL_ACTIVATION: 'workspace:cancelActivation',
  WORKSPACE_CLEAN_ACTIVATION: 'workspace:cleanActivation',

  // Agent/Skill individual delete & sync
  AGENT_DELETE_FROM_WORKSPACE: 'agent:deleteFromWorkspace',
  AGENT_SYNC_TO_WORKSPACE: 'agent:syncToWorkspace',
  SKILL_DELETE_FROM_WORKSPACE: 'skill:deleteFromWorkspace',
  SKILL_SYNC_TO_WORKSPACE: 'skill:syncToWorkspace',

  // Agent activate/deactivate
  AGENT_ACTIVATE: 'agent:activate',
  AGENT_DEACTIVATE: 'agent:deactivate',

  // Bulk delete all agents/skills
  DELETE_ALL_AGENTS: 'workspace:deleteAllAgents',
  DELETE_ALL_SKILLS: 'workspace:deleteAllSkills',

  // Deploy all (inactive) to workspace
  WORKSPACE_DEPLOY_ALL: 'workspace:deployAll',

  // Agent Task Chunks (for Agent Monitor live output)
  AGENT_TASK_CHUNK: 'agent:taskChunk',

  // Agent Sync
  SYNC_COMPUTE_DIFF: 'sync:computeDiff',
  SYNC_APPLY: 'sync:apply',

  // Memory (auto memory system)
  MEMORY_LIST: 'memory:list',
  MEMORY_SEARCH: 'memory:search',
  MEMORY_CREATE: 'memory:create',
  MEMORY_UPDATE: 'memory:update',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_UPDATE_SETTING: 'memory:updateSetting',

  // Memory feed (ingest sources into memories)
  MEMORY_FEED_DOCUMENT: 'memory:feedDocument',
  MEMORY_FEED_PROGRESS: 'memory:feedProgress',
  MEMORY_FEED_CANCEL: 'memory:feedCancel',
  MEMORY_SELECT_DOCUMENT: 'memory:selectDocument',
  MEMORY_GET_FEED_TIMESTAMPS: 'memory:getFeedTimestamps',
  MEMORY_REGENERATE_CLAUDE_MD: 'memory:regenerateClaudeMd',

  // Tokens
  TOKEN_GET_WORKSPACE_SUMMARY: 'token:getWorkspaceSummary',
  TOKEN_GET_CONVERSATION_SUMMARY: 'token:getConversationSummary',
  TOKEN_GET_RECENT_SESSIONS: 'token:getRecentSessions',

  // Agent retry events
  AGENT_TASK_RETRY: 'agent:taskRetry',

  // Ideas
  IDEA_LIST: 'idea:list',
  IDEA_CREATE: 'idea:create',
  IDEA_UPDATE: 'idea:update',
  IDEA_DELETE: 'idea:delete',
  IDEA_START_GRILL: 'idea:startGrill',
  IDEA_CONVERT_DIRECT: 'idea:convertDirect',
  IDEA_COMPLETE_FROM_GRILL: 'idea:completeFromGrill',
  IDEA_SAVE_GRILL_DECISIONS: 'idea:saveGrillDecisions',

  // Documents
  DOCS_LIST: 'docs:list',
  DOCS_READ_FILE: 'docs:readFile',
  DOCS_RENDER_MERMAID: 'docs:renderMermaid',

  // Auto-update
  UPDATE_CHECK: 'update:check',
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_NOT_AVAILABLE: 'update:notAvailable',
  UPDATE_DOWNLOADED: 'update:downloaded',
  UPDATE_ERROR: 'update:error',
  UPDATE_PROGRESS: 'update:progress',
  UPDATE_INSTALL: 'update:install',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_GET_CONFIG: 'update:getConfig',
  UPDATE_SET_CONFIG: 'update:setConfig',

  // GitHub Integration
  GITHUB_SAVE_TOKEN: 'github:saveToken',
  GITHUB_VALIDATE_TOKEN: 'github:validateToken',
  GITHUB_GET_STATUS: 'github:getStatus',
  GITHUB_REMOVE_TOKEN: 'github:removeToken',

  // Repository Management
  REPO_INIT: 'repo:init',
  REPO_SET_REMOTE: 'repo:setRemote',
  REPO_GET_INFO: 'repo:getInfo',
  // Code Changes
  REPO_GET_FILE_DETAILS: 'repo:getFileDetails',
  REPO_GET_FILE_DIFF: 'repo:getFileDiff',
  REPO_COMMIT_FILES: 'repo:commitFiles',
  REPO_PUSH: 'repo:push',
  REPO_GET_PUSH_STATUS: 'repo:getPushStatus',
  REPO_GENERATE_COMMIT_MESSAGE: 'repo:generateCommitMessage',
  REPO_CREATE_PR: 'repo:createPr',

  // PR Description Generation
  CHAT_GENERATE_PR_DESCRIPTION: 'chat:generatePrDescription',

  // User Profile
  USER_PROFILE_GET: 'user:getProfile',
  USER_PROFILE_UPSERT: 'user:upsertProfile',

  // Core Agent Aliases
  CORE_AGENT_LIST: 'coreAgent:list',
  CORE_AGENT_UPSERT: 'coreAgent:upsert',

  // Renderer logging bridge
  LOG_FROM_RENDERER: 'log:fromRenderer',

  // Zoom
  ZOOM_IN: 'zoom:in',
  ZOOM_OUT: 'zoom:out',
  ZOOM_RESET: 'zoom:reset',
  ZOOM_SET: 'zoom:set',
  ZOOM_GET: 'zoom:get',
  ZOOM_CHANGED: 'zoom:changed',

  // Shell
  SHELL_SHOW_ITEM_IN_FOLDER: 'shell:showItemInFolder',

  // Checkpoints
  CHECKPOINT_LIST: 'checkpoint:list',
  CHECKPOINT_RESTORE: 'checkpoint:restore',
  CHECKPOINT_APPROVAL_REQUEST: 'checkpoint:approvalRequest',
  CHECKPOINT_APPROVAL_RESPONSE: 'checkpoint:approvalResponse',

  // Hooks
  HOOKS_LIST: 'hooks:list',
  HOOKS_RELOAD: 'hooks:reload',

  // Cost tracking
  COST_GET_WORKSPACE_SUMMARY: 'cost:getWorkspaceSummary',
  COST_GET_CONVERSATION: 'cost:getConversation',
  COST_GET_WORKSPACE_CONVERSATIONS: 'cost:getWorkspaceConversations',
  COST_CHECK_BUDGET: 'cost:checkBudget',
  COST_BUDGET_WARNING: 'cost:budgetWarning',
  COST_BUDGET_EXCEEDED: 'cost:budgetExceeded',

  // Events (audit log)
  EVENTS_GET_RECENT: 'events:getRecent',
  EVENTS_GET_BY_CONVERSATION: 'events:getByConversation',

  // Agent events (new from audit)
  AGENT_ABANDONMENT_DETECTED: 'agent:abandonmentDetected',

  // Core Agent Prompts
  CORE_AGENT_PROMPT_LIST: 'coreAgentPrompt:list',
  CORE_AGENT_PROMPT_GET: 'coreAgentPrompt:get',
  CORE_AGENT_PROMPT_UPSERT: 'coreAgentPrompt:upsert',
  CORE_AGENT_PROMPT_RESET: 'coreAgentPrompt:reset',

  // AI Subscriptions
  SUBSCRIPTION_VALIDATE_ALL: 'subscription:validateAll',
  SUBSCRIPTION_CHECK_CLAUDE_CLI: 'subscription:checkClaudeCli',
  SUBSCRIPTION_AUTO_CONFIGURE: 'subscription:autoConfigure',

  // Embedding provider (replaces Ollama for semantic search)
  EMBEDDING_CHECK_STATUS: 'embedding:checkStatus',
  EMBEDDING_INITIALIZE: 'embedding:initialize',
  EMBEDDING_MODEL_PROGRESS: 'embedding:modelProgress',
  EMBEDDING_MODEL_READY: 'embedding:modelReady',
  EMBEDDING_MODEL_ERROR: 'embedding:modelError',

  // Ollama — @deprecated for semantic search (still used by Local LLM chat backend)
  OLLAMA_CHECK_STATUS: 'ollama:checkStatus',
  OLLAMA_PULL_MODEL: 'ollama:pullModel',
  OLLAMA_CANCEL_PULL: 'ollama:cancelPull',
  OLLAMA_REMOVE_MODEL: 'ollama:removeModel',
  OLLAMA_START: 'ollama:start',
  OLLAMA_PULL_PROGRESS: 'ollama:pullProgress',
  OLLAMA_PULL_COMPLETE: 'ollama:pullComplete',
  OLLAMA_PULL_ERROR: 'ollama:pullError',

  // Indexing (semantic search)
  INDEXING_START: 'indexing:start',
  INDEXING_PAUSE: 'indexing:pause',
  INDEXING_RESUME: 'indexing:resume',
  INDEXING_CANCEL: 'indexing:cancel',
  INDEXING_PROGRESS: 'indexing:progress',
  INDEXING_GET_STATUS: 'indexing:getStatus',
  INDEXING_LOAD_PERSISTED: 'indexing:loadPersisted',

  // Semantic Search query
  SEMANTIC_SEARCH_QUERY: 'semanticSearch:query',

  // Code Graph (persisted repomap)
  CODE_GRAPH_INDEX_START: 'codeGraph:indexStart',
  CODE_GRAPH_GET_STATUS: 'codeGraph:getStatus',
  CODE_GRAPH_HAS_INDEX: 'codeGraph:hasIndex',
  CODE_GRAPH_PROGRESS: 'codeGraph:progress',

  // Conversation reordering
  CONVERSATION_REORDER: 'conversation:reorder',

  // Context usage
  CONVERSATION_GET_CONTEXT_USAGE: 'conversation:getContextUsage',

  // SDK Events — new message types from Agent SDK
  SDK_RATE_LIMIT: 'sdk:rateLimit',
  SDK_API_RETRY: 'sdk:apiRetry',
  SDK_PROMPT_SUGGESTION: 'sdk:promptSuggestion',
  SDK_FILES_PERSISTED: 'sdk:filesPersisted',
  SDK_HOOK_LIFECYCLE: 'sdk:hookLifecycle',
  SDK_SESSION_STATE: 'sdk:sessionState',
  SDK_AUTH_STATUS: 'sdk:authStatus',

  // Elicitation — MCP server user input requests
  ELICITATION_REQUEST: 'elicitation:request',
  ELICITATION_RESPONSE: 'elicitation:response',

  // SDK Control — Query instance methods
  SDK_STOP_TASK: 'sdk:stopTask',
  SDK_SUPPORTED_MODELS: 'sdk:supportedModels',

  // SDK Subagent inspection (0.2.96+)
  SDK_LIST_SUBAGENTS: 'sdk:listSubagents',
  SDK_GET_SUBAGENT_MESSAGES: 'sdk:getSubagentMessages',

  // SDK Session — session mutation methods
  SDK_FORK_SESSION: 'sdk:forkSession',

  // SDK Diagnostics (0.2.138+) — @alpha
  SDK_RESOLVE_SETTINGS: 'sdk:resolveSettings',

  // SDK Elicitation (enriched — via elicitation.service)
  SDK_ELICITATION_REQUEST: 'sdk:elicitationRequest',
  SDK_ELICITATION_RESPONSE: 'sdk:elicitationResponse',

  // Session Management (SDK top-level functions)
  SESSION_LIST: 'session:list',
  SESSION_GET_INFO: 'session:getInfo',
  SESSION_GET_MESSAGES: 'session:getMessages',
  SESSION_RENAME: 'session:rename',
  SESSION_TAG: 'session:tag',
  SESSION_FORK: 'session:fork',

  // Chat resume at checkpoint
  CHAT_RESUME_AT: 'chat:resumeAt',

  // Bug Tracker
  BUG_REPORT: 'bug:report',
  BUG_LIST: 'bug:list',
  BUG_GET: 'bug:get',
  BUG_RESOLVE: 'bug:resolve',
  BUG_UNRESOLVE: 'bug:unresolve',
  BUG_DELETE: 'bug:delete',
  BUG_UPDATE_NOTE: 'bug:updateNote',
  BUG_COUNT: 'bug:count',
  BUG_NEW: 'bug:new',

  // oMLX
  OMLX_CHECK_STATUS: 'omlx:checkStatus',
  OMLX_START: 'omlx:start',
  OMLX_ADMIN_URL: 'omlx:adminUrl',
  OMLX_LOAD_MODEL: 'omlx:loadModel',
  OMLX_UNLOAD_MODEL: 'omlx:unloadModel',

  // Platform
  PLATFORM_INFO: 'platform:info',

  // Audit (Workspace Health)
  AUDIT_START: 'audit:start',
  AUDIT_CANCEL: 'audit:cancel',
  AUDIT_GET_LATEST: 'audit:getLatest',
  AUDIT_PROGRESS: 'audit:progress',
  AUDIT_RESULT: 'audit:result',
  AUDIT_COMPLETE: 'audit:complete',
  AUDIT_STREAM_CHUNK: 'audit:stream-chunk',
  AUDIT_CONVERT_FINDINGS: 'audit:convertFindings',
  AUDIT_RERUN_TRACK: 'audit:rerunTrack',
  AUDIT_EXPORT_MARKDOWN: 'audit:exportMarkdown',
  AUDIT_RESUME: 'audit:resume',
  AUDIT_INTERMEDIATE: 'audit:intermediate',
  AUDIT_GET_HISTORY: 'audit:getHistory',

  // Grill (dedicated agent)
  GRILL_EVALUATE: 'grill:evaluate',
  GRILL_CANCEL: 'grill:cancel',
  GRILL_STREAM_CHUNK: 'grill:streamChunk',
  GRILL_EVALUATION_RESULT: 'grill:evaluationResult',
  GRILL_STREAM_COMPLETE: 'grill:streamComplete',
  GRILL_CONDENSE_REQUIREMENT: 'grill:condenseRequirement',
  GRILL_GET_STATUS: 'grill:getStatus',
  GRILL_GET_SESSION: 'grill:getSession',
  GRILL_SAVE_ANSWERS: 'grill:saveAnswers',
  GRILL_STATUS_CHANGED: 'grill:statusChanged',

  // Project Creation
  PROJECT_CREATE: 'project:create',

  // External MCP Integrations
  WORKSPACE_CHECK_EXTERNAL_MCP: 'workspace:check-external-mcp',
  CHAT_UPDATE_MCP_OVERRIDES: 'chat:update-mcp-overrides'
} as const

/** Model used for activation CLAUDE.md generation (structured output — Haiku-tier) */
export const ACTIVATION_MODEL_ID = 'claude-haiku-4-5-20251001' as const

/**
 * The well-known agent ID for the **Da Vinci** (default Specialist) agent.
 *
 * Layer 2 (migration 69) rewrote all persisted `'generalist'` values to
 * `'da-vinci'`; the constant now matches.
 */
export const DA_VINCI_AGENT_ID = 'da-vinci' as const

/** Default cost preference for new workspaces */
export const DEFAULT_COST_PREFERENCE = 'balanced' as const

/** Available Claude models for configuration UI */
export const AVAILABLE_MODELS = [
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    tier: 'haiku' as const,
    description: 'Fast & economical'
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    tier: 'sonnet' as const,
    description: 'Balanced performance'
  },
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    tier: 'opus' as const,
    description: 'Most capable'
  }
] as const

/** Default model for each configurable action */
export const DEFAULT_MODEL_CONFIG: Record<import('./types').ModelAction, string> = {
  'da-vinci': 'claude-opus-4-7',
  'da-vinci:plan': 'claude-opus-4-7',
  'da-vinci:build': 'claude-sonnet-4-6',
  'project-specialist': 'claude-opus-4-7',
  'project-specialist:plan': 'claude-opus-4-7',
  'project-specialist:build': 'claude-sonnet-4-6',
  'specialist:simple': 'claude-haiku-4-5-20251001',
  'specialist:moderate': 'claude-sonnet-4-6',
  'specialist:complex': 'claude-opus-4-7',
  memoryFeed: 'claude-haiku-4-5-20251001',
  activation: 'claude-haiku-4-5-20251001',
  haiku: 'claude-haiku-4-5-20251001'
} as const

/** Human-readable metadata for each model action — used in the Models config UI */
export const MODEL_ACTIONS_META: Record<
  import('./types').ModelAction,
  {
    label: string
    description: string
    icon: string
    section: 'agent' | 'specialist' | 'background'
  }
> = {
  'da-vinci': {
    label: 'Da Vinci',
    description: 'Default chat agent that handles conversations',
    icon: '💬',
    section: 'agent'
  },
  'da-vinci:plan': {
    label: 'Da Vinci (Plan Mode)',
    description: 'Model for thinking, planning, and general Q&A',
    icon: '🧠',
    section: 'agent'
  },
  'da-vinci:build': {
    label: 'Da Vinci (Build Mode)',
    description: 'Model for code writing and execution orchestration',
    icon: '🔨',
    section: 'agent'
  },
  'project-specialist': {
    label: 'Project Specialist',
    description: 'Per-workspace specialist tailored to the project\u2019s stack',
    icon: '🔧',
    section: 'agent'
  },
  'project-specialist:plan': {
    label: 'Project Specialist (Plan Mode)',
    description: 'Per-workspace specialist — planning & analysis',
    icon: '🧠',
    section: 'agent'
  },
  'project-specialist:build': {
    label: 'Project Specialist (Build Mode)',
    description: 'Per-workspace specialist — code writing & execution',
    icon: '🔨',
    section: 'agent'
  },
  'specialist:simple': {
    label: 'Simple Tasks',
    description: 'Quick fixes, docs, formatting (score 0–4)',
    icon: '⚡',
    section: 'specialist'
  },
  'specialist:moderate': {
    label: 'Moderate Tasks',
    description: 'Feature work, refactoring (score 5–8)',
    icon: '🔧',
    section: 'specialist'
  },
  'specialist:complex': {
    label: 'Complex Tasks',
    description: 'Architecture, multi-file, risky changes (score 9–14)',
    icon: '🧠',
    section: 'specialist'
  },
  memoryFeed: {
    label: 'Memory Feed',
    description: 'Summarization of CLAUDE.md and memory feeds',
    icon: '📝',
    section: 'background'
  },
  activation: {
    label: 'Workspace Activation',
    description: 'CLAUDE.md generation during agent activation',
    icon: '🚀',
    section: 'background'
  },
  haiku: {
    label: 'Haiku (Lightweight)',
    description: 'Fast, lightweight tasks like code descriptions',
    icon: '⚡',
    section: 'background'
  }
} as const

/**
 * MAX_THINKING_TOKENS budget per model tier.
 * Controls extended thinking depth: Opus gets full thinking, Sonnet moderate, Haiku light.
 * Haiku 4.5 supports extended thinking — small budget keeps it focused.
 * Set as env var on specialist `claude -p` processes to improve output quality.
 */
export const THINKING_BUDGETS = {
  haiku: '5000',
  sonnet: '10000',
  opus: '' // empty = adaptive-only (Opus 4.7 removed budget_tokens — 400 error if passed)
} as const

/**
 * Maps complexity tiers to SDK effort levels.
 * Controls how much reasoning Claude applies per task.
 */
export const COMPLEXITY_TO_EFFORT = {
  simple: 'low',
  moderate: 'medium',
  complex: 'xhigh' // Opus 4.7 recommends xhigh effort for complex coding tasks (SDK 0.2.120+)
} as const satisfies Record<string, 'low' | 'medium' | 'high' | 'xhigh' | 'max'>

/**
 * @deprecated Budget caps removed for Claude Max (subscription = flat rate).
 * Use workspace settings `budgetCapUsd` for opt-in caps.
 * Kept for backward compatibility — will be removed in next major.
 * SDK returns error_max_budget_usd when exceeded — clean exit, no crash.
 */
export const SPECIALIST_BUDGET_CAPS = {
  simple: 0.1,
  moderate: 0.5,
  complex: 2.0
} as const satisfies Record<string, number>

/**
 * @deprecated Budget caps removed for Claude Max (subscription = flat rate).
 * Use workspace settings `budgetCapUsd` for opt-in caps.
 * Kept for backward compatibility — will be removed in next major.
 */
export const CHAT_AGENT_BUDGET_CAP = 1.5

/**
 * Mode-aware budget cap multipliers for users who opt into custom caps.
 * Applied to the base `budgetCapUsd` from workspace settings.
 * e.g. base=2.0 → plan gets 2.0, build gets 2×2.0=4.0, audit gets 3×2.0=6.0
 */
export const BUDGET_CAP_MODE_MULTIPLIERS = {
  plan: 1.0,
  build: 2.0,
  audit: 3.0
} as const satisfies Record<string, number>

/**
 * Maps an `AgentRole` + mode into the canonical `ModelAction` key used by
 * `DEFAULT_MODEL_CONFIG` / `workspace.settings.modelOverrides`.
 *
 * Da Vinci historically uses `'generalist:*'` keys (stable DB contract); the
 * function centralizes that mapping so adapters can think in AgentRole terms
 * without knowing about the legacy labels. Project Specialists use the
 * `'project-specialist:*'` keys that were added for the Phase 2 refactor.
 */
export function getModelActionForRole(role: AgentRole, mode: 'plan' | 'build'): ModelAction {
  if (role === 'da-vinci') {
    return mode === 'build' ? 'da-vinci:build' : 'da-vinci:plan'
  }
  if (role === 'audit') {
    return 'da-vinci:plan' // Audits always use plan-tier model
  }
  return mode === 'build' ? 'project-specialist:build' : 'project-specialist:plan'
}

/** Maximum skill file size in bytes (500 KB) */
export const SKILL_MAX_FILE_SIZE_BYTES = 512000 as const // 500 * 1024

// ── Grill Tracks ──

export const GRILL_TRACKS: Record<GrillTrackId, GrillTrack> = {
  requirements: {
    id: 'requirements',
    name: 'Requirements',
    icon: 'ClipboardCheck',
    description: 'User stories, acceptance criteria, edge cases, and stakeholder clarity',
    scoringFocus: [
      'User stories completeness',
      'Acceptance criteria (Given/When/Then)',
      'Edge case coverage',
      'Stakeholder needs',
      'Scope clarity'
    ]
  },
  architecture: {
    id: 'architecture',
    name: 'Architecture',
    icon: 'Building2',
    description: 'Module decomposition, API/IPC design, scalability, and process boundaries',
    scoringFocus: [
      'Module boundaries',
      'API/IPC channel design',
      'Dependency management',
      'Scalability',
      'Error propagation'
    ]
  },
  'ux-ui': {
    id: 'ux-ui',
    name: 'UX/UI',
    icon: 'Palette',
    description: 'User flows, accessibility, responsiveness, and interaction patterns',
    scoringFocus: [
      'User flow completeness',
      'Accessibility (WCAG)',
      'Responsive layout',
      'Error states UX',
      'Loading/empty states'
    ]
  },
  security: {
    id: 'security',
    name: 'Security',
    icon: 'Shield',
    description: 'Authentication, CSP, input validation, context isolation, and secrets',
    scoringFocus: [
      'Auth strategy',
      'Input validation',
      'CSP headers',
      'Context isolation',
      'Secret management'
    ]
  },
  testing: {
    id: 'testing',
    name: 'Testing',
    icon: 'TestTube',
    description: 'Test strategy, coverage plan, E2E scenarios, and testing pyramid',
    scoringFocus: [
      'Test pyramid balance',
      'Coverage strategy',
      'E2E critical paths',
      'Mock strategy',
      'CI integration'
    ]
  },
  infrastructure: {
    id: 'infrastructure',
    name: 'Infrastructure',
    icon: 'Cloud',
    description: 'CI/CD pipelines, packaging, deployment, monitoring, and releases',
    scoringFocus: [
      'CI/CD pipeline',
      'Packaging strategy',
      'Deployment plan',
      'Monitoring',
      'Release automation'
    ]
  },
  data: {
    id: 'data',
    name: 'Data',
    icon: 'Database',
    description: 'Schema design, migrations, query patterns, and data integrity',
    scoringFocus: [
      'Schema design',
      'Migration strategy',
      'Query optimization',
      'Data integrity',
      'Backup/recovery'
    ]
  },
  'code-quality': {
    id: 'code-quality',
    name: 'Code Quality',
    icon: 'Code',
    description: 'SOLID principles, naming, patterns, refactoring, and documentation',
    scoringFocus: [
      'SOLID adherence',
      'Naming conventions',
      'Pattern consistency',
      'Refactoring plan',
      'Documentation'
    ]
  }
} as const

// ── Audit Tracks (Workspace Health) ──────────────────────────────────────────

export const AUDIT_TRACKS: Record<AuditTrackId, AuditTrack> = {
  database: {
    id: 'database',
    name: 'Database',
    icon: 'Database',
    description: 'Schema design, migrations, query patterns, indexing, and data integrity',
    weight: 1.0,
    scoringFocus: [
      'Schema design & normalization',
      'Migration strategy & safety',
      'Query optimization & N+1 detection',
      'Index coverage',
      'Data integrity constraints'
    ]
  },
  code: {
    id: 'code',
    name: 'Code Quality',
    icon: 'Code',
    description: 'Frontend and backend patterns, SOLID principles, complexity, error handling',
    weight: 1.5,
    scoringFocus: [
      'SOLID adherence',
      'Naming conventions & consistency',
      'Cyclomatic complexity',
      'Error handling patterns',
      'Dead code & unused exports'
    ]
  },
  testing: {
    id: 'testing',
    name: 'Testing',
    icon: 'TestTube',
    description: 'Test coverage, test pyramid balance, fixture quality, CI integration',
    weight: 1.0,
    scoringFocus: [
      'Test pyramid balance (unit/integration/E2E)',
      'Critical path coverage',
      'Test fixture quality',
      'Assertion specificity',
      'CI/CD test integration'
    ]
  },
  architecture: {
    id: 'architecture',
    name: 'Architecture',
    icon: 'Building2',
    description: 'Module boundaries, dependency management, separation of concerns, scalability',
    weight: 1.5,
    scoringFocus: [
      'Module boundaries & coupling',
      'Dependency direction (no circular)',
      'Separation of concerns',
      'API/IPC contract design',
      'Scalability patterns'
    ]
  },
  security: {
    id: 'security',
    name: 'Security',
    icon: 'Shield',
    description: 'Input validation, authentication, secret management, CSP, context isolation',
    weight: 1.5,
    scoringFocus: [
      'Input validation & sanitization',
      'Authentication & authorization',
      'Secret management (no hardcoded secrets)',
      'CSP & context isolation (Electron)',
      'Dependency vulnerability posture'
    ]
  },
  documentation: {
    id: 'documentation',
    name: 'Documentation',
    icon: 'FileText',
    description: 'README quality, inline docs, API documentation, CLAUDE.md completeness',
    weight: 0.75,
    scoringFocus: [
      'README completeness',
      'Inline documentation (JSDoc/TSDoc)',
      'API endpoint documentation',
      'CLAUDE.md / project guide quality',
      'Change log / decision records'
    ]
  },
  'ui-ux': {
    id: 'ui-ux',
    name: 'UI/UX',
    icon: 'Palette',
    description: 'Accessibility, responsive design, error states, loading states, consistency',
    weight: 1.0,
    scoringFocus: [
      'Accessibility (WCAG compliance)',
      'Error & empty state handling',
      'Loading state indicators',
      'Component consistency',
      'Keyboard navigation'
    ]
  }
} as const

/** Maximum USD budget per auditor turn (lower than chat) */
export const AUDIT_BUDGET_CAP = 0.75 as const

// ── MCP Tool Name Registry ──────────────────────────────────────────────────
// Single source of truth for all MCP tool names used across the codebase.
// SDK convention: tool full name = `mcp__{server}__{tool}`
//
// Usage:
//   MCP_TOOLS.CODE_GRAPH.GRAPH_MAP.name   → 'mcp__code-graph__graph_map'
//   MCP_TOOLS.CODE_GRAPH._SERVER          → 'code-graph'
//   MCP_TOOLS.CODE_GRAPH._PREFIX          → 'mcp__code-graph__'
//   MCP_TOOLS.CONTROL_ACTIONS._ALL_NAMES  → ['mcp__control-actions__emit_plan', ...]

function mcpTool(
  server: string,
  tool: string,
  displayName: string
): { name: `mcp__${string}__${string}`; tool: string; server: string; displayName: string } {
  return {
    /** Full SDK tool name: mcp__{server}__{tool} */
    name: `mcp__${server}__${tool}` as const,
    /** Short tool name as registered in createSdkMcpServer */
    tool,
    /** MCP server name */
    server,
    /** Human-readable display label for the UI */
    displayName
  }
}

function mcpServer<T extends Record<string, ReturnType<typeof mcpTool>>>(
  server: string,
  tools: T
): { _SERVER: string; _PREFIX: `mcp__${string}__`; _ALL_NAMES: string[] } & T {
  return {
    /** MCP server name */
    _SERVER: server,
    /** Prefix for startsWith() checks: `mcp__{server}__` */
    _PREFIX: `mcp__${server}__` as const,
    /** All tool full names as an array (for allowedTools lists) */
    _ALL_NAMES: Object.values(tools).map((t) => t.name),
    ...tools
  } as const
}

export const MCP_TOOLS = {
  CODE_GRAPH: mcpServer('code-graph', {
    GRAPH_MAP: mcpTool('code-graph', 'graph_map', 'Code Graph · graph_map'),
    SEARCH_IDENTIFIERS: mcpTool(
      'code-graph',
      'search_identifiers',
      'Code Graph · search_identifiers'
    ),
    FIND_DEAD_CODE: mcpTool('code-graph', 'find_dead_code', 'Code Graph · find_dead_code'),
    FILE_OUTLINE: mcpTool('code-graph', 'file_outline', 'Code Graph · file_outline'),
    FIND_CALLERS: mcpTool('code-graph', 'find_callers', 'Code Graph · find_callers'),
    FIND_CALLEES: mcpTool('code-graph', 'find_callees', 'Code Graph · find_callees'),
    FIND_REFERENCES: mcpTool('code-graph', 'find_references', 'Code Graph · find_references'),
    FILE_DEPENDENCIES: mcpTool('code-graph', 'file_dependencies', 'Code Graph · file_dependencies'),
    FILE_DEPENDENTS: mcpTool('code-graph', 'file_dependents', 'Code Graph · file_dependents'),
    SYMBOL_HOTSPOTS: mcpTool('code-graph', 'symbol_hotspots', 'Code Graph · symbol_hotspots'),
    COUPLING_ANALYSIS: mcpTool('code-graph', 'coupling_analysis', 'Code Graph · coupling_analysis'),
    CIRCULAR_DEPENDENCIES: mcpTool(
      'code-graph',
      'circular_dependencies',
      'Code Graph · circular_dependencies'
    ),
    MODULE_BOUNDARY_HEALTH: mcpTool(
      'code-graph',
      'module_boundary_health',
      'Code Graph · module_boundary_health'
    )
  }),
  SEMANTIC_SEARCH: mcpServer('semantic-search', {
    SEMANTIC_SEARCH: mcpTool('semantic-search', 'semantic_search', 'Semantic Search'),
    SIMILAR_CODE: mcpTool('semantic-search', 'similar_code', 'Semantic · similar_code'),
    CODEBASE_CONCEPTS: mcpTool(
      'semantic-search',
      'codebase_concepts',
      'Semantic · codebase_concepts'
    )
  }),
  GIT_CONTEXT: mcpServer('git-context', {
    GIT_LOG: mcpTool('git-context', 'git_log', 'Git · log'),
    GIT_DIFF: mcpTool('git-context', 'git_diff', 'Git · diff'),
    GIT_BLAME: mcpTool('git-context', 'git_blame', 'Git · blame')
  }),
  CHECKPOINT_CONTEXT: mcpServer('checkpoint-context', {
    LIST_CHECKPOINTS: mcpTool('checkpoint-context', 'list_checkpoints', 'Checkpoints · list'),
    GET_CHECKPOINT: mcpTool('checkpoint-context', 'get_checkpoint', 'Checkpoints · get')
  }),
  GITHUB_CONTEXT: mcpServer('github-context', {
    GET_PR_STATUS: mcpTool('github-context', 'get_pr_status', 'GitHub · PR status'),
    LIST_PR_COMMENTS: mcpTool('github-context', 'list_pr_comments', 'GitHub · PR comments'),
    LIST_ISSUES: mcpTool('github-context', 'list_issues', 'GitHub · issues')
  }),
  CODE_ANALYSIS: mcpServer('code-analysis', {
    TODO_SCANNER: mcpTool('code-analysis', 'todo_scanner', 'Analysis · todo_scanner'),
    DEPENDENCY_HEALTH: mcpTool(
      'code-analysis',
      'dependency_health',
      'Analysis · dependency_health'
    ),
    TEST_COVERAGE_MAP: mcpTool('code-analysis', 'test_coverage_map', 'Analysis · test_coverage_map')
  }),
  CONTROL_ACTIONS: mcpServer('control-actions', {
    EMIT_PLAN: mcpTool('control-actions', 'emit_plan', 'Control · emit_plan'),
    ASK_USER: mcpTool('control-actions', 'ask_user', 'Control · ask_user'),
    EMIT_MEMORY: mcpTool('control-actions', 'emit_memory', 'Control · emit_memory')
  })
} as const

/** All MCP tool full names — for test assertions and validation */
export const ALL_MCP_TOOL_NAMES = Object.values(MCP_TOOLS).flatMap((server) => server._ALL_NAMES)

// ── Local MCP Integrations ──────────────────────────────────────────────

export interface LocalMcpDefinition {
  /** MCP server name — matches keys in MCP_TOOLS (e.g. 'code-graph') */
  id: string
  /** Display name shown in the UI */
  displayName: string
  /** Short description */
  description: string
  /** Lucide icon name */
  icon: string
  /** Token impact level */
  tokenImpact: 'low' | 'medium' | 'high'
  /** Number of tools the server exposes */
  toolCount: number
  /**
   * Workspace settings key that gates availability.
   * null = always available when workspace exists.
   */
  featureFlagKey: 'repomapEnabled' | 'semanticSearchEnabled' | 'githubConfigured' | null
  /** Whether enabled by default when no per-chat override exists */
  defaultEnabled: boolean
}

export const LOCAL_MCP_INTEGRATIONS: readonly LocalMcpDefinition[] = [
  {
    id: 'code-graph',
    displayName: 'Code Graph',
    description: 'AST-based navigation — callers, references, dead code, coupling',
    icon: 'Network',
    tokenImpact: 'high',
    toolCount: 13,
    featureFlagKey: 'repomapEnabled',
    defaultEnabled: true
  },
  {
    id: 'semantic-search',
    displayName: 'Semantic Search',
    description: 'Embedding-based code search and concept discovery',
    icon: 'Search',
    tokenImpact: 'medium',
    toolCount: 3,
    featureFlagKey: 'semanticSearchEnabled',
    defaultEnabled: true
  },
  {
    id: 'git-context',
    displayName: 'Git Context',
    description: 'Git log, diff, and blame for version history',
    icon: 'GitBranch',
    tokenImpact: 'low',
    toolCount: 3,
    featureFlagKey: null,
    defaultEnabled: true
  },
  {
    id: 'checkpoint-context',
    displayName: 'Checkpoints',
    description: 'List and restore conversation checkpoints',
    icon: 'Clock',
    tokenImpact: 'low',
    toolCount: 2,
    featureFlagKey: null,
    defaultEnabled: true
  },
  {
    id: 'github-context',
    displayName: 'GitHub',
    description: 'PR status, comments, and issue tracking',
    icon: 'Github',
    tokenImpact: 'low',
    toolCount: 3,
    featureFlagKey: 'githubConfigured',
    defaultEnabled: true
  },
  {
    id: 'code-analysis',
    displayName: 'Code Analysis',
    description: 'TODO scanning, dependency health, test coverage',
    icon: 'BarChart3',
    tokenImpact: 'low',
    toolCount: 3,
    featureFlagKey: null,
    defaultEnabled: true
  }
] as const

/** IDs of internal MCP servers that are always on and hidden from the toggle UI */
export const ALWAYS_ON_MCP_SERVERS = ['control-actions'] as const

// ── Local LLM Provider ──

/** Default Ollama connection */
export const OLLAMA_DEFAULT_HOST = '127.0.0.1' as const
export const OLLAMA_DEFAULT_PORT = 11434 as const

/** Default oMLX connection (Apple Silicon native) */
export const OMLX_DEFAULT_HOST = '127.0.0.1' as const
export const OMLX_DEFAULT_PORT = 8000 as const

/** Recommended local models — curated by memory tier (Mac-first, MLX-optimized where available) */
export const RECOMMENDED_LOCAL_MODELS: import('./types').RecommendedLocalModel[] = [
  // 8GB tier
  {
    ollamaId: 'qwen2.5-coder:3b',
    omlxId: 'mlx-community/Qwen2.5-Coder-3B-Instruct-4bit',
    label: 'Qwen 2.5 Coder 3B',
    parameterSize: '3B',
    contextWindow: 32768,
    minMemoryGB: 4,
    memoryTier: '8gb',
    toolCalling: 'basic',
    description: 'Fastest option — limited quality'
  },
  {
    ollamaId: 'qwen2.5-coder:7b',
    omlxId: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit',
    label: 'Qwen 2.5 Coder 7B',
    parameterSize: '7B',
    contextWindow: 32768,
    minMemoryGB: 6,
    memoryTier: '8gb',
    toolCalling: 'good',
    description: 'Best balance for 8GB Macs'
  },
  // 16GB tier
  {
    ollamaId: 'qwen2.5-coder:14b',
    omlxId: 'mlx-community/Qwen2.5-Coder-14B-Instruct-4bit',
    label: 'Qwen 2.5 Coder 14B',
    parameterSize: '14B',
    contextWindow: 32768,
    minMemoryGB: 12,
    memoryTier: '16gb',
    toolCalling: 'good',
    description: 'Strong coding — fits 16GB well'
  },
  // 32GB tier (MLX)
  {
    ollamaId: 'qwen3.6:35b-a3b-coding-nvfp4',
    omlxId: 'mlx-community/Qwen3.6-35B-A3B-Coding-NVFP4',
    label: 'Qwen 3.6 Coding (MLX)',
    parameterSize: '35B MoE',
    activeParams: 'A3B',
    contextWindow: 262144, // Native 262K (was 131K — incorrect; see HF model card)
    quantization: 'NVFP4',
    minMemoryGB: 24,
    memoryTier: '32gb',
    toolCalling: 'native',
    mlxOptimized: true,
    description: 'Top pick — MLX + NVFP4, coding-tuned',
    recommended: true
  },
  {
    ollamaId: 'qwen3-coder:30b',
    omlxId: 'mlx-community/Qwen3-Coder-30B-A3B-4bit',
    label: 'Qwen 3 Coder 30B',
    parameterSize: '30B MoE',
    activeParams: '3.3B',
    contextWindow: 262144,
    minMemoryGB: 24,
    memoryTier: '32gb',
    toolCalling: 'native',
    description: 'Purpose-built for coding agents, 256K context'
  },
  // 48GB+ tier
  {
    ollamaId: 'qwen3-coder-next:q4_K_M',
    // No MLX variant available yet — omit omlxId
    label: 'Qwen 3 Coder Next 80B',
    parameterSize: '80B MoE',
    activeParams: '3B',
    contextWindow: 262144,
    quantization: 'Q4_K_M',
    minMemoryGB: 52,
    memoryTier: '48gb+',
    toolCalling: 'excellent',
    description: 'Best local coding quality — needs 64GB+'
  },
  {
    ollamaId: 'gemma4:e4b-mlx-bf16',
    omlxId: 'mlx-community/gemma-4-e4b-it-bf16',
    label: 'Gemma 4 E4B (MLX)',
    parameterSize: 'MoE',
    activeParams: 'E4B',
    contextWindow: 128000,
    quantization: 'BF16',
    minMemoryGB: 32,
    memoryTier: '48gb+',
    toolCalling: 'native',
    mlxOptimized: true,
    description: 'Google alternative — MLX native'
  }
] as const

/** Resolve the correct model ID for the active backend */
export function resolveModelId(
  model: import('./types').RecommendedLocalModel,
  backend: import('./types').LocalLLMBackend
): string {
  return backend === 'omlx' ? (model.omlxId ?? model.ollamaId) : model.ollamaId
}

/**
 * @deprecated Use `TIER_LIMITS` from `src/main/services/context-management.ts` instead.
 * Superseded by the context window tier system (ContextWindowTier / resolveContextTier / TIER_LIMITS).
 * Kept temporarily for backward compatibility — will be removed in the next breaking change.
 */
export const LOCAL_LLM_COMPACT_THRESHOLDS: Record<string, { suggest: number; auto: number }> = {
  '32k': { suggest: 16_000, auto: 24_000 },
  '128k': { suggest: 60_000, auto: 80_000 },
  '256k': { suggest: 120_000, auto: 160_000 }
} as const

/** Full name → display name map — for renderer ToolActivityBlock */
export const MCP_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  Object.values(MCP_TOOLS).flatMap((server) =>
    Object.entries(server)
      .filter(([k]) => !k.startsWith('_'))
      .map(([, t]) => [
        (t as ReturnType<typeof mcpTool>).name,
        (t as ReturnType<typeof mcpTool>).displayName
      ])
  )
)

// ── External MCP Integrations ──────────────────────────────────────────────

/**
 * Definition for an optional external MCP server that can be enabled per-workspace
 * and toggled per-conversation via the chat pill bar.
 */
export interface ExternalMcpDefinition {
  /** Unique key — used as settingsJson key suffix and MCP server name */
  id: string
  /** Display name shown in the UI */
  displayName: string
  /** Short description for the integrations page */
  description: string
  /** Lucide icon name */
  icon: string
  /** stdio command to launch the MCP server */
  command: string
  /** Args passed to the command */
  args: string[]
  /** Optional env var keys the server accepts */
  envKeys?: string[]
  /** Token impact level — shown as a badge */
  tokenImpact: 'low' | 'medium' | 'high'
  /** Number of tools the server exposes */
  toolCount: number
  /** Prerequisite description for the user */
  prerequisite: string
  /** Documentation URL */
  docsUrl: string
  /** All tool names (SDK format: mcp__{server}__{tool}) */
  toolNames: string[]
  /** Read-only tools allowed in plan mode */
  planModeToolNames: string[]
  /** Category for UI grouping */
  category: 'testing' | 'deployment' | 'monitoring' | 'other'

  /** Longer explanation for newcomers — what is this integration and why use it */
  longDescription?: string
  /** Concrete use cases shown as cards */
  useCases?: { title: string; description: string; icon: string }[]
  /** Human-readable description per tool name */
  toolDescriptions?: Record<string, string>
  /** Step-by-step workflow explanation */
  workflowSteps?: { step: string; description: string }[]
}

/**
 * Registry of all supported external MCP integrations.
 * Adding a new integration = adding an entry here — the UI and MCP builder
 * consume this registry automatically.
 */
export const EXTERNAL_MCP_INTEGRATIONS: readonly ExternalMcpDefinition[] = [
  {
    id: 'maestro',
    displayName: 'Maestro',
    description:
      'AI-powered mobile app testing — drive real devices, inspect screens, generate and run E2E flows.',
    icon: 'Smartphone',
    command: 'maestro',
    args: ['mcp'],
    envKeys: ['JAVA_HOME', 'MAESTRO_CLOUD_API_KEY'],
    tokenImpact: 'high',
    toolCount: 8,
    prerequisite: 'Maestro CLI installed and on PATH',
    docsUrl: 'https://docs.maestro.dev/get-started/maestro-mcp',
    toolNames: [
      'mcp__maestro__list_devices',
      'mcp__maestro__inspect_screen',
      'mcp__maestro__take_screenshot',
      'mcp__maestro__run',
      'mcp__maestro__cheat_sheet',
      'mcp__maestro__list_cloud_devices',
      'mcp__maestro__run_on_cloud',
      'mcp__maestro__get_cloud_status'
    ],
    planModeToolNames: [
      'mcp__maestro__list_devices',
      'mcp__maestro__inspect_screen',
      'mcp__maestro__take_screenshot',
      'mcp__maestro__cheat_sheet',
      'mcp__maestro__get_cloud_status'
    ],
    category: 'testing',

    longDescription:
      'Maestro lets your AI agent take full control of mobile app testing. Instead of manually writing test scripts, you describe what you want to test in plain language — your agent inspects the live app screen, identifies UI elements, generates test flows, and runs them on real devices or emulators. It works with iOS, Android, and web apps.',

    useCases: [
      {
        title: 'AI-Written E2E Tests',
        description:
          'Describe a user flow in plain English — "test the login with invalid credentials" — and your agent writes the Maestro YAML, runs it, and reports results. No manual element inspection needed.',
        icon: 'FileCode'
      },
      {
        title: 'Visual Regression Checks',
        description:
          'Ask your agent to screenshot every screen in a flow, then compare after code changes. Catch visual regressions without a dedicated QA pass.',
        icon: 'Eye'
      },
      {
        title: 'Interactive Debugging',
        description:
          'When a test fails, your agent can inspect the live screen hierarchy, take screenshots, and diagnose what changed — all in the same conversation.',
        icon: 'Bug'
      },
      {
        title: 'Cross-Platform Validation',
        description:
          'Run the same flow on iOS simulator and Android emulator side-by-side. Your agent lists available devices and targets each one.',
        icon: 'Layers'
      },
      {
        title: 'Cloud Test Runs',
        description:
          'Submit flows to Maestro Cloud for parallel execution across device farms. Your agent monitors status and reports results back.',
        icon: 'Cloud'
      }
    ],

    toolDescriptions: {
      mcp__maestro__list_devices:
        'Discovers all available devices — Android emulators, iOS simulators, and Chromium browsers — so the agent knows what targets are ready for testing.',
      mcp__maestro__inspect_screen:
        "Reads the current screen's full UI hierarchy (element IDs, labels, positions) as structured data. The agent calls this before interacting with any element to understand what's on screen.",
      mcp__maestro__take_screenshot:
        'Captures a visual snapshot of the device screen. Useful when the agent needs to visually verify layout, compare states, or show you what it sees.',
      mcp__maestro__run:
        'Executes Maestro test flows — either inline YAML the agent generated, specific .yaml files, or an entire test directory with tag filters. This is the core "run the test" action.',
      mcp__maestro__cheat_sheet:
        "Returns Maestro's command reference — tap, scroll, assert, inputText, etc. The agent uses this to write correct YAML syntax without hallucinating commands.",
      mcp__maestro__list_cloud_devices:
        'Shows available device/OS combinations on Maestro Cloud (e.g., iPhone 15 + iOS 17.5, Pixel 8 + Android 34). Used when targeting cloud execution.',
      mcp__maestro__run_on_cloud:
        'Submits test flows to Maestro Cloud for remote execution across a device farm. Returns a dashboard URL for monitoring.',
      mcp__maestro__get_cloud_status:
        'Polls the status of a cloud test run — pending, running, passed, failed — so the agent can wait for results and report back.'
    },

    workflowSteps: [
      { step: 'Enable', description: 'Toggle Maestro ON here. A pill appears in your chat bar.' },
      {
        step: 'Activate per-chat',
        description: 'Click the Maestro pill in any conversation to activate it for that session.'
      },
      {
        step: 'Ask naturally',
        description: 'Tell your agent what to test: "Test the checkout flow on my Android emulator"'
      },
      {
        step: 'Agent drives',
        description:
          'The agent inspects the screen, writes YAML flows, runs them, and reports results — all autonomously.'
      }
    ]
  }
] as const
