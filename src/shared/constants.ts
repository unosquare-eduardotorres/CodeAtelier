import type {
  AgentRole,
  GrillTrackId,
  GrillTrack,
  AuditTrackId,
  AuditTrack,
  AuditSkill,
  AuditApplicability,
  AuditResult,
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
  CHAT_UPDATE_EFFORT: 'chat:updateEffort',
  CHAT_UPDATE_PERSONA: 'chat:updatePersona',
  CHAT_RENAME: 'chat:renameConversation',
  CHAT_STOP: 'chat:stop',
  CHAT_COMPACT: 'chat:compact',
  /** Swap DaVinci out for the workspace's ready Project Specialist — triggered by user accepting the swap proposal */
  CHAT_SWAP_TO_SPECIALIST: 'chat:swapToSpecialist',
  CHAT_ASK_QUESTION: 'chat:askQuestion',
  CHAT_COMPLETE: 'chat:complete',
  CHAT_CLOSE: 'chat:close',
  CHAT_GET_FILE_CHANGES: 'chat:getFileChanges',
  CHAT_SWITCH_BRANCH: 'chat:switchBranch',
  /** Session recovery: stale session auto-heal progress events */
  CHAT_SESSION_RECOVERY: 'chat:sessionRecovery',
  /** State machine transitions — renderer mirrors backend conversation state */
  CHAT_STATE_CHANGE: 'chat:stateChange',
  /** Query current streaming state — used by renderer on conversation switch to restore streaming indicator */
  CHAT_GET_STREAMING_STATE: 'chat:getStreamingState',

  // Agents
  AGENT_GET_STATUSES: 'agent:getStatuses',
  AGENT_STATUS_UPDATE: 'agent:statusUpdate',
  AGENT_STOP_ALL: 'agent:stopAll',
  /** Strategy M: Cache efficiency metrics for dashboard */
  AGENT_CACHE_EFFICIENCY: 'agent:cacheEfficiency',

  // Agent lifecycle
  AGENT_START: 'agent:start',
  AGENT_READY: 'agent:ready',

  // Multi-workspace session management
  /** Get statuses for all workspace sessions (chat, grill, audit, MPA) */
  WORKSPACE_ALL_STATUSES: 'workspace:all-statuses',
  /** Main → Renderer: permission/blocking event from a background workspace */
  PERMISSION_REQUEST: 'permission:request',
  /** Renderer → Main: user responded to a permission request */
  PERMISSION_RESPONSE: 'permission:response',
  /** Main → Renderer: important completion or failure from a background workspace */
  COMPLETION_NOTIFICATION: 'workspace:completion',

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
  TOKEN_GET_WORKSPACE_USAGE: 'token:getWorkspaceUsage',
  TOKEN_GET_GLOBAL_USAGE: 'token:getGlobalUsage',

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
  CHECKPOINT_REWIND: 'checkpoint:rewind',
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

  // Conversation insights
  CONVERSATION_INSIGHTS: 'conversation:insights',

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

  // Embedding provider (llamafile sidecar — replaces Ollama/WASM for semantic search)
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
  SDK_TOOL_USE_SUMMARY: 'sdk:toolUseSummary',
  /** F4: LSP diagnostics from OpenCode's compiler/linter integration */
  SDK_LSP_DIAGNOSTICS: 'sdk:lspDiagnostics',

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
  AUDIT_EXPORT_PLAN_MARKDOWN: 'audit:exportPlanMarkdown',
  AUDIT_RESUME: 'audit:resume',
  AUDIT_INTERMEDIATE: 'audit:intermediate',
  AUDIT_GET_HISTORY: 'audit:getHistory',
  AUDIT_DELETE_RUN: 'audit:deleteRun',
  AUDIT_GENERATE_PLAN: 'audit:generatePlan',
  AUDIT_GET_PLANS: 'audit:getPlans',

  // Plan Hub (unified plan registry)
  PLAN_GET_ALL: 'plan:getAll',
  PLAN_GET_BY_ID: 'plan:getById',
  PLAN_UPDATE_STATUS: 'plan:updateStatus',
  PLAN_DELETE: 'plan:delete',
  PLAN_IMPORT: 'plan:import',

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
  GRILL_GENERATE_PLAN: 'grill:generatePlan',
  GRILL_GENERATE_PLAN_FROM_DECISIONS: 'grill:generatePlanFromDecisions',
  GRILL_COMPLETE: 'grill:complete',
  GRILL_SEED_PLAN_CARD: 'grill:seedPlanCard',
  GRILL_DISCARD: 'grill:discard',
  GRILL_LIST_PLANNED_IDEAS: 'grill:listPlannedIdeas',

  // Project Creation
  PROJECT_CREATE: 'project:create',
  PROJECT_CREATE_SHELL: 'project:create-shell',
  PROJECT_FINALIZE_BLUEPRINT: 'project:finalize-blueprint',
  PROJECT_DISCARD_SHELL: 'project:discard-shell',

  // External MCP Integrations
  WORKSPACE_CHECK_EXTERNAL_MCP: 'workspace:check-external-mcp',
  CHAT_UPDATE_MCP_OVERRIDES: 'chat:update-mcp-overrides',
  CHAT_UPDATE_TONE: 'chat:updateTone',

  // ask_user response — renderer → main → IPC bridge → control-actions MCP server
  CHAT_ASK_USER_RESPOND: 'chat:askUserRespond',

  // Multi-Phased Agent (MPA) Pipeline
  MPA_CANCEL: 'mpa:cancel',
  MPA_GET_STATUS: 'mpa:getStatus',
  MPA_GET_RUN: 'mpa:getRun',
  MPA_GET_HISTORY: 'mpa:getHistory',
  MPA_PHASE_START: 'mpa:phaseStart',
  MPA_PHASE_PROGRESS: 'mpa:phaseProgress',
  MPA_PHASE_COMPLETE: 'mpa:phaseComplete',
  MPA_FEEDBACK_LOOP: 'mpa:feedbackLoop',
  MPA_APPROVAL_NEEDED: 'mpa:approvalNeeded',
  MPA_APPROVAL_RESPOND: 'mpa:approvalRespond',
  MPA_PIPELINE_COMPLETE: 'mpa:complete',
  MPA_RESUME: 'mpa:resume',
  // MPA Campaigns (sequential measurable-goal runs)
  MPA_DECOMPOSE_GOALS: 'mpa:decomposeGoals',
  MPA_CAMPAIGN_START: 'mpa:campaignStart',
  MPA_CAMPAIGN_RESPOND: 'mpa:campaignRespond',
  MPA_CAMPAIGN_CANCEL: 'mpa:campaignCancel',
  MPA_CAMPAIGN_GET_HISTORY: 'mpa:campaignGetHistory',
  MPA_CAMPAIGN_GET_DETAIL: 'mpa:campaignGetDetail',
  MPA_CAMPAIGN_STARTED: 'mpa:campaignStarted',
  MPA_CAMPAIGN_GOAL_START: 'mpa:campaignGoalStart',
  MPA_CAMPAIGN_GOAL_COMPLETE: 'mpa:campaignGoalComplete',
  MPA_CAMPAIGN_PAUSED: 'mpa:campaignPaused',
  MPA_CAMPAIGN_COMPLETE: 'mpa:campaignComplete',

  // Council (LLM Council — multi-advisor review)
  COUNCIL_START: 'council:start',
  COUNCIL_CANCEL: 'council:cancel',
  COUNCIL_GET_SESSION: 'council:getSession',
  COUNCIL_MEMBER_STREAM: 'council:memberStream',
  COUNCIL_MEMBER_COMPLETE: 'council:memberComplete',
  COUNCIL_PEER_REVIEW_COMPLETE: 'council:peerReviewComplete',
  COUNCIL_VERDICT: 'council:verdict',
  COUNCIL_PHASE_CHANGED: 'council:phaseChanged',
  COUNCIL_COMPLETE: 'council:complete',
  COUNCIL_RESUME: 'council:resume',
  COUNCIL_GET_HISTORY: 'council:getHistory',
  COUNCIL_DELETE_SESSION: 'council:deleteSession',

  // ── Blueprint Pipeline ──

  BLUEPRINT_CREATE: 'blueprint:create',
  BLUEPRINT_CREATE_FROM_IDEA: 'blueprint:createFromIdea',
  BLUEPRINT_GET: 'blueprint:get',
  BLUEPRINT_GET_DETAILS: 'blueprint:getDetails',
  BLUEPRINT_LIST: 'blueprint:list',
  BLUEPRINT_DELETE: 'blueprint:delete',
  BLUEPRINT_CANCEL: 'blueprint:cancel',

  BLUEPRINT_ADVANCE_PHASE: 'blueprint:advancePhase',
  BLUEPRINT_SKIP_PHASE: 'blueprint:skipPhase',
  BLUEPRINT_REWIND_PHASE: 'blueprint:rewindPhase',
  BLUEPRINT_BUILD_PROMPT: 'blueprint:buildPrompt',
  BLUEPRINT_SAVE_ARTIFACT: 'blueprint:saveArtifact',
  BLUEPRINT_GET_ARTIFACTS: 'blueprint:getArtifacts',
  BLUEPRINT_POPULATE_TASKS: 'blueprint:populateTasks',
  BLUEPRINT_GET_PIPELINE_STATUS: 'blueprint:getPipelineStatus',

  // Blueprint phase execution (Phase 2 — Specify + Clarify)
  BLUEPRINT_START_SPECIFY: 'blueprint:startSpecify',
  BLUEPRINT_START_CLARIFY: 'blueprint:startClarify',
  BLUEPRINT_CLARIFY_ANSWER: 'blueprint:clarifyAnswer',
  BLUEPRINT_SKIP_CLARIFY: 'blueprint:skipClarify',

  // Blueprint phase execution (Phase 3 — Plan)
  BLUEPRINT_START_PLAN: 'blueprint:startPlan',

  // Blueprint phase execution (Phase 4 — Tasks)
  BLUEPRINT_START_TASKS: 'blueprint:startTasks',

  // Blueprint phase execution (Phase 5 — Review)
  BLUEPRINT_START_REVIEW: 'blueprint:startReview',

  // Blueprint phase execution (Phase 6 — Build)
  BLUEPRINT_START_BUILD: 'blueprint:startBuild',

  // Blueprint phase execution (Phase 7 — Verify)
  BLUEPRINT_START_VERIFY: 'blueprint:startVerify',

  // Blueprint streamed events (main → renderer)
  BLUEPRINT_PHASE_START: 'blueprint:phaseStart',
  BLUEPRINT_PHASE_PROGRESS: 'blueprint:phaseProgress',
  BLUEPRINT_PHASE_COMPLETE: 'blueprint:phaseComplete',
  BLUEPRINT_PHASE_ARTIFACT: 'blueprint:phaseArtifact',
  BLUEPRINT_APPROVAL_NEEDED: 'blueprint:approvalNeeded',
  BLUEPRINT_APPROVAL_RESPOND: 'blueprint:approvalRespond',

  // Blueprint wave execution events (BUILD phase)
  BLUEPRINT_WAVE_START: 'blueprint:waveStart',
  BLUEPRINT_WAVE_TASK_START: 'blueprint:waveTaskStart',
  BLUEPRINT_WAVE_TASK_COMPLETE: 'blueprint:waveTaskComplete',
  BLUEPRINT_WAVE_COMPLETE: 'blueprint:waveComplete',

  // Constitution
  BLUEPRINT_GET_CONSTITUTION: 'blueprint:getConstitution',
  BLUEPRINT_SAVE_CONSTITUTION: 'blueprint:saveConstitution'
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

/** Communication tone options for AI responses */
export const COMMUNICATION_TONES = [
  {
    id: 'default' as const,
    label: 'Default',
    description: 'Direct & concise',
    icon: 'MessageSquare'
  },
  {
    id: 'calm' as const,
    label: 'Calm & Warm',
    description: 'Supportive & patient',
    icon: 'Heart'
  },
  {
    id: 'optimistic' as const,
    label: 'Optimistic',
    description: 'Positive & upbeat',
    icon: 'Sun'
  },
  {
    id: 'brutal' as const,
    label: 'Brutally Honest',
    description: 'No sugar coating',
    icon: 'Flame'
  },
  {
    id: 'caveman' as const,
    label: 'CaveMan',
    description: 'Terse. Save tokens.',
    icon: 'Bone'
  }
] as const

/** Valid communication tone IDs for validation */
export const VALID_COMMUNICATION_TONES = COMMUNICATION_TONES.map((t) => t.id)

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
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    tier: 'opus' as const,
    description: 'Most capable'
  }
] as const

/** Default model for each configurable action */
export const DEFAULT_MODEL_CONFIG: Record<import('./types').ModelAction, string> = {
  'da-vinci': 'claude-opus-4-8',
  'da-vinci:plan': 'claude-opus-4-8',
  'da-vinci:build': 'claude-sonnet-4-6',
  'project-specialist': 'claude-opus-4-8',
  'project-specialist:plan': 'claude-opus-4-8',
  'project-specialist:build': 'claude-sonnet-4-6',
  'specialist:simple': 'claude-haiku-4-5-20251001',
  'specialist:moderate': 'claude-sonnet-4-6',
  'specialist:complex': 'claude-opus-4-8',
  memoryFeed: 'claude-haiku-4-5-20251001',
  activation: 'claude-haiku-4-5-20251001',
  haiku: 'claude-haiku-4-5-20251001',
  audit: 'claude-opus-4-8',
  grill: 'claude-opus-4-8',
  'council-member': 'claude-opus-4-8',
  'council-chairman': 'claude-opus-4-8',
  'grill:plan': 'claude-opus-4-8',
  'mpa:decompose': 'claude-opus-4-8',

  // Blueprint phase actions
  'blueprint:specify': 'claude-opus-4-8',
  'blueprint:clarify': 'claude-sonnet-4-6',
  'blueprint:plan': 'claude-opus-4-8',
  'blueprint:tasks': 'claude-opus-4-8',
  'blueprint:review': 'claude-opus-4-8',
  'blueprint:build': 'claude-sonnet-4-6',
  'blueprint:verify': 'claude-opus-4-8'
} as const

// ── Prompt Verbosity ─────────────────────────────────────────────────

/**
 * Resolve prompt verbosity based on model capability.
 * Opus 4.8+ follows compressed instructions reliably — use lean prompts.
 * Sonnet/Haiku/older models need full explicit guardrailing.
 */
export function resolvePromptVerbosity(model: string): import('./types').PromptVerbosity {
  // Opus 4.8+ can follow compressed instructions reliably
  if (model === 'claude-opus-4-8') return 'lean'
  // Future-proof: any Opus newer than 4.8 also gets lean
  if (model.startsWith('claude-opus-') && model > 'claude-opus-4-8') return 'lean'
  return 'full'
}

// ── Context Window Sizing ────────────────────────────────────────────

/**
 * Models that support 1M context windows.
 * Opus 4.8+ includes 1M at standard pricing. Sonnet models via context-1m beta.
 */
export const CONTEXT_1M_SUPPORTED_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250514',
  'claude-sonnet-4-20250514'
] as const

/** Default context window when 1M is NOT active (Haiku, older Opus ≤4.7) */
export const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000

/** Extended context window when 1M IS active (Opus 4.8+, Sonnet models) */
export const CLAUDE_1M_CONTEXT_WINDOW = 1_000_000

/**
 * Check whether a model supports 1M context.
 * Matches exact IDs from CONTEXT_1M_SUPPORTED_MODELS, any `claude-sonnet-*` prefix,
 * or Opus 4.8+ (native 1M at standard pricing).
 */
export function supportsContext1M(model: string): boolean {
  return (
    (CONTEXT_1M_SUPPORTED_MODELS as readonly string[]).includes(model) ||
    model.startsWith('claude-sonnet') ||
    model === 'claude-opus-4-8'
  )
}

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
  },
  audit: {
    label: 'Audit',
    description: 'Workspace health auditing sessions',
    icon: '🔍',
    section: 'background'
  },
  grill: {
    label: 'Grill',
    description: 'Idea grilling and evaluation sessions',
    icon: '🔥',
    section: 'background'
  },
  'grill:plan': {
    label: 'Grill (Plan Mode)',
    description: 'Plan generation for grilled ideas',
    icon: '🔥',
    section: 'background'
  },
  'council-member': {
    label: 'Council Member',
    description: 'Council advisor for multi-perspective plan review',
    icon: '🧑‍⚖️',
    section: 'background'
  },
  'council-chairman': {
    label: 'Council Chairman',
    description: 'Council synthesis and final verdict',
    icon: '🏛️',
    section: 'background'
  },
  'mpa:decompose': {
    label: 'Goal Decomposer',
    description: 'Breaks a plan into measurable goals for campaigns',
    icon: '🎯',
    section: 'background'
  },
  'blueprint:specify': {
    label: 'Blueprint Specify',
    description: 'Codebase analysis and specification generation',
    icon: '📋',
    section: 'background'
  },
  'blueprint:clarify': {
    label: 'Blueprint Clarify',
    description: 'Specification gap resolution via Q&A',
    icon: '❓',
    section: 'background'
  },
  'blueprint:plan': {
    label: 'Blueprint Plan',
    description: 'Multi-file implementation plan decomposition',
    icon: '🗺️',
    section: 'background'
  },
  'blueprint:tasks': {
    label: 'Blueprint Tasks',
    description: 'Wave-ordered task decomposition from plan',
    icon: '📝',
    section: 'background'
  },
  'blueprint:review': {
    label: 'Blueprint Review',
    description: 'Cross-artifact consistency review and quality gate',
    icon: '🔍',
    section: 'background'
  },
  'blueprint:build': {
    label: 'Blueprint Build',
    description: 'Per-task code generation and implementation',
    icon: '🏗️',
    section: 'background'
  },
  'blueprint:verify': {
    label: 'Blueprint Verify',
    description: 'Adversarial verification of build output against spec',
    icon: '✅',
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
  opus: '' // empty = adaptive-only (Opus 4.7+ removed budget_tokens — 400 error if passed)
} as const

/**
 * Maps complexity tiers to SDK effort levels.
 * Controls how much reasoning Claude applies per task.
 */
export const COMPLEXITY_TO_EFFORT = {
  simple: 'low',
  moderate: 'medium',
  complex: 'high' // Opus 4.8 at 'high' ≥ 4.7 at 'xhigh'; CLI 2.1+ supports all 5 levels natively
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
export function getModelActionForRole(
  role: AgentRole,
  mode: 'plan' | 'build' | 'danger'
): ModelAction {
  if (role === 'da-vinci') {
    // Danger mode uses the same model tier as build
    return mode === 'build' || mode === 'danger' ? 'da-vinci:build' : 'da-vinci:plan'
  }
  if (role === 'audit') {
    return 'da-vinci:plan' // Audits always use plan-tier model
  }
  return mode === 'build' || mode === 'danger'
    ? 'project-specialist:build'
    : 'project-specialist:plan'
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

/** Greenfield-relevant tracks for the Create Project wizard (5 of 8) */
export const GREENFIELD_TRACKS: GrillTrackId[] = [
  'requirements',
  'architecture',
  'ux-ui',
  'security',
  'data'
] as const

/** Pre-selected tracks when the Focus Areas step mounts */
export const GREENFIELD_DEFAULT_TRACKS: GrillTrackId[] = ['requirements', 'architecture'] as const

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

/**
 * Resolve whether a track result should count toward the overall score.
 *
 * Prefers the service-derived `applicability` when present (live runs); falls
 * back to deriving from coverage data when reading a persisted run (the field
 * is not stored in the DB). A track with no inspected files is treated as
 * not-applicable; a track that failed the coverage gate is insufficient.
 */
export function deriveApplicability(
  result: Pick<AuditResult, 'applicability' | 'coverageSufficient' | 'coverageStats' | 'status'>
): AuditApplicability {
  if (result.applicability) return result.applicability
  if (result.status !== 'completed') return 'ok'
  const fileCount = result.coverageStats?.fileCount ?? 0
  if (fileCount === 0) return 'not-applicable'
  if (result.coverageSufficient === false) return 'insufficient'
  return 'ok'
}

/**
 * Curated, selectable skills per auditor track (Deep mode). Selection is
 * persisted with the run and shown on revisit; skill *execution* in the audit
 * prompt/tools is deferred.
 */
export const AUDIT_TRACK_SKILLS: Record<AuditTrackId, AuditSkill[]> = {
  database: [
    {
      id: 'schema-design',
      name: 'Schema Design',
      description: 'Normalization, table structure, and relationships',
      icon: 'Table2'
    },
    {
      id: 'fk-integrity',
      name: 'FK & Integrity',
      description: 'Foreign keys, constraints, and referential integrity',
      icon: 'Link2'
    },
    {
      id: 'query-performance',
      name: 'Query Performance',
      description: 'N+1 queries, slow patterns, and query shape',
      icon: 'Gauge'
    },
    {
      id: 'indexing',
      name: 'Indexing',
      description: 'Index coverage and missing/duplicate indexes',
      icon: 'ListTree'
    },
    {
      id: 'migration-safety',
      name: 'Migration Safety',
      description: 'Reversibility and destructive-change detection',
      icon: 'GitBranch'
    }
  ],
  code: [
    {
      id: 'solid',
      name: 'SOLID Principles',
      description: 'Single-responsibility, coupling, and cohesion',
      icon: 'Boxes'
    },
    {
      id: 'complexity',
      name: 'Complexity',
      description: 'Cyclomatic complexity and deeply nested logic',
      icon: 'Workflow'
    },
    {
      id: 'error-handling',
      name: 'Error Handling',
      description: 'Swallowed errors and missing failure paths',
      icon: 'OctagonAlert'
    },
    {
      id: 'dead-code',
      name: 'Dead Code',
      description: 'Unused exports, unreachable code, and duplication',
      icon: 'Trash2'
    },
    {
      id: 'naming',
      name: 'Naming & Consistency',
      description: 'Naming conventions and stylistic consistency',
      icon: 'CaseSensitive'
    }
  ],
  testing: [
    {
      id: 'pyramid',
      name: 'Test Pyramid',
      description: 'Unit/integration/E2E balance',
      icon: 'Pyramid'
    },
    {
      id: 'critical-path',
      name: 'Critical Path Coverage',
      description: 'Coverage of high-risk flows',
      icon: 'Target'
    },
    {
      id: 'assertion-quality',
      name: 'Assertion Quality',
      description: 'Specific, meaningful assertions',
      icon: 'CheckCheck'
    },
    {
      id: 'fixtures',
      name: 'Fixtures & Mocks',
      description: 'Fixture quality and over-mocking',
      icon: 'Package'
    },
    {
      id: 'ci-integration',
      name: 'CI Integration',
      description: 'Tests wired into CI gates',
      icon: 'GitPullRequestArrow'
    }
  ],
  architecture: [
    {
      id: 'boundaries',
      name: 'Module Boundaries',
      description: 'Layering and boundary leakage',
      icon: 'LayoutGrid'
    },
    {
      id: 'dependency-direction',
      name: 'Dependency Direction',
      description: 'Circular and inverted dependencies',
      icon: 'ArrowLeftRight'
    },
    {
      id: 'separation',
      name: 'Separation of Concerns',
      description: 'Mixed responsibilities across layers',
      icon: 'SplitSquareHorizontal'
    },
    {
      id: 'contracts',
      name: 'API/IPC Contracts',
      description: 'Contract design and versioning',
      icon: 'FileCode2'
    },
    {
      id: 'scalability',
      name: 'Scalability Patterns',
      description: 'Bottlenecks and scaling concerns',
      icon: 'TrendingUp'
    }
  ],
  security: [
    {
      id: 'authn-authz',
      name: 'AuthN / AuthZ',
      description: 'Authentication and authorization gaps',
      icon: 'KeyRound'
    },
    {
      id: 'secret-scanning',
      name: 'Secret Scanning',
      description: 'Hardcoded secrets and credential leaks',
      icon: 'EyeOff'
    },
    {
      id: 'input-validation',
      name: 'Input Validation',
      description: 'Sanitization and injection surfaces',
      icon: 'ShieldAlert'
    },
    {
      id: 'context-isolation',
      name: 'Context Isolation',
      description: 'Electron CSP and context isolation',
      icon: 'Lock'
    },
    {
      id: 'dependency-vulns',
      name: 'Dependency Vulns',
      description: 'Vulnerable or outdated dependencies',
      icon: 'PackageX'
    }
  ],
  documentation: [
    {
      id: 'readme',
      name: 'README Quality',
      description: 'Setup, usage, and completeness',
      icon: 'BookOpen'
    },
    {
      id: 'inline-docs',
      name: 'Inline Docs',
      description: 'JSDoc/TSDoc coverage on public APIs',
      icon: 'MessageSquareText'
    },
    {
      id: 'api-docs',
      name: 'API Documentation',
      description: 'Endpoint/IPC documentation',
      icon: 'FileText'
    },
    {
      id: 'project-guide',
      name: 'Project Guide',
      description: 'CLAUDE.md / contributor guide quality',
      icon: 'Compass'
    },
    {
      id: 'decision-records',
      name: 'Decision Records',
      description: 'Changelogs and architectural decisions',
      icon: 'History'
    }
  ],
  'ui-ux': [
    {
      id: 'accessibility',
      name: 'Accessibility',
      description: 'WCAG compliance and ARIA usage',
      icon: 'Accessibility'
    },
    {
      id: 'states',
      name: 'Empty & Error States',
      description: 'Loading, empty, and error handling',
      icon: 'LoaderCircle'
    },
    {
      id: 'responsiveness',
      name: 'Responsiveness',
      description: 'Layout across viewport sizes',
      icon: 'MonitorSmartphone'
    },
    {
      id: 'consistency',
      name: 'Component Consistency',
      description: 'Reuse and visual consistency',
      icon: 'Component'
    },
    {
      id: 'keyboard-nav',
      name: 'Keyboard Navigation',
      description: 'Focus order and keyboard access',
      icon: 'Keyboard'
    }
  ]
}

// ── Council Advisors (LLM Council) ────────────────────────────────────────────

import type { CouncilAdvisorRole } from './types'

export interface CouncilAdvisorDefinition {
  id: CouncilAdvisorRole
  name: string
  icon: string
  thinkingStyle: string
  toolAccess: 'full' | 'none'
  toolGuidance: string
}

export const COUNCIL_ADVISORS: Record<CouncilAdvisorRole, CouncilAdvisorDefinition> = {
  contrarian: {
    id: 'contrarian',
    name: 'The Contrarian',
    icon: 'ShieldAlert',
    thinkingStyle:
      "Actively looks for what's wrong, what's missing, what will fail. Assumes the plan has a fatal flaw and tries to find it.",
    toolAccess: 'full',
    toolGuidance:
      "Use `find_references` on every file in scope to find hidden callers the plan doesn't account for. Use `coupling_analysis` to check if changes introduce tight coupling. Use `todo_scanner` to find existing technical debt in affected areas."
  },
  'first-principles': {
    id: 'first-principles',
    name: 'The First Principles Thinker',
    icon: 'Microscope',
    thinkingStyle:
      'Ignores the surface-level plan and asks "what are we actually trying to solve?" Strips assumptions. Rebuilds the problem from ground up. Sometimes the most valuable output is "you\'re solving the wrong problem."',
    toolAccess: 'full',
    toolGuidance:
      "Use `semantic_search` to find if the codebase already has a simpler solution to the underlying problem. Use `codebase_concepts` to understand existing patterns. Use `file_dependencies` to check if the plan's module decomposition aligns with existing architecture."
  },
  expansionist: {
    id: 'expansionist',
    name: 'The Expansionist',
    icon: 'Rocket',
    thinkingStyle:
      "Looks for upside everyone else is missing. What could be bigger? What adjacent opportunity is hiding? Doesn't care about risk (that's the Contrarian's job).",
    toolAccess: 'full',
    toolGuidance:
      'Use `similar_code` to find related patterns that could benefit from the same changes. Use `file_outline` on adjacent files to spot opportunities the plan misses. Use `codebase_concepts` to find related features that could be enhanced while making these changes.'
  },
  outsider: {
    id: 'outsider',
    name: 'The Outsider',
    icon: 'Eye',
    thinkingStyle:
      "Has zero context about the codebase, project, or history. Responds purely to what's in front of them. Catches the curse of knowledge: things obvious to the team but confusing to everyone else.",
    toolAccess: 'none',
    toolGuidance:
      "You have NO access to the codebase. You evaluate the plan purely as written. If something is unclear without context, flag it. If the plan uses jargon without explanation, flag it. If a new team member couldn't follow this plan, that's a problem."
  },
  executor: {
    id: 'executor',
    name: 'The Executor',
    icon: 'Zap',
    thinkingStyle:
      "Only cares about one thing: can this actually be done, and what's the fastest path? If the plan sounds brilliant but has no clear first step, says so.",
    toolAccess: 'full',
    toolGuidance:
      'Use `file_outline` on target files to gauge actual complexity vs what the plan claims. Use `symbol_hotspots` to find frequently-changed symbols that are risky to modify. Use `git_log` and `git_blame` on affected files to understand change velocity and ownership. Use `test_coverage_map` to verify test claims.'
  }
} as const

export const COUNCIL_ADVISOR_ROLES: CouncilAdvisorRole[] = [
  'contrarian',
  'first-principles',
  'expansionist',
  'outsider',
  'executor'
]

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

// ── Local LLM Provider ──

/** Default Ollama connection */
export const OLLAMA_DEFAULT_HOST = '127.0.0.1' as const
export const OLLAMA_DEFAULT_PORT = 11434 as const

/** Default oMLX connection (Apple Silicon native) */
export const OMLX_DEFAULT_PORT = 8000 as const

/**
 * Skill filenames that are ALWAYS injected into every prompt — DaVinci,
 * Project Specialist, and local LLM paths. These are foundational behavioral
 * guidelines, not domain-specific knowledge.
 */
export const BASELINE_SKILL_FILENAMES = ['coding-discipline'] as const

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
    description: 'Fastest option — limited quality',
    toolCallingNotes: 'Tool calls work but format compliance varies; use retry-with-repair',
    supportsParallelTools: false,
    supportsThinking: false
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
    description: 'Best balance for 8GB Macs',
    toolCallingNotes: 'Reliable tool calls; occasional JSON format issues',
    supportsParallelTools: false,
    supportsThinking: false
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
    description: 'Strong coding — fits 16GB well',
    toolCallingNotes: 'Reliable tool calls; good format compliance',
    supportsParallelTools: false,
    supportsThinking: false
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
    recommended: true,
    toolCallingNotes: 'Native tool calling with excellent format compliance',
    supportsParallelTools: true,
    supportsThinking: true
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
    description: 'Purpose-built for coding agents, 256K context',
    toolCallingNotes: 'Best local coding model; native tool calls with parallel support',
    supportsParallelTools: true,
    supportsThinking: true
  },
  {
    ollamaId: 'deepseek-coder-v3:latest',
    label: 'DeepSeek Coder V3',
    parameterSize: '236B MoE',
    activeParams: '37B',
    contextWindow: 131072,
    minMemoryGB: 32,
    memoryTier: '32gb',
    toolCalling: 'good',
    description: 'Strong reasoning; slightly weaker tool format',
    toolCallingNotes: 'Good tool calling but JSON format compliance varies; use repair loop',
    supportsParallelTools: false,
    supportsThinking: true
  },
  {
    ollamaId: 'llama4-scout:17b',
    label: 'Llama 4 Scout 17B',
    parameterSize: '17B',
    contextWindow: 131072,
    minMemoryGB: 16,
    memoryTier: '16gb',
    toolCalling: 'basic',
    description: 'Tool calls work but format compliance varies',
    toolCallingNotes: 'Basic tool calling; format issues common — retry-with-repair recommended',
    supportsParallelTools: false,
    supportsThinking: false
  },
  {
    ollamaId: 'gemma3:27b',
    omlxId: 'mlx-community/gemma-3-27b-it-4bit',
    label: 'Gemma 3 27B',
    parameterSize: '27B',
    contextWindow: 131072,
    minMemoryGB: 20,
    memoryTier: '32gb',
    toolCalling: 'none',
    description: 'No tool calling; analysis and chat only',
    toolCallingNotes: 'No tool calling support — use in analysis-only mode with manual RAG',
    supportsParallelTools: false,
    supportsThinking: false
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
    description: 'Best local coding quality — needs 64GB+',
    toolCallingNotes: 'Excellent tool calling with native parallel support',
    supportsParallelTools: true,
    supportsThinking: true
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
    description: 'Google alternative — MLX native',
    toolCallingNotes: 'Native tool calling support; reliable format',
    supportsParallelTools: true,
    supportsThinking: false
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
 * Check if a model supports tool calling (quality > 'none').
 * Used by the smart backend selector to decide between the
 * EnhancedLocalAgentLoop (with MCP tools) and analysis-only mode.
 */
export function modelSupportsToolCalling(model: import('./types').RecommendedLocalModel): boolean {
  return model.toolCalling !== 'none'
}

/**
 * Find a recommended model by its Ollama or oMLX ID.
 * Returns undefined for unknown models (conservative fallback).
 */
export function findRecommendedModel(
  modelId: string
): import('./types').RecommendedLocalModel | undefined {
  return RECOMMENDED_LOCAL_MODELS.find((m) => m.ollamaId === modelId || m.omlxId === modelId)
}

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
  /** Known absolute install paths (checked when command isn't on PATH) */
  commandPaths?: string[]
  /** Env vars always injected when this MCP is mounted (perf tuning, not user-supplied) */
  performanceEnv?: Record<string, string>
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
    commandPaths: ['~/.maestro/bin/maestro'],
    envKeys: ['JAVA_HOME', 'MAESTRO_CLOUD_API_KEY'],
    performanceEnv: {
      // Disable idle settle detection — Expo/RN apps have constant JS bridge activity
      // that causes Maestro to wait 10-15s per step thinking the UI hasn't settled.
      // Flows should use explicit assertVisible sync points instead.
      MAESTRO_WAIT_TIMEOUT: '0'
    },
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

// ── Llamafile Embedding Sidecar ──────────────────────────────────────────────
//
// Code-search embeddings run through a downloaded llamafile server (native,
// multi-threaded, GPU-capable) instead of in-process WASM. Both the engine
// binary and the GGUF model are downloaded on first use (not bundled) and
// pinned by SHA-256.
//
// Pins verified 2026-06-01 against the GitHub release + Hugging Face APIs.
// To upgrade: bump the version/file, then update `sha256` + `sizeBytes` from
//   - GitHub:  https://api.github.com/repos/mozilla-ai/llamafile/releases/latest (asset.digest)
//   - HF:      https://huggingface.co/api/models/<repo>?blobs=true (siblings[].lfs.sha256)
export const LLAMAFILE_EMBEDDING = {
  /** Downloaded llamafile engine binary (Actually-Portable-Executable). */
  engine: {
    version: '0.10.2',
    /** `-thin` build: ~44MB, no prebuilt GPU dylibs (CPU/Metal is plenty for embeddings). */
    asset: 'llamafile-0.10.2-thin',
    url: 'https://github.com/mozilla-ai/llamafile/releases/download/0.10.2/llamafile-0.10.2-thin',
    sha256: '53c638390ba9b49b034615a7e9e3bfa00995f576e7730506d7f7e434ab8684e9',
    sizeBytes: 44118372
  },
  /** Downloaded GGUF embedding model (nomic-embed-text-v1.5, 768-dim). */
  model: {
    file: 'nomic-embed-text-v1.5.Q4_K_M.gguf',
    url: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf',
    sha256: 'd4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac',
    sizeBytes: 84106624,
    /**
     * Provenance string stored in indexing_state.embedding_model. Changing this
     * triggers the existing model-change re-index in vector-search.service.ts.
     */
    modelName: 'nomic-embed-text-v1.5'
  },
  /** llamafile server launch + request defaults. */
  server: {
    host: '127.0.0.1',
    /** mean pooling + L2 normalize matches the prior WASM pipeline's output shape. */
    pooling: 'mean',
    embdNormalize: '2',
    /** Max seconds to wait for the spawned server to report healthy. */
    healthTimeoutSec: 60,
    /**
     * Defensive per-input character cap. nomic-embed-text-v1.5's context is
     * 2048 tokens and llama.cpp `/v1/embeddings` ERRORS (not truncates) on
     * over-length input. ~8000 chars ≈ ~2000 tokens, restoring the prior
     * "never hard-fail on a big chunk" behavior. A char cap is sufficient here
     * — no tokenizer needed.
     */
    maxInputChars: 8000
  }
} as const
