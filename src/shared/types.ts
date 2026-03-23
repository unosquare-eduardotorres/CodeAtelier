// ── Data Models ──
export type ConversationMode = 'plan' | 'build'

export interface Workspace {
  id: string
  name: string
  repoPath: string
  gitRemoteUrl?: string
  createdAt: string
  lastOpenedAt: string
  settingsJson: string
}

export interface Conversation {
  id: string
  workspaceId: string
  title: string
  mode: ConversationMode
  createdAt: string
  status: 'active' | 'archived'
  summary?: string
  /** Claude CLI session ID for --resume support (context persistence) */
  claudeSessionId?: string
}

export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'coordinator' | 'specialist' | 'generalist'
  agentId?: string
  contentMd: string
  attachmentsJson: string
  createdAt: string
}

export interface Attachment {
  id: string
  conversationId: string
  filename: string
  mimeType?: string
  filePath: string
  extractedText?: string
  tokenCount: number
  createdAt: string
}

export interface AgentStatus {
  agentId: string
  agentType: string
  status: 'idle' | 'thinking' | 'writing' | 'reviewing' | 'completed' | 'failed'
  currentTask?: string
  elapsedMs: number
  tokenUsage: number
}

// ── Tool Activity ──
export interface ToolActivity {
  id: string
  toolName: string
  status: 'running' | 'completed' | 'error'
  input?: string
  startedAt: number
  completedAt?: number
}

// ── Specialist & Skill Models ──
export interface Specialist {
  id: string
  agentId: string
  displayName: string
  icon: string
  color: string
  prompt: string
  priority: number
  isActive: boolean
  sourceYaml: string | null
  skills?: Skill[]
  createdAt: string
  updatedAt: string
}

export interface Skill {
  id: string
  name: string
  description: string
  filename: string
  filePath: string
  isActive: boolean
  lastUpdatedDate: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateSpecialistInput {
  agentId: string
  displayName: string
  icon?: string
  color?: string
  prompt?: string
  priority?: number
  isActive?: boolean
}

export interface UpdateSpecialistInput {
  displayName?: string
  icon?: string
  color?: string
  prompt?: string
  priority?: number
  isActive?: boolean
}

// ── Workspace Deploy Models ──

/** Represents a skill directory discovered on the filesystem */
export interface DiscoveredSkill {
  name: string
  dirPath: string
  hasSkillMd: boolean
  referenceFiles: string[]
  frontmatter: {
    name?: string
    description?: string
  } | null
  isActive: boolean
  lastUpdated: string | null
  source: 'master' | 'workspace'
}

/** Represents an agent YAML discovered on the filesystem */
export interface DiscoveredAgent {
  filename: string
  filePath: string
  parsed: {
    name: string
    description: string
    model: string
    tools: string[]
    skills: string[]
  }
  bodyContent: string
  isActive: boolean
  isDeployed: boolean
  source: 'master' | 'workspace'
  specialistId?: string
}

/** Result of scanning a workspace's .claude/ status */
export interface WorkspaceClaudeStatus {
  hasClaudeDir: boolean
  hasClaudeMd: boolean
  hasAgentsDir: boolean
  hasSkillsDir: boolean
  deployedAgents: string[]
  deployedSkills: string[]
  claudeMdPreview: string | null
}

/** Result of the Opus activation flow */
export interface ActivationResult {
  success: boolean
  selectedAgents: string[]
  selectedSkills: string[]
  error?: string
  // CLAUDE.md diff data for user review
  existingClaudeMd: string | null
  proposedClaudeMd: string | null
  claudeMdWritten: boolean
}

/** Progress event during Opus activation */
export interface ActivationProgressEvent {
  type: 'status' | 'stderr' | 'error'
  message: string
  timestamp: number
}

// ── File Change Tracking ──

export interface FileChange {
  id: string
  conversationId: string
  filePath: string
  changeType: 'created' | 'modified' | 'deleted'
  createdAt: string
}

export interface CompleteResult {
  branch: string
  commitHash: string
  prUrl?: string
}

// ── Task Decomposition & Parallel Execution ──

export type ExecutionStrategy = 'sequential' | 'parallel'

/** A single decomposed sub-task assigned to a specialist */
export interface DecomposedTask {
  id: string
  specialist: string
  description: string
  dependsOn: string[]
}

/** The full task plan returned by the orchestrator's decomposition step */
export interface TaskPlan {
  conversationId: string
  summary: string
  mode: ConversationMode
  tasks: DecomposedTask[]
}

/** Progress event for an individual specialist task */
export interface TaskExecutionProgress {
  taskId: string
  specialist: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  output?: string
  error?: string
}

// ── Git Worktree Models ──

export type WorktreeStatus = 'active' | 'merging' | 'merged' | 'conflict' | 'abandoned' | 'pruned'

export interface AgentWorktree {
  id: string
  conversationId: string
  agentId: string
  taskId: string
  worktreePath: string
  branchName: string
  baseBranch: string
  status: WorktreeStatus
  createdAt: string
  mergedAt: string | null
}

export interface MergeConflict {
  agentId: string
  taskId: string
  conflictedFiles: string[]
}

export interface MergeAllResult {
  merged: string[]
  conflicted?: {
    agentId: string
    files: string[]
  }
  pending: string[]
}

// ── YAML ↔ DB Sync Models ──

export interface SyncDiff {
  // Specialists
  newSpecialists: DiscoveredAgent[]
  updatedSpecialists: {
    agent: DiscoveredAgent
    dbRecord: Specialist
    changes: string[]
  }[]
  removedSpecialists: Specialist[]
  unchangedSpecialists: Specialist[]

  // Skills
  newSkills: DiscoveredSkill[]
  removedSkills: Skill[]
  unchangedSkills: Skill[]

  // Summary
  hasChanges: boolean
}

export interface SyncResult {
  imported: number
  updated: number
  deactivated: number
  skillsImported: number
  errors: string[]
}

// ── Grill Session Types ──
export interface GrillProposedTask {
  title: string
  description: string
}

export interface GrillSummary {
  summary: string
  proposedTasks: GrillProposedTask[]
}

// ── Agent Session & Token Tracking ──
export interface AgentSessionRecord {
  id: string
  taskId: string | null
  agentType: string
  pid: number | null
  status: 'running' | 'completed' | 'failed' | 'terminated'
  startedAt: string
  endedAt: string | null
  tokenUsage: number
  conversationId: string | null
  workspaceId: string | null
}

export interface TokenSummary {
  totalTokens: number
  sessionCount: number
  byAgent: { agentType: string; totalTokens: number; sessionCount: number }[]
}

// ── Brain (persistent project memory) ──
export interface BrainEntry {
  timestamp: string
  conversationId: string
  conversationTitle: string
  type: 'completion' | 'decision' | 'error' | 'milestone' | 'context'
  summary: string
  details?: string
}

// ── Brain Management ──
export interface BrainFileInfo {
  fileName: string
  filePath: string
  lineCount: number
  sizeBytes: number
  estimatedTokens: number
  lastModified: string
  isOverThreshold: boolean
}

export interface BrainStatus {
  enabled: boolean
  initialized: boolean
  files: BrainFileInfo[]
  totalLines: number
  totalSizeBytes: number
  totalEstimatedTokens: number
}

// ── Brain Feed ──
export interface BrainFeedProgress {
  type: 'status' | 'error' | 'complete'
  message: string
  source: 'claude-md' | 'codebase' | 'document'
  timestamp: number
}

export interface BrainFeedResult {
  success: boolean
  source: 'claude-md' | 'codebase' | 'document'
  filesUpdated: string[]
  error?: string
}

// ── Ideas ──
export interface Idea {
  id: string
  workspaceId: string
  title: string
  description: string
  status: 'draft' | 'grilling' | 'completed'
  grillConversationId?: string
  grillSummary?: string
  convertedConversationId?: string
  createdAt: string
  updatedAt: string
}

// ── IPC Channel Map (type-safe) ──
export interface IpcChannels {
  'workspace:list': { args: void; return: Workspace[] }
  'workspace:create': { args: { name: string; repoPath: string }; return: Workspace }
  'workspace:open': { args: { id: string }; return: Workspace }
  'workspace:delete': { args: { id: string }; return: void }
  'chat:sendMessage': {
    args: { conversationId: string; text: string; attachments?: string[] }
    return: void
  }
  'chat:getConversations': { args: { workspaceId: string }; return: Conversation[] }
  'chat:createConversation': {
    args: { workspaceId: string; title?: string; mode?: ConversationMode }
    return: Conversation
  }
  'chat:getMessages': { args: { conversationId: string }; return: Message[] }
  'chat:deleteConversation': { args: { conversationId: string }; return: void }
  'chat:renameConversation': {
    args: { conversationId: string; title: string }
    return: Conversation
  }
  'chat:updateMode': {
    args: { conversationId: string; mode: ConversationMode }
    return: Conversation
  }
  'agent:getStatuses': { args: void; return: AgentStatus[] }

  // Specialists
  'specialist:list': { args: void; return: Specialist[] }
  'specialist:get': { args: { id: string }; return: Specialist }
  'specialist:create': { args: CreateSpecialistInput; return: Specialist }
  'specialist:update': { args: { id: string } & UpdateSpecialistInput; return: Specialist }
  'specialist:delete': { args: { id: string }; return: void }
  'specialist:assignSkill': { args: { specialistId: string; skillId: string }; return: void }
  'specialist:removeSkill': { args: { specialistId: string; skillId: string }; return: void }

  // Skills
  'skill:list': { args: void; return: Skill[] }
  'skill:get': { args: { id: string }; return: Skill }
  'skill:import': { args: { filePath: string }; return: Skill }
  'skill:update': { args: { id: string; name?: string; description?: string }; return: Skill }
  'skill:delete': { args: { id: string }; return: void }
  'skill:activate': { args: { id: string }; return: Skill }
  'skill:deactivate': { args: { id: string }; return: Skill }
  'skill:selectFile': { args: void; return: string | null }
  'dialog:saveClipboardImage': { args: { dataUrl: string }; return: string }

  // Workspace Deploy
  'workspace:scanClaude': { args: { workspacePath: string }; return: WorkspaceClaudeStatus }
  'workspace:activateAgents': { args: { workspacePath: string }; return: ActivationResult }
  'workspace:readFile': { args: { filePath: string }; return: string }
  'workspace:writeFile': { args: { filePath: string; content: string }; return: void }
  'workspace:scanSkills': { args: { workspacePath: string }; return: DiscoveredSkill[] }
  'workspace:scanAgents': { args: { workspacePath: string }; return: DiscoveredAgent[] }
  'workspace:cancelActivation': { args: void; return: void }
  'workspace:cleanActivation': {
    args: { workspacePath: string; removeClaudeMd?: boolean }
    return: void
  }

  // Agent/Skill individual delete & sync
  'agent:deleteFromWorkspace': {
    args: { workspacePath: string; filename: string }
    return: void
  }
  'agent:syncToWorkspace': {
    args: { workspacePath: string; filename: string }
    return: void
  }
  'skill:deleteFromWorkspace': {
    args: { workspacePath: string; skillName: string }
    return: void
  }
  'skill:syncToWorkspace': {
    args: { workspacePath: string; skillName: string }
    return: void
  }

  // Agent activate/deactivate
  'agent:activate': { args: { workspacePath: string; agentName: string }; return: void }
  'agent:deactivate': { args: { workspacePath: string; agentName: string }; return: void }

  // Bulk delete all agents/skills
  'workspace:deleteAllAgents': { args: { workspacePath: string }; return: void }
  'workspace:deleteAllSkills': { args: { workspacePath: string }; return: void }

  // Deploy all (inactive) to workspace
  'workspace:deployAll': {
    args: { workspacePath: string }
    return: { agents: number; skills: number }
  }

  // Task Execution
  'chat:executePlan': {
    args: { conversationId: string; strategy: ExecutionStrategy; tasks: DecomposedTask[] }
    return: void
  }

  // Chat Commands
  'chat:complete': {
    args: { conversationId: string; commitMessage: string; description: string }
    return: CompleteResult
  }
  'chat:close': { args: { conversationId: string }; return: void }
  'chat:getFileChanges': { args: { conversationId: string }; return: FileChange[] }

  // Worktrees
  'worktree:list': { args: { conversationId: string }; return: AgentWorktree[] }
  'worktree:getDiff': { args: { worktreeId: string }; return: string }
  'worktree:merge': {
    args: { worktreeId: string }
    return: { success: boolean; conflictedFiles?: string[] }
  }
  'worktree:mergeAll': { args: { conversationId: string }; return: MergeAllResult }
  'worktree:abandon': { args: { worktreeId: string }; return: void }

  // Agent Sync
  'sync:computeDiff': { args: { workspacePath: string }; return: SyncDiff }
  'sync:apply': { args: { workspacePath: string; skipRemoved?: boolean }; return: SyncResult }

  // Brain (project memory)
  'brain:getContext': { args: { workspacePath: string }; return: string }
  'brain:getState': { args: { workspacePath: string }; return: string }
  'brain:logDecision': { args: { workspacePath: string; entry: BrainEntry }; return: void }
  'brain:getFilesInfo': { args: { workspacePath: string }; return: BrainStatus }
  'brain:compactFile': { args: { workspacePath: string; fileName: string }; return: BrainFileInfo }
  'brain:compactAll': { args: { workspacePath: string }; return: BrainStatus }
  'brain:updateSetting': { args: { workspaceId: string; brainEnabled: boolean }; return: void }

  // Brain feed
  'brain:feedClaudeMd': { args: { workspacePath: string }; return: BrainFeedResult }
  'brain:feedCodebase': { args: { workspacePath: string }; return: BrainFeedResult }
  'brain:feedDocument': {
    args: { workspacePath: string; filePath: string }
    return: BrainFeedResult
  }
  'brain:selectDocument': { args: void; return: string | null }

  // Tokens
  'token:getWorkspaceSummary': { args: { workspaceId: string }; return: TokenSummary }
  'token:getConversationSummary': { args: { conversationId: string }; return: TokenSummary }
  'token:getRecentSessions': {
    args: { workspaceId: string; limit?: number }
    return: AgentSessionRecord[]
  }

  // Ideas
  'idea:list': { args: { workspaceId: string }; return: Idea[] }
  'idea:create': {
    args: { workspaceId: string; title: string; description: string }
    return: Idea
  }
  'idea:update': {
    args: { id: string; title?: string; description?: string }
    return: Idea
  }
  'idea:delete': { args: { id: string }; return: void }
  'idea:startGrill': {
    args: { ideaId: string; workspaceId: string }
    return: { idea: Idea; conversation: Conversation }
  }
  'idea:convertDirect': {
    args: { ideaId: string; workspaceId: string }
    return: { idea: Idea; conversation: Conversation }
  }
  'idea:completeFromGrill': {
    args: { conversationId: string; summary?: string }
    return: Idea | null
  }
}

// ── IPC Event Channels (main → renderer streaming) ──
export interface IpcEvents {
  'chat:messageChunk': { conversationId: string; chunk: string; role: 'coordinator' | 'generalist' }
  'chat:messageComplete': { conversationId: string; messageId: string }
  'chat:handoff': {
    conversationId: string
    summary: string
    specialists: string[]
    mode: ConversationMode
  }
  'chat:grillComplete': {
    conversationId: string
    summary: string
    proposedTasks: GrillProposedTask[]
  }
  'chat:taskPlan': TaskPlan
  'chat:taskProgress': TaskExecutionProgress
  'agent:statusUpdate': AgentStatus
  'agent:taskChunk': { agentId: string; taskId: string; text: string }
  'agent:taskRetry': {
    taskId: string
    specialist: string
    attempt: number
    maxRetries: number
  }
  'workspace:activationProgress': ActivationProgressEvent
  'brain:feedProgress': BrainFeedProgress
}
