/**
 * @deprecated Use database-backed specialists via specialistRepository instead.
 * Kept temporarily for backward compatibility during migration.
 */
export const AGENT_IDS = {
  GENERALIST: 'generalist',
  ORCHESTRATOR: 'orchestrator',
  REACT_ARCHITECT: 'react-architect',
  DOTNET_ARCHITECT: 'dotnet-architect',
  ELECTRON_ARCHITECT: 'electron-architect',
  AGENTIC_ARCHITECT: 'agentic-architect',
  DB_ARCHITECT: 'db-architect',
  UX_UI_SPECIALIST: 'ux-ui-specialist',
  GIT_GITHUB_SPECIALIST: 'git-github-specialist',
  REQUIREMENTS_SPECIALIST: 'requirements-specialist',
  CODE_PLANNER: 'code-planner',
  EXECUTION_PLANNER: 'execution-planner',
  CICD_DEVOPS: 'cicd-devops',
  CLOUD_INFRASTRUCTURE: 'cloud-infrastructure'
} as const

export const IPC_CHANNELS = {
  // Workspace
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_OPEN: 'workspace:open',
  WORKSPACE_DELETE: 'workspace:delete',
  WORKSPACE_GET_SETTINGS: 'workspace:get-settings',
  WORKSPACE_UPDATE_SETTINGS: 'workspace:update-settings',

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
  CHAT_TASK_PLAN: 'chat:taskPlan',
  CHAT_EXECUTE_PLAN: 'chat:executePlan',
  CHAT_TASK_PROGRESS: 'chat:taskProgress',
  CHAT_COMPLETE: 'chat:complete',
  CHAT_CLOSE: 'chat:close',
  CHAT_GET_FILE_CHANGES: 'chat:getFileChanges',

  // Agents
  AGENT_GET_STATUSES: 'agent:getStatuses',
  AGENT_STATUS_UPDATE: 'agent:statusUpdate',
  AGENT_STOP_ALL: 'agent:stopAll',

  // Orchestrator
  ORCHESTRATOR_START: 'orchestrator:start',
  ORCHESTRATOR_READY: 'orchestrator:ready',

  // Dialog
  DIALOG_SELECT_DIRECTORY: 'dialog:selectDirectory',
  SAVE_CLIPBOARD_IMAGE: 'dialog:saveClipboardImage',

  // Specialists
  SPECIALIST_LIST: 'specialist:list',
  SPECIALIST_GET: 'specialist:get',
  SPECIALIST_CREATE: 'specialist:create',
  SPECIALIST_UPDATE: 'specialist:update',
  SPECIALIST_DELETE: 'specialist:delete',
  SPECIALIST_ASSIGN_SKILL: 'specialist:assignSkill',
  SPECIALIST_REMOVE_SKILL: 'specialist:removeSkill',

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
  MEMORY_FEED_CLAUDE_MD: 'memory:feedClaudeMd',
  MEMORY_FEED_CODEBASE: 'memory:feedCodebase',
  MEMORY_FEED_DOCUMENT: 'memory:feedDocument',
  MEMORY_FEED_PROGRESS: 'memory:feedProgress',
  MEMORY_FEED_CANCEL: 'memory:feedCancel',
  MEMORY_SELECT_DOCUMENT: 'memory:selectDocument',

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

  // PR Description Generation
  CHAT_GENERATE_PR_DESCRIPTION: 'chat:generatePrDescription',

  // User Profile
  USER_PROFILE_GET: 'user:getProfile',
  USER_PROFILE_UPSERT: 'user:upsertProfile',

  // Core Agent Aliases
  CORE_AGENT_LIST: 'coreAgent:list',
  CORE_AGENT_UPSERT: 'coreAgent:upsert'
} as const

/**
 * @deprecated Use database-backed specialists via specialistRepository instead.
 * Kept temporarily for backward compatibility during migration.
 */
export const AGENT_META: Record<string, { icon: string; color: string; displayName: string }> = {
  generalist: { icon: '💬', color: '#6366F1', displayName: 'Generalist' },
  orchestrator: { icon: '🎯', color: '#8B5CF6', displayName: 'Orchestrator' },
  'react-architect': { icon: '⚛️', color: '#61DAFB', displayName: 'React Architect' },
  'dotnet-architect': { icon: '🟣', color: '#512BD4', displayName: '.NET Architect' },
  'electron-architect': { icon: '⚡', color: '#47848F', displayName: 'Electron Architect' },
  'agentic-architect': { icon: '🤖', color: '#D97706', displayName: 'Agentic Architect' },
  'db-architect': { icon: '🗄️', color: '#336791', displayName: 'DB Architect' },
  'ux-ui-specialist': { icon: '🎨', color: '#DB2777', displayName: 'UX/UI Specialist' },
  'git-github-specialist': { icon: '🔀', color: '#64748B', displayName: 'Git/GitHub Specialist' },
  'requirements-specialist': {
    icon: '📋',
    color: '#059669',
    displayName: 'Requirements Specialist'
  },
  'code-planner': { icon: '📝', color: '#475569', displayName: 'Code Planner' },
  'execution-planner': { icon: '📅', color: '#DC6843', displayName: 'Execution Planner' },
  'cicd-devops': { icon: '🚀', color: '#DC2626', displayName: 'CI/CD DevOps' },
  'cloud-infrastructure': { icon: '☁️', color: '#0D9488', displayName: 'Cloud Infrastructure' }
}

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

/** Model used for activation CLAUDE.md generation */
export const ACTIVATION_MODEL_ID = 'claude-sonnet-4-20250514' as const

/** Fast model used for memory feed summarization tasks (structured extraction) */
export const MEMORY_FEED_MODEL_ID = 'claude-haiku-4-20250414' as const

/** Model used for dream consolidation cycles */
export const DREAM_MODEL_ID = 'claude-haiku-4-20250414' as const

/** Model IDs per complexity tier — used for specialist routing */
export const MODEL_TIER_IDS = {
  haiku: 'claude-haiku-4-20250414',
  sonnet: 'claude-sonnet-4-20250514',
  opus: 'claude-opus-4-20250514'
} as const

/** Complexity score thresholds for tier assignment */
export const COMPLEXITY_THRESHOLDS = {
  simple: { min: 0, max: 4 },
  moderate: { min: 5, max: 8 },
  complex: { min: 9, max: 14 }
} as const

/** Default cost preference for new workspaces */
export const DEFAULT_COST_PREFERENCE = 'balanced' as const

/** Available Claude models for configuration UI */
export const AVAILABLE_MODELS = [
  {
    id: 'claude-haiku-4-20250414',
    label: 'Haiku',
    tier: 'haiku' as const,
    description: 'Fast & lightweight'
  },
  {
    id: 'claude-sonnet-4-20250514',
    label: 'Sonnet',
    tier: 'sonnet' as const,
    description: 'Balanced performance'
  },
  {
    id: 'claude-opus-4-20250514',
    label: 'Opus',
    tier: 'opus' as const,
    description: 'Most capable'
  }
] as const

/** Default model for each configurable action */
export const DEFAULT_MODEL_CONFIG: Record<
  import('./types').ModelAction,
  string
> = {
  generalist: 'claude-sonnet-4-20250514',
  orchestrator: 'claude-sonnet-4-20250514',
  'specialist:simple': 'claude-haiku-4-20250414',
  'specialist:moderate': 'claude-sonnet-4-20250514',
  'specialist:complex': 'claude-opus-4-20250514',
  dream: 'claude-haiku-4-20250414',
  memoryFeed: 'claude-haiku-4-20250414',
  activation: 'claude-sonnet-4-20250514'
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
  orchestrator: {
    label: 'Orchestrator',
    description: 'Task decomposition & coordination',
    icon: '🎯',
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
 * Controls extended thinking depth: Opus gets full thinking, Sonnet moderate, Haiku none.
 * Set as env var on specialist `claude -p` processes to improve output quality.
 */
export const THINKING_BUDGETS = {
  haiku: '0',
  sonnet: '10000',
  opus: '31999'
} as const

/** Maximum skill file size in bytes (500 KB) */
export const SKILL_MAX_FILE_SIZE_BYTES = 512000 as const // 500 * 1024
