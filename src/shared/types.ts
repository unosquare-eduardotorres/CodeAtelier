// ── Data Models ──
export type ConversationMode = 'plan' | 'build'

export interface UserProfile {
  id: string
  displayName: string
  avatarKey: string
  createdAt: string
  updatedAt: string
}

export interface CoreAgentAlias {
  agentRole: 'generalist' | 'coordinator'
  alias: string | null
  avatarKey: string | null
  updatedAt: string
}

export interface Workspace {
  id: string
  name: string
  repoPath: string
  gitRemoteUrl?: string
  createdAt: string
  lastOpenedAt: string
  settingsJson: string
  isGitRepo: boolean
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
  /** PR number created during /complete */
  prNumber?: number
  /** PR URL created during /complete */
  prUrl?: string
  /** Git branch name created during /complete */
  branchName?: string
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
  // Complexity scoring — populated when running as a specialist
  model?: ModelTier
  complexityTier?: ComplexityTier
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
  alias: string | null
  avatarUrl: string | null
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
  alias?: string | null
  avatarUrl?: string | null
}

// ── Marketplace Models ──

export interface MarketplaceSpecialist {
  id: string
  agentId: string
  displayName: string
  description: string
  icon: string
  color: string
  model: string
  tools: string[]
  skills: Skill[]
  isActive: boolean
  isDeployed: boolean
  alias: string | null
  avatarUrl: string | null
  priority: number
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

// ── Complexity Scoring ──

export interface ComplexityScore {
  filesAffected: number // 0-3
  estimatedLines: number // 0-3
  newDependencies: number // 0-2
  taskType: number // 0-3
  riskFlags: number // 0-3
  total: number // 0-14
  tier: 'simple' | 'moderate' | 'complex'
  model: 'haiku' | 'sonnet' | 'opus'
}

export type CostPreference = 'economy' | 'balanced' | 'power'

/** Budget tier controls how much context is included in system prompts (Strategy 4) */
export type BudgetTier = 'minimal' | 'standard' | 'full'

export type ComplexityTier = ComplexityScore['tier']
export type ModelTier = ComplexityScore['model']

/** Actions that consume a Claude model — each can be independently configured */
export type ModelAction =
  | 'generalist'
  | 'orchestrator'
  | 'specialist:simple'
  | 'specialist:moderate'
  | 'specialist:complex'
  | 'dream'
  | 'memoryFeed'
  | 'activation'

/** Per-action model overrides stored in workspace settings_json */
export interface ModelOverrides {
  [key: string]: string // ModelAction → model ID string
}

/** A single decomposed sub-task assigned to a specialist */
export interface DecomposedTask {
  id: string
  specialist: string
  description: string
  dependsOn: string[]
  // Populated by combined decompose+score call
  complexity?: ComplexityScore
  model?: ModelTier
  /** Optional verification command to run after task completion (e.g. "npm run lint", "npm test") */
  verificationCommand?: string
}

/** The full task plan returned by the orchestrator's decomposition step */
export interface TaskPlan {
  conversationId: string
  summary: string
  mode: ConversationMode
  tasks: DecomposedTask[]
  /** Preserved enriched handoff context for specialist injection */
  brief?: HandoffBrief
}

/** Progress event for an individual specialist task */
export interface TaskExecutionProgress {
  taskId: string
  specialist: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  output?: string
  error?: string
  // Complexity scoring
  model?: ModelTier
  complexityTier?: ComplexityTier
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

export interface GrillQuestionOption {
  label: string
  description?: string
  recommended?: boolean
}

export interface GrillQuestion {
  id: string
  question: string
  header?: string
  options: GrillQuestionOption[]
  multiSelect?: boolean
  allowOther?: boolean
}

export interface GrillAnswerPayload {
  questionId: string
  selectedOptions: string[]
  otherText?: string
  skipped: boolean
}

export interface GrillEvaluation {
  score: number
  scoreLabel: string
  feedback: string
  questions: GrillQuestion[]
}

// ── Structured Plan Types ──
export interface PlanStep {
  number: number
  title: string
  description: string
  file?: string
  complexity?: 'low' | 'medium' | 'high'
}

export interface PlanSection {
  heading: string
  icon?: string
  content: string
  mermaid?: string
}

export interface StructuredPlan {
  title: string
  summary: string
  sections?: PlanSection[]
  steps?: PlanStep[]
  files?: string[]
  risks?: string[]
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

// ── Auto Memory System ──

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export interface Memory {
  id: string
  workspaceId: string | null
  type: MemoryType
  title: string
  content: string
  tags: string[]
  sourceConversationId: string | null
  sourceAgentId: string | null
  importance: number
  lastAccessedAt: string | null
  createdAt: string
  updatedAt: string
}

export type DreamStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type DreamTriggerType = 'startup' | 'idle' | 'manual'

export interface DreamRun {
  id: string
  workspaceId: string
  status: DreamStatus
  triggerType: DreamTriggerType
  memoriesCreated: number
  memoriesMerged: number
  memoriesPruned: number
  tokenUsage: number
  startedAt: string
  endedAt: string | null
  errorMessage: string | null
}

export interface DreamProgress {
  phase: 'review' | 'consolidate' | 'prune' | 'complete'
  message: string
  memoriesCreated: number
  memoriesMerged: number
  memoriesPruned: number
}

export interface MemoryFeedProgress {
  type: 'status' | 'error' | 'complete'
  message: string
  source: 'claude-md' | 'codebase' | 'document'
  timestamp: number
}

export interface WorkspaceFeedTimestamps {
  'claude-md'?: string
  'codebase'?: string
  'document'?: string
}

export interface MemoryFeedResult {
  success: boolean
  source: 'claude-md' | 'codebase' | 'document'
  memoriesCreated: number
  error?: string
}

/** Structured handoff context built by generalist before delegation */
export interface HandoffBrief {
  /** LLM-generated summary of what needs to be done */
  summary: string
  /** Key decisions made during the conversation */
  decisions: string[]
  /** Constraints identified (tech constraints, time, compatibility, etc.) */
  constraints: string[]
  /** File paths discussed or referenced in conversation */
  filesDiscussed: string[]
  /** The last N user+assistant message pairs for full context */
  recentMessages: Array<{ role: string; content: string }>
  /** Specialist IDs suggested by generalist */
  specialists: string[]
  /** Conversation mode (plan or build) */
  mode: ConversationMode
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
  grillDecisions?: string
  createdAt: string
  updatedAt: string
}

/** A document file discovered in the workspace /docs folder */
export interface DocFile {
  /** File name (e.g. "auto-update-flow.md") */
  name: string
  /** Absolute file path */
  path: string
  /** File extension without dot (e.g. "md", "docx", "pdf") */
  extension: string
  /** Whether the format is renderable (only .md for now) */
  supported: boolean
  /** File size in bytes */
  sizeBytes: number
  /** Last modified timestamp (epoch ms) */
  modifiedAt: number
}

export interface RepoInfo {
  isRepo: boolean
  hasRemote: boolean
  remoteUrl?: string
  currentBranch: string
}

// ── IPC Channel Map (type-safe) ──
export interface IpcChannels {
  'workspace:list': { args: void; return: Workspace[] }
  'workspace:create': { args: { name: string; repoPath: string }; return: Workspace }
  'workspace:open': { args: { id: string }; return: Workspace }
  'workspace:delete': { args: { id: string }; return: void }
  'workspace:get-settings': { args: { workspaceId: string }; return: Record<string, unknown> }
  'workspace:update-settings': {
    args: { workspaceId: string; settings: Record<string, unknown> }
    return: void
  }
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

  // Specialist Marketplace
  'specialist:deploy': {
    args: { workspacePath: string; specialistId: string }
    return: void
  }
  'specialist:undeploy': {
    args: { workspacePath: string; specialistId: string }
    return: void
  }
  'specialist:updateConfig': {
    args: {
      id: string
      displayName?: string
      icon?: string
      color?: string
      alias?: string | null
      avatarUrl?: string | null
      priority?: number
    }
    return: Specialist
  }
  'specialist:getMarketplace': {
    args: { workspacePath: string }
    return: MarketplaceSpecialist[]
  }

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
    args: { conversationId: string; branchName: string; commitMessage: string; description: string }
    return: CompleteResult
  }
  'chat:close': { args: { conversationId: string }; return: void }
  'chat:getFileChanges': { args: { conversationId: string }; return: FileChange[] }
  'chat:generatePrDescription': {
    args: { conversationId: string }
    return: { description: string }
  }

  // GitHub Integration
  'github:saveToken': { args: { workspaceId: string; token: string }; return: { login: string } }
  'github:validateToken': {
    args: { token: string }
    return: { valid: boolean; login: string; scopes: string[] }
  }
  'github:getStatus': {
    args: { workspaceId: string }
    return: { configured: boolean; login?: string }
  }
  'github:removeToken': { args: { workspaceId: string }; return: void }

  // Repository Management
  'repo:init': { args: { workspaceId: string }; return: void }
  'repo:setRemote': { args: { workspaceId: string; remoteUrl: string }; return: void }
  'repo:getInfo': { args: { workspaceId: string }; return: RepoInfo }
  'repo:hasUnsavedChanges': {
    args: { conversationId: string }
    return: { hasChanges: boolean; fileCount: number; files: string[] }
  }

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

  // Memory (auto memory system)
  'memory:list': { args: { workspaceId: string }; return: Memory[] }
  'memory:search': { args: { workspaceId: string; query: string }; return: Memory[] }
  'memory:create': {
    args: {
      workspaceId: string | null
      type: MemoryType
      title: string
      content: string
      tags?: string[]
      importance?: number
    }
    return: Memory
  }
  'memory:update': {
    args: { id: string; title?: string; content?: string; tags?: string[]; importance?: number }
    return: Memory
  }
  'memory:delete': { args: { id: string }; return: void }
  'memory:updateSetting': { args: { workspaceId: string; memoryEnabled: boolean }; return: void }

  // Memory feed (ingest sources into memories)
  'memory:feedClaudeMd': { args: { workspacePath: string }; return: MemoryFeedResult }
  'memory:feedCodebase': { args: { workspacePath: string }; return: MemoryFeedResult }
  'memory:feedDocument': {
    args: { workspacePath: string; filePath: string }
    return: MemoryFeedResult
  }
  'memory:feedCancel': { args: void; return: void }
  'memory:selectDocument': { args: void; return: string | null }
  'memory:getFeedTimestamps': {
    args: { workspaceId: string }
    return: WorkspaceFeedTimestamps
  }
  'memory:regenerateClaudeMd': {
    args: { workspacePath: string }
    return: { success: boolean; content: string; existing: string | null; error?: string }
  }

  // Dream (auto consolidation)
  'dream:trigger': { args: { workspaceId: string }; return: DreamRun }
  'dream:cancel': { args: { workspaceId: string }; return: void }
  'dream:getStatus': { args: { workspaceId: string }; return: DreamRun | null }
  'dream:getHistory': { args: { workspaceId: string; limit?: number }; return: DreamRun[] }

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

  // User Profile
  'user:getProfile': { args: void; return: UserProfile | null }
  'user:upsertProfile': {
    args: { displayName: string; avatarKey: string }
    return: UserProfile
  }

  // Core Agent Aliases
  'coreAgent:list': { args: void; return: CoreAgentAlias[] }
  'coreAgent:upsert': {
    args: { agentRole: 'generalist' | 'coordinator'; alias: string | null; avatarKey: string | null }
    return: CoreAgentAlias
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
  'memory:feedProgress': MemoryFeedProgress
  'dream:progress': DreamProgress
}
