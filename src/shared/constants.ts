import type { CredentialFieldDef } from './integration-credentials.types'
import type {
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
  CHAT_RENAME: 'chat:renameConversation',
  CHAT_STOP: 'chat:stop',
  CHAT_COMPACT: 'chat:compact',
  CHAT_ASK_QUESTION: 'chat:askQuestion',
  CHAT_COMPLETE: 'chat:complete',
  CHAT_CLOSE: 'chat:close',
  CHAT_GET_FILE_CHANGES: 'chat:getFileChanges',
  CHAT_GET_TODOS: 'chat:getTodos',
  PLAN_GET_PHASE_PROGRESS: 'plan:getPhaseProgress',
  CHAT_SWITCH_BRANCH: 'chat:switchBranch',
  /** Branches a new chat may pick from, with who currently holds each one. */
  CHAT_BRANCH_OPTIONS: 'chat:branchOptions',
  /** Session recovery: stale session auto-heal progress events */
  CHAT_SESSION_RECOVERY: 'chat:sessionRecovery',
  /** State machine transitions — renderer mirrors backend conversation state */
  CHAT_STATE_CHANGE: 'chat:stateChange',
  /** Query current streaming state — used by renderer on conversation switch to restore streaming indicator */
  CHAT_GET_STREAMING_STATE: 'chat:getStreamingState',
  /** Manual escape hatch — force-release a conversation wedged in a busy state */
  CHAT_FORCE_RELEASE: 'chat:forceRelease',
  /** Set a /goal condition for the next send on a conversation */
  CHAT_SET_GOAL: 'chat:setGoal',

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
  /** Main → Renderer: a permission request reached a terminal state (approved/denied/timedout/cancelled) */
  PERMISSION_RESOLVED: 'permission:resolved',
  /** Main → Renderer: important completion or failure from a background workspace */
  COMPLETION_NOTIFICATION: 'workspace:completion',
  /** Main → Renderer: navigate to workspace + page after OS notification click */
  NOTIFICATION_NAVIGATE: 'notification:navigate',
  /** Renderer → Main: probe macOS notification support (unsigned build detection) */
  NOTIFICATION_PROBE: 'notification:probe',

  // Background processes (process-manager MCP server)
  /** Renderer → Main: list tracked background processes across all workspaces */
  PROCESS_LIST: 'process:list',
  /** Renderer → Main: stop a background process (SIGTERM → SIGKILL) */
  PROCESS_STOP: 'process:stop',
  /** Renderer → Main: cancel the auto-resume watch on a background process */
  PROCESS_CANCEL_WATCH: 'process:cancelWatch',
  /** Main → Renderer: background process list changed (started/exited/stopped) */
  PROCESS_CHANGED: 'process:changed',

  // Work tracks (branch + worktree + owner)
  /** Renderer → Main: list a workspace's tracks with filesystem facts + disk budget */
  TRACK_LIST: 'track:list',
  /** Renderer → Main: destroy a track and everything uncommitted in it */
  TRACK_DISCARD: 'track:discard',
  /** Renderer → Main: open a track's worktree in Finder/Explorer */
  TRACK_REVEAL: 'track:reveal',
  /** Renderer → Main: hand retained work to a new chat */
  TRACK_ADOPT: 'track:adopt',
  /** Renderer → Main: land a track's work — PR, or merge into the integration branch */
  TRACK_LAND: 'track:land',
  /**
   * Renderer → Main: what landing this track WOULD do. Read-only — no commit,
   * no push, no merge. Backs the landing dialog's conflict forecast.
   */
  TRACK_LAND_PREVIEW: 'track:landPreview',
  /**
   * Main → Renderer: a workspace's track list changed (created, retained,
   * removed, adopted, reaped). `workspaceId` is null when the change spanned
   * workspaces (the reaper), meaning "refresh regardless".
   */
  TRACK_CHANGED: 'track:changed',
  /** Main → Renderer: navigate to workspace/page after tray menu click */
  TRAY_NAVIGATE: 'tray:navigate',

  // Dialog
  DIALOG_SELECT_DIRECTORY: 'dialog:selectDirectory',
  SAVE_CLIPBOARD_IMAGE: 'dialog:saveClipboardImage',
  READ_IMAGE_BASE64: 'dialog:readImageBase64',
  /** Copy a dropped image into a draft-scoped staging dir so it can be previewed */
  STAGE_IMAGE_FILE: 'dialog:stageImageFile',
  /** Delete a whole staging scope (draft cancelled or committed) */
  CLEAR_STAGED_IMAGES: 'dialog:clearStagedImages',

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

  // Memory Engine (knowledge-aware facts)
  MEMORY_FACTS_LIST: 'memory:facts:list',
  MEMORY_FACTS_SEARCH: 'memory:facts:search',
  MEMORY_FACTS_GET: 'memory:facts:get',
  MEMORY_FACTS_UPDATE: 'memory:facts:update',
  MEMORY_FACTS_ARCHIVE: 'memory:facts:archive',
  MEMORY_FACTS_CONFIRM: 'memory:facts:confirm',
  MEMORY_FACTS_PROMOTE: 'memory:facts:promote',
  MEMORY_FACTS_SCOPE_TOGGLE: 'memory:facts:scopeToggle',
  MEMORY_FACTS_DELETE: 'memory:facts:delete',

  // Memory contradictions
  MEMORY_CONTRADICTIONS_LIST: 'memory:contradictions:list',
  MEMORY_CONTRADICTIONS_RESOLVE: 'memory:contradictions:resolve',

  // Memory capture settings
  MEMORY_CAPTURE_SETTINGS_GET: 'memory:capture:settingsGet',
  MEMORY_CAPTURE_SETTINGS_SET: 'memory:capture:settingsSet',

  // Memory embedding status
  MEMORY_EMBEDDING_STATUS: 'memory:embedding:status',
  MEMORY_EMBEDDING_BACKFILL: 'memory:embedding:backfill',
  MEMORY_EMBEDDING_PROGRESS: 'memory:embedding:progress',
  MEMORY_DEDUP_SCAN: 'memory:dedup:scan',
  MEMORY_DEDUP_AUTORESOLVE: 'memory:dedup:autoresolve',
  MEMORY_CONSOLIDATE: 'memory:consolidate',
  MEMORY_READ_CLAUDE_MD: 'memory:readClaudeMd',

  // Memory feed (retained: doc feed + CLAUDE.md regeneration)
  MEMORY_FEED_DOCUMENT: 'memory:feedDocument',
  MEMORY_FEED_PROGRESS: 'memory:feedProgress',
  MEMORY_FEED_CANCEL: 'memory:feedCancel',
  MEMORY_SELECT_DOCUMENT: 'memory:selectDocument',
  MEMORY_REGENERATE_CLAUDE_MD: 'memory:regenerateClaudeMd',
  MEMORY_PROJECT_EXPORT: 'memory:project:export',

  // Reflection review queue (synthesised parent facts awaiting approval)
  MEMORY_REFLECTION_LIST: 'memory:reflection:list',
  MEMORY_REFLECTION_APPROVE: 'memory:reflection:approve',
  MEMORY_REFLECTION_REJECT: 'memory:reflection:reject',
  MEMORY_REFLECTION_RUN: 'memory:reflection:run',
  MEMORY_SAVE_MESSAGE: 'memory:saveMessage',
  MEMORY_SAVE_PLAN_EXECUTION: 'memory:savePlanExecution',

  // Memory document ingestion
  MEMORY_INGEST_DOCUMENTS: 'memory:ingest:documents',
  MEMORY_INGEST_CANCEL: 'memory:ingest:cancel',
  MEMORY_INGEST_PROGRESS: 'memory:ingest:progress',
  MEMORY_INGEST_DISCOVER: 'memory:ingest:discover',
  MEMORY_INGEST_SELECT_FILES: 'memory:ingest:selectFiles',
  MEMORY_INGEST_SELECT_FOLDER: 'memory:ingest:selectFolder',

  // Memory bootstrap (project knowledge bootstrap)
  MEMORY_BOOTSTRAP_START: 'memory:bootstrap:start',
  MEMORY_BOOTSTRAP_CANCEL: 'memory:bootstrap:cancel',
  MEMORY_BOOTSTRAP_PROGRESS: 'memory:bootstrap:progress',
  MEMORY_BOOTSTRAP_PAUSE: 'memory:bootstrap:pause',
  MEMORY_BOOTSTRAP_RESUME: 'memory:bootstrap:resume',
  MEMORY_BOOTSTRAP_SNAPSHOT: 'memory:bootstrap:snapshot',
  MEMORY_BOOTSTRAP_LIST_RUNS: 'memory:bootstrap:listRuns',
  MEMORY_BOOTSTRAP_LIST_ITEMS: 'memory:bootstrap:listItems',

  // Memory graph (knowledge graph visualization)
  MEMORY_GRAPH_GET: 'memory:graph:get',

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
  UPDATE_STAGING: 'update:staging',
  UPDATE_DOWNLOADED: 'update:downloaded',
  UPDATE_ERROR: 'update:error',
  /** The install was dispatched but the app is still running — retryable, unlike UPDATE_ERROR. */
  UPDATE_INSTALL_FAILED: 'update:installFailed',
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
  REPO_LIST_BRANCHES: 'repo:listBranches',
  REPO_GET_REF_FILE_DETAILS: 'repo:getRefFileDetails',
  REPO_GET_REF_FILE_DIFF: 'repo:getRefFileDiff',
  REPO_FETCH_ORIGIN: 'repo:fetchOrigin',

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
  SUBSCRIPTION_CHECK_OPENCODE_CLI: 'subscription:checkOpenCodeCli',
  SUBSCRIPTION_AUTO_CONFIGURE: 'subscription:autoConfigure',

  // Embedding provider (oMLX — user must have oMLX running with an embedding model)
  EMBEDDING_CHECK_STATUS: 'embedding:checkStatus',
  EMBEDDING_INITIALIZE: 'embedding:initialize',
  EMBEDDING_MODEL_READY: 'embedding:modelReady',
  EMBEDDING_MODEL_ERROR: 'embedding:modelError',
  /** Live runtime state of embeddings + chat routing (what is loaded, not what is saved) */
  MODELS_RUNTIME_STATUS: 'models:runtimeStatus',

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
  INDEXING_PREFLIGHT_EXCLUSIONS: 'indexing:preflightExclusions',
  INDEXING_APPLY_EXCLUSIONS: 'indexing:applyExclusions',

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

  // Stream Diagnostics — aggregated streaming health metrics
  STREAM_METRICS_GET: 'stream:metricsGet',

  // IPC Backpressure — renderer ACK for adaptive batching
  CHAT_CHUNK_ACK: 'chat:chunkAck',

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
  BUG_EXPORT_MARKDOWN: 'bug:exportMarkdown',

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
  AUDIT_HANDOFF_TO_CHAT: 'audit:handoffToChat',
  AUDIT_HANDOFF_TO_BLUEPRINT: 'audit:handoffToBlueprint',
  AUDIT_RECORD_FINDING_HANDOFF: 'audit:recordFindingHandoff',
  AUDIT_GET_FINDING_HANDOFFS: 'audit:getFindingHandoffs',

  // Plan Hub (unified plan registry)
  PLAN_GET_ALL: 'plan:getAll',
  PLAN_GET_BY_ID: 'plan:getById',
  PLAN_UPDATE_STATUS: 'plan:updateStatus',
  PLAN_DELETE: 'plan:delete',
  PLAN_IMPORT: 'plan:import',
  PLAN_GET_STATUS_HISTORY: 'plan:getStatusHistory',
  PLAN_FIND_BY_SOURCE: 'plan:findBySource',

  // UltraPlan (CLI teleport-back response)
  ULTRAPLAN_RESPOND: 'ultraplan:respond',

  // Autofix PR (CI/review-driven fix run)
  AUTOFIX_PR_START: 'autofixPr:start',
  AUTOFIX_PR_STATUS: 'autofixPr:status',

  // BTW (side-question answered against conversation context)
  CHAT_BTW: 'chat:btw',

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
  INTEGRATION_SAVE_CREDENTIALS: 'integration:saveCredentials',
  INTEGRATION_GET_CREDENTIAL_STATUS: 'integration:getCredentialStatus',
  INTEGRATION_TEST_CONNECTION: 'integration:testConnection',
  INTEGRATION_CLEAR_CREDENTIALS: 'integration:clearCredentials',

  // Jira tickets panel — direct REST, independent of the MCP server
  JIRA_SEARCH_ISSUES: 'jira:searchIssues',
  JIRA_GET_ISSUE: 'jira:getIssue',
  JIRA_ADD_COMMENT: 'jira:addComment',
  JIRA_CREATE_BLUEPRINTS: 'jira:createBlueprints',
  JIRA_LIST_PROJECTS: 'jira:listProjects',
  JIRA_LIST_BOARDS: 'jira:listBoards',
  JIRA_LIST_SPRINTS: 'jira:listSprints',
  JIRA_CONVERTED_KEYS: 'jira:convertedKeys',
  JIRA_ASSIGN_TO_ME: 'jira:assignToMe',
  JIRA_LIST_TRANSITIONS: 'jira:listTransitions',
  JIRA_TRANSITION_ISSUE: 'jira:transitionIssue',
  CHAT_UPDATE_MCP_OVERRIDES: 'chat:update-mcp-overrides',
  CHAT_UPDATE_TONE: 'chat:updateTone',
  CHAT_UPDATE_ROUTING: 'chat:updateRouting',

  CHAT_SET_PLAN_ACTION: 'chat:setPlanAction',

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
  BLUEPRINT_BRANCH_OPTIONS: 'blueprint:branchOptions',
  BLUEPRINT_CREATE_FROM_IDEA: 'blueprint:createFromIdea',
  BLUEPRINT_GET: 'blueprint:get',
  BLUEPRINT_GET_DETAILS: 'blueprint:getDetails',
  BLUEPRINT_LIST: 'blueprint:list',
  /** Edit a draft's title / description / attachments before the pipeline runs. */
  BLUEPRINT_UPDATE: 'blueprint:update',
  BLUEPRINT_DELETE: 'blueprint:delete',
  BLUEPRINT_CANCEL: 'blueprint:cancel',
  /** Hand a finished blueprint — its branch, worktree and context — to a new chat. */
  BLUEPRINT_HANDOFF_TO_CHAT: 'blueprint:handoffToChat',
  /** Who holds the blueprint's branch, so the handoff UI can offer a real choice. */
  BLUEPRINT_HANDOFF_OPTIONS: 'blueprint:handoffOptions',

  BLUEPRINT_ADVANCE_PHASE: 'blueprint:advancePhase',
  BLUEPRINT_SKIP_PHASE: 'blueprint:skipPhase',
  /** Per-task user skip — survives retry (BP-TASK-USER-SKIP-01). */
  BLUEPRINT_SKIP_TASK: 'blueprint:skipTask',
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
  BLUEPRINT_CLARIFY_AWAITING_INPUT: 'blueprint:clarifyAwaitingInput',
  BLUEPRINT_CLARIFY_FINDINGS: 'blueprint:clarifyFindings',
  BLUEPRINT_CLARIFY_QUESTIONS: 'blueprint:clarifyQuestions',
  BLUEPRINT_CLARIFY_GATE: 'blueprint:clarifyGate',
  BLUEPRINT_CLARIFY_PROCEED: 'blueprint:clarifyProceed',
  BLUEPRINT_CLARIFY_ITERATE: 'blueprint:clarifyIterate',

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
  BLUEPRINT_SAVE_CONSTITUTION: 'blueprint:saveConstitution',
  BLUEPRINT_RETRY_PHASE: 'blueprint:retryPhase',
  BLUEPRINT_ACKNOWLEDGE_REVIEW: 'blueprint:acknowledgeReview',

  // Blueprint snapshot sync (M2 — whole-state snapshot)
  BLUEPRINT_STATE_SYNC: 'blueprint:stateSync',

  // Blueprint transcript (M3 — persist + rehydrate)
  BLUEPRINT_GET_TRANSCRIPT: 'blueprint:getTranscript',

  // Blueprint snapshot (M7 — pull-based seed on mount/workspace switch)
  BLUEPRINT_GET_SNAPSHOT: 'blueprint:getSnapshot',

  // Blueprint preflight (environment validation before BUILD)
  BLUEPRINT_PREFLIGHT_RUN: 'blueprint:preflightRun',
  BLUEPRINT_PREFLIGHT_RESULT: 'blueprint:preflightResult',

  // E2E Testing
  TESTING_LIST_SCENARIOS: 'testing:listScenarios',
  TESTING_PREFLIGHT: 'testing:preflight',
  TESTING_RUN: 'testing:run',
  TESTING_REQUEUE_FAILED: 'testing:requeueFailed',
  TESTING_RESUME_RUN: 'testing:resumeRun',
  TESTING_CANCEL: 'testing:cancel',
  TESTING_GET_RUNS: 'testing:getRuns',
  TESTING_GET_RUN_RESULTS: 'testing:getRunResults',
  TESTING_GET_RESULT_DETAIL: 'testing:getResultDetail',
  TESTING_PROGRESS: 'testing:progress',

  // Unified Handoff Protocol
  HANDOFF_CREATE: 'handoff:create',
  HANDOFF_EXECUTE: 'handoff:execute',
  HANDOFF_ACCEPT: 'handoff:accept',
  HANDOFF_REJECT: 'handoff:reject',
  HANDOFF_GET_HISTORY: 'handoff:getHistory',
  HANDOFF_GET_CHAIN: 'handoff:getChain',
  HANDOFF_PREVIEW: 'handoff:preview'
} as const

/** Attribution trailer appended to commits made through the app UI. */
export const COMMIT_ATTRIBUTION = '✨ Generated with Code Atelier'

/** Model used for activation CLAUDE.md generation (structured output — Haiku-tier) */
export const ACTIVATION_MODEL_ID = 'claude-haiku-4-5-20251001' as const

/**
 * @deprecated Use 'specialist' directly. Kept for backward-compat in older DB rows
 * and migration code. New code should not reference this constant.
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
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    tier: 'sonnet' as const,
    description: 'Balanced performance'
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    tier: 'opus' as const,
    description: 'Most capable'
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    tier: 'fable' as const,
    description: 'Frontier — long-horizon reasoning'
  }
] as const

/** Default model for each configurable action */
export const DEFAULT_MODEL_CONFIG: Record<import('./types').ModelAction, string> = {
  specialist: 'claude-opus-5',
  'specialist:plan': 'claude-opus-5',
  'specialist:build': 'claude-opus-5',
  'specialist:simple': 'claude-haiku-4-5-20251001',
  'specialist:moderate': 'claude-sonnet-5',
  'specialist:complex': 'claude-opus-5',
  memoryFeed: 'claude-haiku-4-5-20251001',
  activation: 'claude-haiku-4-5-20251001',
  haiku: 'claude-haiku-4-5-20251001',
  audit: 'claude-opus-5',
  grill: 'claude-opus-5',
  'council-member': 'claude-opus-5',
  'council-chairman': 'claude-opus-5',
  'grill:plan': 'claude-opus-5',
  'mpa:decompose': 'claude-opus-5',

  // Blueprint phase actions
  'blueprint:specify': 'claude-opus-5',
  'blueprint:clarify': 'claude-sonnet-5',
  'blueprint:plan': 'claude-opus-5',
  'blueprint:tasks': 'claude-opus-5',
  'blueprint:review': 'claude-opus-5',
  'blueprint:build': 'claude-opus-5',
  'blueprint:verify': 'claude-opus-5',

  // Prompt optimization
  'prompt:optimize': 'claude-haiku-4-5-20251001',

  // Background one-shot actions
  'commit-message': 'claude-haiku-4-5-20251001',
  'pr-description': 'claude-haiku-4-5-20251001',
  condense: 'claude-haiku-4-5-20251001'
} as const

// ── Role Groups (retained for Phase 2 role assignments) ──

import type { ActionGroup } from './types'

/**
 * Logical groupings of ModelActions for model role assignment UI.
 * Each group can be configured independently in the future role matrix.
 */
export const ACTION_GROUPS: ActionGroup[] = [
  {
    id: 'chat',
    label: 'Chat',
    icon: '💬',
    description: 'Plan & Build mode conversations',
    providerConstrained: true,
    actions: ['specialist', 'specialist:plan', 'specialist:build']
  },
  {
    id: 'blueprint',
    label: 'Blueprint',
    icon: '📐',
    description: 'Specification, planning, and code generation phases',
    actions: [
      'blueprint:specify',
      'blueprint:clarify',
      'blueprint:plan',
      'blueprint:tasks',
      'blueprint:review',
      'blueprint:build',
      'blueprint:verify'
    ]
  },
  {
    id: 'quality',
    label: 'Quality & Review',
    icon: '🩺',
    description: 'Audit and adversarial grill sessions',
    actions: ['audit', 'grill', 'grill:plan']
  },
  {
    id: 'council',
    label: 'Council',
    icon: '🧑‍⚖️',
    description: 'Multi-advisor code review council',
    actions: ['council-member', 'council-chairman']
  },
  {
    id: 'background',
    label: 'Background Tasks',
    icon: '⚙️',
    description: 'Memory extraction, prompt optimization, and lightweight tasks',
    actions: [
      'memoryFeed',
      'activation',
      'haiku',
      'prompt:optimize',
      'commit-message',
      'pr-description',
      'condense'
    ]
  },
  {
    id: 'specialist',
    label: 'Specialist Routing',
    icon: '🎯',
    description: 'Complexity-based model routing for specialists',
    advanced: true,
    actions: ['specialist:simple', 'specialist:moderate', 'specialist:complex']
  },
  {
    id: 'decomposition',
    label: 'Decomposition',
    icon: '🧩',
    description: 'MPA goal decomposition',
    advanced: true,
    actions: ['mpa:decompose']
  }
] as const

// ── Role → ModelAction Mapping ──────────────────────────────────────

/**
 * Maps AgentRoles whose ModelAction doesn't follow the `${role}:${mode}` convention.
 * Blueprint phases map to `blueprint:*` actions (mode is irrelevant — each phase IS its action).
 * MPA phases ride on specialist plan/build tiers.
 */
const FIXED_ROLE_ACTIONS: Partial<
  Record<import('./types').AgentRole, import('./types').ModelAction>
> = {
  'blueprint-specify': 'blueprint:specify',
  'blueprint-clarify': 'blueprint:clarify',
  'blueprint-plan': 'blueprint:plan',
  'blueprint-tasks': 'blueprint:tasks',
  'blueprint-review': 'blueprint:review',
  'blueprint-build': 'blueprint:build',
  'blueprint-verify': 'blueprint:verify',
  // Mode-independent session roles (always plan mode)
  audit: 'audit',
  grill: 'grill',
  'council-member': 'council-member',
  'council-chairman': 'council-chairman'
}

/**
 * MPA roles use specialist tiers for model resolution.
 * Planner/verifier share plan-tier; builder uses build-tier.
 */
const MPA_ROLE_ACTIONS: Partial<
  Record<
    import('./types').AgentRole,
    { plan: import('./types').ModelAction; build: import('./types').ModelAction }
  >
> = {
  'mpa-planner': { plan: 'specialist:plan', build: 'specialist:plan' },
  'mpa-builder': { plan: 'specialist:build', build: 'specialist:build' },
  'mpa-verifier': { plan: 'specialist:plan', build: 'specialist:plan' }
}

/**
 * Resolve the correct ModelAction for a given AgentRole and execution mode.
 *
 * - Blueprint phases → fixed `blueprint:*` action (mode-independent)
 * - MPA phases → specialist plan/build tiers
 * - Standard roles (specialist, etc.) → `${role}:${mode}`
 */
export function resolveModelAction(
  role: import('./types').AgentRole,
  isBuildMode: boolean
): import('./types').ModelAction {
  // Blueprint phases have their own ModelAction — mode is irrelevant
  const fixed = FIXED_ROLE_ACTIONS[role]
  if (fixed) return fixed

  // MPA phases map to specialist tiers
  const mpa = MPA_ROLE_ACTIONS[role]
  if (mpa) return mpa[isBuildMode ? 'build' : 'plan']

  // Standard roles: ${role}:${plan|build}
  return `${role}:${isBuildMode ? 'build' : 'plan'}` as import('./types').ModelAction
}

// ── Prompt Verbosity ─────────────────────────────────────────────────

/**
 * Resolve prompt verbosity based on model capability.
 * Opus 4.8+ and Sonnet 4.6+ follow compressed instructions reliably — use lean prompts.
 * Haiku and older models need full explicit guardrailing.
 */
export function resolvePromptVerbosity(model: string): import('./types').PromptVerbosity {
  // Fable 5 — frontier model, lean prompts
  if (model.startsWith('claude-fable-')) return 'lean'
  // Opus 5+ — lean prompts
  if (model === 'claude-opus-5') return 'lean'
  // Opus 4.8 (legacy) also gets lean
  if (model === 'claude-opus-4-8') return 'lean'
  // Future-proof: any Opus newer than 5 also gets lean
  if (model.startsWith('claude-opus-') && model > 'claude-opus-5') return 'lean'
  // Sonnet 4.6+ follows lean instructions effectively — saves ~800-1200 tokens/turn
  if (model.startsWith('claude-sonnet-') && model >= 'claude-sonnet-4-6') return 'lean'
  return 'full'
}

// ── Context Window Sizing ────────────────────────────────────────────

/**
 * Models that support 1M context windows.
 * Opus 4.8+ includes 1M at standard pricing. Sonnet models via context-1m beta.
 */
export const CONTEXT_1M_SUPPORTED_MODELS = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250514',
  'claude-sonnet-4-20250514'
] as const

/** Default context window when 1M is NOT active (Haiku, older Opus ≤4.7) */
export const CLAUDE_DEFAULT_CONTEXT_WINDOW = 200_000

/** Extended context window when 1M IS active (Opus 4.8+, Sonnet models) */
export const CLAUDE_1M_CONTEXT_WINDOW = 1_000_000

/**
 * Context-compaction band ratios, as a fraction of the effective context window.
 * Uniform across all Claude window sizes (200K and 1M) — attention degrades on
 * proportion of window filled, not absolute token count, so a 1M model at 85%
 * is no healthier than a 200K model at 85%.
 *
 * Consumed by compaction-policy.ts (thresholds + CLI env), ipc/context-usage-level.ts
 * (badge colour), and the renderer's processContextUsageUpdate. Keep them in sync
 * by importing from here — do NOT re-hardcode.
 */
export const COMPACTION_RATIOS = {
  /** Badge turns yellow. Matches classifyCompaction's internal 0.8 × suggest. */
  warn: 0.48,
  /** Modal offers Extract Nuance / Quick Compact. */
  suggest: 0.6,
  /** App auto band + the CLI's own auto-compact trigger. */
  auto: 0.75,
  /** Safety net: CLI demonstrably failed to compact — force the modal. */
  critical: 0.9
} as const

/** critical ÷ auto — lets classifyCompaction derive the ceiling without new state. */
export const AUTO_TO_CRITICAL_MULTIPLIER = COMPACTION_RATIOS.critical / COMPACTION_RATIOS.auto // 1.2

/**
 * Check whether a model supports 1M context.
 * Matches exact IDs from CONTEXT_1M_SUPPORTED_MODELS, any `claude-sonnet-*` prefix,
 * or Opus 4.8+ (native 1M at standard pricing).
 */
export function supportsContext1M(model: string): boolean {
  return (
    (CONTEXT_1M_SUPPORTED_MODELS as readonly string[]).includes(model) ||
    model.startsWith('claude-sonnet') ||
    model === 'claude-opus-5' ||
    model === 'claude-opus-4-8'
  )
}

/**
 * Models whose 1M window requires the legacy `context-1m-2025-08-07` beta
 * header, which the CLI accepts for API-key logins only. Current-generation
 * models (Opus 5, Sonnet 5, Fable 5) have native 1M and must NOT be gated —
 * gating them silently downgrades the session to 200K on a Max/OAuth login.
 */
export const CONTEXT_1M_REQUIRES_BETA = [
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250514',
  'claude-sonnet-4-20250514'
] as const

/** Whether a model's 1M window is gated behind the API-key-only beta header. */
export function requiresContext1MBeta(model: string): boolean {
  return (CONTEXT_1M_REQUIRES_BETA as readonly string[]).includes(model)
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
  specialist: {
    label: 'Agent',
    description: 'Chat agent that handles conversations',
    icon: '💬',
    section: 'agent'
  },
  'specialist:plan': {
    label: 'Agent (Plan Mode)',
    description: 'Model for thinking, planning, and general Q&A',
    icon: '🧠',
    section: 'agent'
  },
  'specialist:build': {
    label: 'Agent (Build Mode)',
    description: 'Model for code writing and execution orchestration',
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
  },
  'prompt:optimize': {
    label: 'Prompt Optimizer',
    description: 'Rewrites chat prompts for clarity before sending',
    icon: '✨',
    section: 'background'
  },
  'commit-message': {
    label: 'Commit Message',
    description: 'Generate git commit messages from diffs',
    icon: '📦',
    section: 'background'
  },
  'pr-description': {
    label: 'PR Description',
    description: 'Generate pull request descriptions from conversation context',
    icon: '📝',
    section: 'background'
  },
  condense: {
    label: 'Conversation Condense',
    description: 'Compress conversation context before compaction',
    icon: '🗜️',
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
  sonnet: '', // empty = adaptive-only (Sonnet 5 removed budget_tokens — 400 error if passed)
  opus: '' // empty = adaptive-only (Opus 5 uses adaptive thinking; budget_tokens not supported)
} as const

/**
 * Maps complexity tiers to SDK effort levels.
 * Controls how much reasoning Claude applies per task.
 */
export const COMPLEXITY_TO_EFFORT = {
  simple: 'low',
  moderate: 'medium',
  complex: 'high' // Opus 5 at 'high' — same default as API; CLI 2.1+ supports all 5 levels natively
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
 */
export function getModelActionForRole(
  _role: 'specialist',
  mode: 'plan' | 'build' | 'danger'
): ModelAction {
  return mode === 'build' || mode === 'danger' ? 'specialist:build' : 'specialist:plan'
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
      "Use `find_references` on every file in scope to find hidden callers the plan doesn't account for. Use `coupling_analysis` to check if changes introduce tight coupling. Use `audit_scan` to find existing technical debt in affected areas."
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
      'Use `file_outline` on target files to gauge actual complexity vs what the plan claims. Use `symbol_hotspots` to find frequently-changed symbols that are risky to modify. Use `git_log` and `git_blame` on affected files to understand change velocity and ownership. Run the suite with `Bash` (`npm test`) to verify test claims.'
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
    ),
    WIRING_CHECK: mcpTool('code-graph', 'wiring_check', 'Code Graph · wiring_check'),
    SHORTEST_PATH: mcpTool('code-graph', 'shortest_path', 'Code Graph · shortest_path')
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
    GIT_BLAME: mcpTool('git-context', 'git_blame', 'Git · blame'),
    GIT_SHOW: mcpTool('git-context', 'git_show', 'Git · show')
  }),
  CODE_ANALYSIS: mcpServer('code-analysis', {
    ANALYZE_COMPLEXITY: mcpTool(
      'code-analysis',
      'analyze_complexity',
      'Analysis · analyze_complexity'
    ),
    RESOLVE_LIBRARY_ID: mcpTool(
      'code-analysis',
      'resolve_library_id',
      'Analysis · resolve_library_id'
    ),
    QUERY_LIBRARY_DOCS: mcpTool(
      'code-analysis',
      'query_library_docs',
      'Analysis · query_library_docs'
    ),
    ESLINT_CHECK: mcpTool('code-analysis', 'eslint_check', 'Analysis · eslint_check'),
    ESLINT_FIX: mcpTool('code-analysis', 'eslint_fix', 'Analysis · eslint_fix'),
    ESLINT_RULES: mcpTool('code-analysis', 'eslint_rules', 'Analysis · eslint_rules'),
    AUDIT_SCAN: mcpTool('code-analysis', 'audit_scan', 'Analysis · audit_scan')
  }),
  CONTROL_ACTIONS: mcpServer('control-actions', {
    EMIT_PLAN: mcpTool('control-actions', 'emit_plan', 'Control · emit_plan'),
    ASK_USER: mcpTool('control-actions', 'ask_user', 'Control · ask_user'),
    PERMISSION_PROMPT: mcpTool(
      'control-actions',
      'permission_prompt',
      'Control · permission_prompt'
    ),
    EMIT_PHASE_PROGRESS: mcpTool(
      'control-actions',
      'emit_phase_progress',
      'Control · emit_phase_progress'
    )
  }),
  MEMORY: mcpServer('memory', {
    MEMORY_SEARCH: mcpTool('memory', 'memory_search', 'Memory · memory_search'),
    MEMORY_RECORD: mcpTool('memory', 'memory_record', 'Memory · memory_record'),
    MEMORY_FLAG: mcpTool('memory', 'memory_flag', 'Memory · memory_flag')
  }),
  RECALL: mcpServer('recall', {
    RECALL_PLANS: mcpTool('recall', 'recall_plans', 'Recall · recall_plans'),
    RECALL_PLAN: mcpTool('recall', 'recall_plan', 'Recall · recall_plan'),
    RECALL_CONVERSATION: mcpTool('recall', 'recall_conversation', 'Recall · recall_conversation')
  }),
  PROCESS_MANAGER: mcpServer('process-manager', {
    RUN_BACKGROUND: mcpTool('process-manager', 'run_background', 'Process · run_background'),
    CHECK_PROCESS: mcpTool('process-manager', 'check_process', 'Process · check_process'),
    STOP_PROCESS: mcpTool('process-manager', 'stop_process', 'Process · stop_process'),
    LIST_PROCESSES: mcpTool('process-manager', 'list_processes', 'Process · list_processes'),
    WAIT_PROCESS: mcpTool('process-manager', 'wait_process', 'Process · wait_process')
  }),
  JIRA: mcpServer('jira', {
    GET_ISSUE: mcpTool('jira', 'get_issue', 'Jira · get_issue'),
    SEARCH_ISSUES: mcpTool('jira', 'search_issues', 'Jira · search_issues'),
    ADD_COMMENT: mcpTool('jira', 'add_comment', 'Jira · add_comment'),
    ASSIGN_ISSUE: mcpTool('jira', 'assign_issue', 'Jira · assign_issue'),
    TRANSITION_ISSUE: mcpTool('jira', 'transition_issue', 'Jira · transition_issue')
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
    toolCount: 15,
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
    description: 'Git log, diff, blame, and show for version history',
    icon: 'GitBranch',
    tokenImpact: 'low',
    toolCount: 4,
    featureFlagKey: null,
    defaultEnabled: true
  },
  {
    id: 'code-analysis',
    displayName: 'Code Analysis',
    description: 'Lint, complexity, dead-code audit, and library documentation',
    icon: 'BarChart3',
    tokenImpact: 'low',
    toolCount: 7,
    featureFlagKey: null,
    defaultEnabled: true
  },
  {
    id: 'recall',
    displayName: 'Recall',
    description: 'Search past plans and the conversation around them',
    icon: 'History',
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
 * Backend to assume when a workspace has never persisted `localLlmBackend`.
 * oMLX only runs on Apple Silicon, so defaulting to it anywhere else makes
 * local embeddings unreachable (Windows/Linux have Ollama only).
 */
export function defaultLocalLlmBackend(isAppleSilicon: boolean): 'omlx' | 'ollama' {
  return isAppleSilicon ? 'omlx' : 'ollama'
}

/**
 * Skill filenames that are ALWAYS injected into every prompt — specialist
 * and local LLM paths. These are foundational behavioral
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
    label: 'Qwen 3.6 Coding (MLX, NVFP4)',
    parameterSize: '35B MoE',
    activeParams: 'A3B',
    contextWindow: 262144, // Native 262K (was 131K — incorrect; see HF model card)
    quantization: 'NVFP4',
    minMemoryGB: 24,
    memoryTier: '32gb',
    toolCalling: 'native',
    mlxOptimized: true,
    description: '32GB pick — MLX + NVFP4, coding-tuned',
    toolCallingNotes: 'Native tool calling with excellent format compliance',
    supportsParallelTools: true,
    supportsThinking: true,
    supportsVision: true
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
    supportsThinking: false,
    supportsVision: true
  },
  // 48GB+ tier
  {
    ollamaId: 'qwen3.6:35b-a3b-q8',
    omlxId: 'unsloth/Qwen3.6-35B-A3B-MLX-8bit',
    label: 'Qwen 3.6 35B (MLX 8-bit, Unsloth)',
    parameterSize: '35B MoE',
    activeParams: 'A3B',
    contextWindow: 262144,
    quantization: '8bit',
    minMemoryGB: 48,
    memoryTier: '48gb+',
    toolCalling: 'native',
    mlxOptimized: true,
    recommended: true,
    supportsVision: true,
    description:
      'Top pick for 64GB+ Macs — native vision, near-lossless 8-bit. Unsloth chat-template fixes for OpenCode tool calls',
    toolCallingNotes: 'Native tool calling, parallel support, thinking preservation',
    supportsParallelTools: true,
    supportsThinking: true
  },
  {
    ollamaId: 'qwen3.6:27b-6bit',
    omlxId: 'mlx-community/Qwen3.6-27B-6bit',
    label: 'Qwen 3.6 27B Dense (MLX, 6-bit)',
    parameterSize: '27B',
    contextWindow: 262144,
    quantization: '6bit',
    minMemoryGB: 32,
    memoryTier: '48gb+',
    toolCalling: 'native',
    mlxOptimized: true,
    supportsVision: true,
    description: 'Best raw coding quality — dense 27B, slower tok/s',
    toolCallingNotes: 'Native tool calling with excellent format compliance',
    supportsParallelTools: true,
    supportsThinking: true
  },
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
  /**
   * Bundled first-party server: mounted as `node <serverBasePath>/<entry>.js`.
   * When set, `command`/`commandPaths` are ignored and the PATH availability
   * check is skipped — the server ships with the app.
   */
  bundledServerEntry?: string
  /** Declarative credential form rendered on the Integrations page */
  credentialFields?: CredentialFieldDef[]
  /** Enables the "Test Connection" button */
  supportsConnectionTest?: boolean
  /**
   * This server's tools can legitimately run for many minutes (device farms,
   * build pipelines). Only such servers extend the executor's idle timeout —
   * a fast REST-backed server that goes quiet is hung, not working.
   */
  longRunningTools?: boolean
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
    // Cloud runs and device-farm flows routinely exceed 5 minutes of silence.
    longRunningTools: true,
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
  },
  {
    id: 'jira',
    displayName: 'Jira',
    description:
      'Read tickets, search with JQL, pull acceptance criteria, and post comments back to your Jira board.',
    icon: 'SquareKanban',
    // Bundled first-party server — `command`/`args` are replaced at mount time
    // with `node <serverBasePath>/jira-server.js`. Never resolved from PATH.
    command: 'node',
    args: [],
    bundledServerEntry: 'jira-server',
    envKeys: [
      'JIRA_BASE_URL',
      'JIRA_AUTH_MODE',
      'JIRA_EMAIL',
      'JIRA_USERNAME',
      'JIRA_API_TOKEN',
      // Forwarded from the parent process when set — corporate VPN / internal CA
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NO_PROXY',
      'NODE_EXTRA_CA_CERTS'
    ],
    performanceEnv: {
      // Node ≥24 reads HTTPS_PROXY/HTTP_PROXY/NO_PROXY for global fetch when this
      // is set. Harmless no-op on older runtimes.
      NODE_USE_ENV_PROXY: '1'
    },
    supportsConnectionTest: true,
    tokenImpact: 'low',
    toolCount: 5,
    prerequisite: 'Jira site URL + API token (or a PAT for Server / Data Center)',
    docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
    category: 'other',
    toolNames: [...MCP_TOOLS.JIRA._ALL_NAMES],
    // add_comment, assign_issue and transition_issue all write to a tracker the
    // whole team reads, so plan mode gets only the two read tools — planning
    // must never leave a trail on someone else's ticket.
    planModeToolNames: [MCP_TOOLS.JIRA.GET_ISSUE.name, MCP_TOOLS.JIRA.SEARCH_ISSUES.name],

    credentialFields: [
      {
        key: 'authMode',
        label: 'Authentication',
        type: 'select',
        envVar: 'JIRA_AUTH_MODE',
        required: true,
        options: [
          {
            value: 'cloud-token',
            label: 'Jira Cloud — email + API token',
            description:
              'Create at id.atlassian.com → Security → API tokens. No admin rights needed.'
          },
          {
            value: 'pat',
            label: 'Server / Data Center — Personal Access Token',
            description:
              'Jira profile → Personal Access Tokens. Typical for VPN-hosted client Jira.'
          },
          {
            value: 'basic',
            label: 'Server / Data Center — username + password'
          }
        ]
      },
      {
        key: 'baseUrl',
        label: 'Jira URL',
        type: 'url',
        envVar: 'JIRA_BASE_URL',
        required: true,
        placeholder: 'https://client.atlassian.net',
        help: 'For on-prem behind a VPN, use the same host you open in the browser.'
      },
      {
        key: 'email',
        label: 'Atlassian account email',
        type: 'text',
        envVar: 'JIRA_EMAIL',
        required: true,
        placeholder: 'you@company.com',
        showWhen: { authMode: ['cloud-token'] }
      },
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        envVar: 'JIRA_USERNAME',
        required: true,
        showWhen: { authMode: ['basic'] }
      },
      {
        key: 'apiToken',
        label: 'API token / PAT / password',
        type: 'password',
        envVar: 'JIRA_API_TOKEN',
        secret: true,
        required: true,
        help: 'Stored encrypted in your OS keychain. Never leaves this machine except to your Jira host.'
      }
    ],

    longDescription:
      'Connect your Jira board so the agent can read the ticket it is working on. Instead of pasting acceptance criteria into chat, point the agent at an issue key — it pulls the summary, description, status, assignee and recent comments, and can run JQL searches to find related work. It can also post a comment back when work lands. Comments are the only write: status, assignee and fields are never modified.',

    useCases: [
      {
        title: 'Implement Straight From a Ticket',
        description:
          'Say "implement PROJ-412" — the agent reads the description and acceptance criteria, then plans the work against your actual codebase.',
        icon: 'FileCode'
      },
      {
        title: 'Sprint Triage',
        description:
          'Ask for everything assigned to you in the current sprint. The agent runs the JQL and summarises what is blocked, in review, or untouched.',
        icon: 'Layers'
      },
      {
        title: 'Bug Reproduction Context',
        description:
          "Pull the bug report plus its comment thread so the agent has the reporter's steps and any follow-up findings before it starts debugging.",
        icon: 'Bug'
      },
      {
        title: 'PR Descriptions With Real Context',
        description:
          'The agent quotes the ticket summary and acceptance criteria when writing a PR description, so reviewers see the intent, not just the diff.',
        icon: 'Eye'
      }
    ],

    toolDescriptions: {
      mcp__jira__get_issue:
        'Fetches one issue by key (e.g. PROJ-123) — summary, status, assignee, reporter, priority, labels, description and the most recent comments. This is the "read the ticket" action.',
      mcp__jira__search_issues:
        'Runs a JQL query and returns compact rows (key, summary, status, assignee). Use it to find related tickets, sprint contents, or everything matching a label.',
      mcp__jira__add_comment:
        'Posts a comment on an issue — progress notes, a summary of what was implemented, or a question for the reporter. Writes to Jira; disabled in plan mode.',
      mcp__jira__assign_issue:
        'Assigns an issue to the account behind the stored credentials — the "I am picking this up" action. Writes to Jira; disabled in plan mode.',
      mcp__jira__transition_issue:
        'Moves an issue through its workflow, e.g. to In Progress. Called without a transition name it lists what the workflow allows, because transition ids differ per project. Writes to Jira; disabled in plan mode.'
    },

    workflowSteps: [
      {
        step: 'Pick auth mode',
        description:
          'Jira Cloud uses email + API token. Server / Data Center behind a VPN usually uses a Personal Access Token.'
      },
      {
        step: 'Enter URL + token',
        description:
          'Credentials are encrypted with your OS keychain and stored per workspace — never in plain text.'
      },
      {
        step: 'Test Connection',
        description:
          'Verifies the host is reachable and the token is valid before you enable the integration.'
      },
      {
        step: 'Enable + use',
        description:
          'Toggle Jira ON, then open the Jira tab to browse tickets — or reference issue keys naturally in chat: "summarise PROJ-123".'
      }
    ]
  }
] as const

// ── oMLX Embedding Configuration ────────────────────────────────────────────
//
// Code-search embeddings run through the user's oMLX server (Apple Silicon
// native, GPU-accelerated). The user must have oMLX installed and running with
// a compatible embedding model loaded. No artefacts are auto-downloaded.
export const OMLX_EMBEDDING = {
  server: {
    /** Defensive per-input character cap. BGE-M3 context is 8192 tokens;
     *  ~8000 chars ≈ ~2000 tokens keeps the "never hard-fail" behavior. */
    maxInputChars: 8000,
    /** Max seconds to wait for an embedding response */
    requestTimeoutMs: 30_000
  },
  /** Recommended embedding model for code semantic search */
  recommendedModel: {
    id: 'mlx-community/bge-m3-mlx-8bit',
    label: 'BGE-M3 (8-bit MLX)',
    /** Provenance string stored in indexing_state.embedding_model.
     *  Changing this triggers re-index via existing model-change invalidation. */
    modelName: 'bge-m3',
    dimensions: 1024,
    contextTokens: 8192,
    estimatedSizeMB: 700
  },
  /** Alternative models users can install in oMLX */
  alternativeModels: [
    {
      id: 'mlx-community/bge-m3-mlx-4bit',
      label: 'BGE-M3 (4-bit, smaller)',
      modelName: 'bge-m3-4bit',
      dimensions: 1024,
      estimatedSizeMB: 350
    },
    {
      id: 'mlx-community/answerdotai-ModernBERT-base-4bit',
      label: 'ModernBERT Base (4-bit)',
      modelName: 'modernbert-base',
      dimensions: 768,
      estimatedSizeMB: 150
    }
  ]
} as const
