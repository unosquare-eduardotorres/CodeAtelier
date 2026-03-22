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
  CHAT_CLEAR: 'chat:clear',
  CHAT_HANDOFF: 'chat:handoff',
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
  SYNC_APPLY: 'sync:apply'
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

/** Maximum skill file size in bytes (500 KB) */
export const SKILL_MAX_FILE_SIZE_BYTES = 512000 as const // 500 * 1024
