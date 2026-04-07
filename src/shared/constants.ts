import type { GrillTrackId, GrillTrack } from './types'

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
  CHAT_RENAME: 'chat:renameConversation',
  CHAT_STOP: 'chat:stop',
  CHAT_COMPACT: 'chat:compact',
  CHAT_HANDOFF: 'chat:handoff',
  CHAT_GRILL_COMPLETE: 'chat:grillComplete',
  CHAT_GRILL_QUESTION: 'chat:grillQuestion',
  CHAT_GRILL_EVALUATION: 'chat:grillEvaluation',
  CHAT_ASK_QUESTION: 'chat:askQuestion',
  CHAT_PLAN: 'chat:plan',
  CHAT_EXECUTE_PLAN: 'chat:executePlan',
  CHAT_TASK_PROGRESS: 'chat:taskProgress',
  CHAT_BUILD_TASKS: 'chat:buildTasks',
  CHAT_COMPLETE: 'chat:complete',
  CHAT_CLOSE: 'chat:close',
  CHAT_GET_FILE_CHANGES: 'chat:getFileChanges',
  CHAT_INVESTIGATION_REPORT: 'chat:investigationReport',
  CHAT_EXECUTE_INVESTIGATION_FIX: 'chat:executeInvestigationFix',
  /** Direct plan-to-build: skip generalist round-trip when user clicks "Build This" on inline plan */
  CHAT_BUILD_FROM_PLAN: 'chat:buildFromPlan',

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
  SPECIALIST_GET_CONVERSATION_SPECIALISTS: 'specialist:getConversationSpecialists',
  SPECIALIST_ADD_CONVERSATION_SPECIALIST: 'specialist:addConversationSpecialist',
  SPECIALIST_REMOVE_CONVERSATION_SPECIALIST: 'specialist:removeConversationSpecialist',
  SPECIALIST_REPLACE_CONVERSATION_SPECIALISTS: 'specialist:replaceConversationSpecialists',
  SPECIALIST_GET_CONVERSATION_HISTORY: 'specialist:getConversationHistory',
  SPECIALIST_ADD_CONVERSATION_HISTORY_ENTRY: 'specialist:addConversationHistoryEntry',
  SPECIALIST_CLEAR_CONVERSATION_HISTORY: 'specialist:clearConversationHistory',

  // Conversation Specialist Activation (with skill gating)
  CONV_SPECIALIST_LIST: 'convSpecialist:list',
  CONV_SPECIALIST_UPSERT: 'convSpecialist:upsert',
  CONV_SPECIALIST_REMOVE: 'convSpecialist:remove',
  CONV_SPECIALIST_RESET: 'convSpecialist:reset',
  CONV_SPECIALIST_ESTIMATE: 'convSpecialist:estimate',

  // App Preferences
  APP_PREFERENCE_GET_ALL: 'appPreference:getAll',
  APP_PREFERENCE_SET: 'appPreference:set',

  // Specialist Marketplace
  SPECIALIST_DEPLOY: 'specialist:deploy',
  SPECIALIST_UNDEPLOY: 'specialist:undeploy',
  SPECIALIST_UPDATE_CONFIG: 'specialist:updateConfig',
  SPECIALIST_GET_MARKETPLACE: 'specialist:getMarketplace',

  // Cache metrics (Strategy 15)
  SPECIALIST_CACHE_METRICS: 'specialist:getCacheMetrics',

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

  // Pixel Office
  PIXEL_OFFICE_POPOUT: 'pixelOffice:popout',
  PIXEL_OFFICE_SAVE_LAYOUT: 'pixelOffice:saveLayout',
  PIXEL_OFFICE_LOAD_LAYOUT: 'pixelOffice:loadLayout',
  PIXEL_OFFICE_EXPORT_LAYOUT: 'pixelOffice:exportLayout',
  PIXEL_OFFICE_IMPORT_LAYOUT: 'pixelOffice:importLayout',

  // Worktrees
  WORKTREE_LIST: 'worktree:list',
  WORKTREE_GET_DIFF: 'worktree:getDiff',
  WORKTREE_MERGE: 'worktree:merge',
  WORKTREE_MERGE_ALL: 'worktree:mergeAll',
  WORKTREE_ABANDON: 'worktree:abandon',

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

  // Dream (auto consolidation)
  DREAM_TRIGGER: 'dream:trigger',
  DREAM_CANCEL: 'dream:cancel',
  DREAM_GET_STATUS: 'dream:getStatus',
  DREAM_GET_HISTORY: 'dream:getHistory',
  DREAM_PROGRESS: 'dream:progress',

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

  // GitHub Integration
  GITHUB_SAVE_TOKEN: 'github:saveToken',
  GITHUB_VALIDATE_TOKEN: 'github:validateToken',
  GITHUB_GET_STATUS: 'github:getStatus',
  GITHUB_REMOVE_TOKEN: 'github:removeToken',

  // Repository Management
  REPO_INIT: 'repo:init',
  REPO_SET_REMOTE: 'repo:setRemote',
  REPO_GET_INFO: 'repo:getInfo',
  REPO_HAS_UNSAVED_CHANGES: 'repo:hasUnsavedChanges',

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

  // Gate results
  GATE_RESULTS_GET: 'gate:getResults',

  // Agent events (new from audit)
  AGENT_ABANDONMENT_DETECTED: 'agent:abandonmentDetected',
  AGENT_GATE_FAILURE: 'agent:gateFailure',

  // Tool approval
  TOOL_APPROVAL_REQUEST: 'tool:approvalRequest',
  TOOL_APPROVAL_RESPONSE: 'tool:approvalResponse',

  // Core Agent Prompts
  CORE_AGENT_PROMPT_LIST: 'coreAgentPrompt:list',
  CORE_AGENT_PROMPT_GET: 'coreAgentPrompt:get',
  CORE_AGENT_PROMPT_UPSERT: 'coreAgentPrompt:upsert',
  CORE_AGENT_PROMPT_RESET: 'coreAgentPrompt:reset',

  // AI Subscriptions
  SUBSCRIPTION_VALIDATE_ALL: 'subscription:validateAll',
  SUBSCRIPTION_CHECK_CLAUDE_CLI: 'subscription:checkClaudeCli',
  SUBSCRIPTION_AUTO_CONFIGURE: 'subscription:autoConfigure',

  // Ollama
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

  // Code Graph (persisted repomap)
  CODE_GRAPH_INDEX_START: 'codeGraph:indexStart',
  CODE_GRAPH_GET_STATUS: 'codeGraph:getStatus',
  CODE_GRAPH_HAS_INDEX: 'codeGraph:hasIndex',
  CODE_GRAPH_PROGRESS: 'codeGraph:progress',

  // Scheduling Strategy
  SCHEDULING_GET_WEIGHTS: 'scheduling:getWeights',
  SCHEDULING_SET_WEIGHTS: 'scheduling:setWeights',

  // Conversation reordering
  CONVERSATION_REORDER: 'conversation:reorder',

  // Context usage
  CONVERSATION_GET_CONTEXT_USAGE: 'conversation:getContextUsage',

} as const

export const CONVERSATION_MODES = {
  plan: {
    icon: '📋',
    label: 'Plan',
    color: '#8B5CF6',
    description: 'Analyze code, brainstorm ideas, create plans (read-only)'
  },
  build: {
    icon: '🔨',
    label: 'Build',
    color: '#F59E0B',
    description: 'Make changes, write code, run commands (full access)'
  }
} as const

/** Model used for activation CLAUDE.md generation (structured output — Haiku-tier) */
export const ACTIVATION_MODEL_ID = 'claude-haiku-4-5-20251001' as const

/** Fast model used for memory feed summarization tasks (structured extraction — Haiku-tier) */
export const MEMORY_FEED_MODEL_ID = 'claude-haiku-4-5-20251001' as const

/** Model used for dream consolidation cycles (background summarization — Haiku-tier) */
export const DREAM_MODEL_ID = 'claude-haiku-4-5-20251001' as const

/** Model IDs per complexity tier — used for specialist routing */
export const MODEL_TIER_IDS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6'
} as const

/** Complexity score thresholds for tier assignment */
export const COMPLEXITY_THRESHOLDS = {
  simple: { min: 0, max: 4 },
  moderate: { min: 5, max: 8 },
  complex: { min: 9, max: 14 }
} as const

/**
 * @deprecated Use database-backed agent IDs instead.
 * Kept temporarily for backward compatibility in generalist services.
 */
export const AGENT_IDS = {
  GENERALIST: 'generalist'
} as const

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
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    tier: 'opus' as const,
    description: 'Most capable'
  }
] as const

/** Default model for each configurable action */
export const DEFAULT_MODEL_CONFIG: Record<
  import('./types').ModelAction,
  string
> = {
  generalist: 'claude-sonnet-4-6',
  'specialist:simple': 'claude-haiku-4-5-20251001',
  'specialist:moderate': 'claude-sonnet-4-6',
  'specialist:complex': 'claude-opus-4-6',
  dream: 'claude-haiku-4-5-20251001',
  memoryFeed: 'claude-haiku-4-5-20251001',
  activation: 'claude-haiku-4-5-20251001'
} as const

/** Human-readable metadata for each model action — used in the Models config UI */
export const MODEL_ACTIONS_META: Record<
  import('./types').ModelAction,
  { label: string; description: string; icon: string; section: 'agent' | 'specialist' | 'background' }
> = {
  generalist: {
    label: 'Generalist',
    description: 'Main chat agent that handles conversations',
    icon: '💬',
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
  dream: {
    label: 'Dream Consolidation',
    description: 'Memory consolidation cycles',
    icon: '🌙',
    section: 'background'
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
  opus: '31999'
} as const

/**
 * Maps complexity tiers to SDK effort levels.
 * Controls how much reasoning Claude applies per task.
 */
export const COMPLEXITY_TO_EFFORT = {
  simple: 'low',
  moderate: 'medium',
  complex: 'high'
} as const satisfies Record<string, 'low' | 'medium' | 'high' | 'max'>

/**
 * Default USD budget caps per specialist execution.
 * SDK returns error_max_budget_usd when exceeded — clean exit, no crash.
 */
export const SPECIALIST_BUDGET_CAPS = {
  simple: 0.10,
  moderate: 0.50,
  complex: 2.00
} as const satisfies Record<string, number>

/** Generalist per-turn budget — higher because coordinator handles full conversations */
export const GENERALIST_BUDGET_CAP = 1.50

/** Maximum skill file size in bytes (500 KB) */
export const SKILL_MAX_FILE_SIZE_BYTES = 512000 as const // 500 * 1024

/**
 * Model pricing table — $/1M tokens for input and output.
 * Used for estimated cost calculations in the cost tracker service.
 * Based on Claude pricing as of March 2026.
 */
export const MODEL_PRICING_TABLE = {
  // Current models
  'claude-haiku-4-5-20251001': { inputPer1M: 1.0, outputPer1M: 5.0 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-opus-4-6': { inputPer1M: 5.0, outputPer1M: 25.0 },
  // Legacy (kept for historical cost calculation on older sessions)
  'claude-sonnet-4-20250514': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-opus-4-20250514': { inputPer1M: 15.0, outputPer1M: 75.0 },
  'claude-3-5-sonnet-20241022': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.8, outputPer1M: 4.0 }
} as const

/**
 * Model escalation chain for failure-based retries.
 * Maps current tier → escalated tier. 'opus' has no further escalation.
 */
export const MODEL_ESCALATION_CHAIN = {
  haiku: 'sonnet',
  sonnet: 'opus'
} as const

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

// ── MCP Tool Name Registry ──────────────────────────────────────────────────
// Single source of truth for all MCP tool names used across the codebase.
// SDK convention: tool full name = `mcp__{server}__{tool}`
//
// Usage:
//   MCP_TOOLS.CODE_GRAPH.GRAPH_MAP.name   → 'mcp__code-graph__graph_map'
//   MCP_TOOLS.CODE_GRAPH._SERVER          → 'code-graph'
//   MCP_TOOLS.CODE_GRAPH._PREFIX          → 'mcp__code-graph__'
//   MCP_TOOLS.CONTROL_ACTIONS._ALL_NAMES  → ['mcp__control-actions__emit_plan', ...]

function mcpTool(server: string, tool: string, displayName: string) {
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
) {
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
    SEARCH_IDENTIFIERS: mcpTool('code-graph', 'search_identifiers', 'Code Graph · search_identifiers'),
    FIND_DEAD_CODE: mcpTool('code-graph', 'find_dead_code', 'Code Graph · find_dead_code')
  }),
  SEMANTIC_SEARCH: mcpServer('semantic-search', {
    SEMANTIC_SEARCH: mcpTool('semantic-search', 'semantic_search', 'Semantic Search')
  }),
  GIT_CONTEXT: mcpServer('git-context', {
    GIT_LOG: mcpTool('git-context', 'git_log', 'Git · log'),
    GIT_DIFF: mcpTool('git-context', 'git_diff', 'Git · diff'),
    GIT_BLAME: mcpTool('git-context', 'git_blame', 'Git · blame')
  }),
  TASK_CONTEXT: mcpServer('task-context', {
    LIST_TASKS: mcpTool('task-context', 'list_tasks', 'Tasks · list'),
    GET_TASK_OUTPUT: mcpTool('task-context', 'get_task_output', 'Tasks · output')
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
  CONTROL_ACTIONS: mcpServer('control-actions', {
    EMIT_PLAN: mcpTool('control-actions', 'emit_plan', 'Control · emit_plan'),
    REQUEST_HANDOFF: mcpTool('control-actions', 'request_handoff', 'Control · request_handoff'),
    ASK_USER: mcpTool('control-actions', 'ask_user', 'Control · ask_user'),
    EMIT_MEMORY: mcpTool('control-actions', 'emit_memory', 'Control · emit_memory')
  }),
  SPECIALIST_CONTROL: mcpServer('specialist-control', {
    EMIT_INVESTIGATION_REPORT: mcpTool(
      'specialist-control',
      'emit_investigation_report',
      'Specialist · report'
    )
  })
} as const

/** All MCP tool full names — for test assertions and validation */
export const ALL_MCP_TOOL_NAMES = Object.values(MCP_TOOLS).flatMap((server) => server._ALL_NAMES)

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
