import type {
  Workspace,
  Conversation,
  ConversationMode,
  Message,
  AgentStatus,
  Specialist,
  Skill,
  CreateSpecialistInput,
  UpdateSpecialistInput,
  WorkspaceClaudeStatus,
  ActivationResult,
  ActivationProgressEvent,
  DiscoveredSkill,
  DiscoveredAgent,
  SyncDiff,
  SyncResult,
  DecomposedTask,
  TaskPlan,
  ExecutionStrategy,
  TaskExecutionProgress,
  InvestigationReport,
  FileChange,
  CompleteResult,
  AgentWorktree,
  MergeAllResult,
  GrillProposedTask,
  GrillQuestion,
  GrillTrackId,
  Memory,
  MemoryType,
  MemoryFeedProgress,
  MemoryFeedResult,
  WorkspaceFeedTimestamps,
  DreamRun,
  DreamProgress,
  TokenSummary,
  AgentSessionRecord,
  Idea,
  DocFile,
  RepoInfo,
  UserProfile,
  CoreAgentAlias,
  MarketplaceSpecialist
} from '../shared/types'

interface Api {
  // Workspace
  listWorkspaces: () => Promise<Workspace[]>
  createWorkspace: (args: { name: string; repoPath: string }) => Promise<Workspace>
  openWorkspace: (args: { id: string }) => Promise<Workspace>
  deleteWorkspace: (args: { id: string }) => Promise<void>
  selectDirectory: () => Promise<string | null>
  getWorkspaceSettings: (args: { workspaceId: string }) => Promise<Record<string, unknown>>
  updateWorkspaceSettings: (args: {
    workspaceId: string
    settings: Record<string, unknown>
  }) => Promise<void>
  updateAuthSettings: (args: {
    workspaceId: string
    authMode: string
    anthropicApiKey?: string
  }) => Promise<{ success: boolean }>
  saveClipboardImage: (args: { dataUrl: string; conversationId: string }) => Promise<string>
  readImageBase64: (args: { filePath: string }) => Promise<string>

  // Chat
  sendMessage: (args: {
    conversationId: string
    text: string
    attachments?: string[]
  }) => Promise<void>
  getConversations: (args: { workspaceId: string }) => Promise<Conversation[]>
  createConversation: (args: {
    workspaceId: string
    title?: string
    mode?: ConversationMode
  }) => Promise<Conversation>
  getMessages: (args: { conversationId: string }) => Promise<Message[]>
  deleteConversation: (args: { conversationId: string }) => Promise<void>
  updateConversationMode: (args: {
    conversationId: string
    mode: ConversationMode
  }) => Promise<Conversation>
  renameConversation: (args: { conversationId: string; title: string }) => Promise<Conversation>
  stopGeneration: () => Promise<void>
  compactConversation: () => Promise<void>
  executePlan: (args: {
    conversationId: string
    strategy: ExecutionStrategy
    tasks: DecomposedTask[]
  }) => Promise<void>
  executeInvestigationFix: (args: {
    conversationId: string
    strategy: ExecutionStrategy
    report: InvestigationReport
  }) => Promise<void>

  // Chat commands
  completeConversation: (args: {
    conversationId: string
    branchName: string
    commitMessage: string
    description: string
  }) => Promise<CompleteResult>
  closeConversation: (args: { conversationId: string }) => Promise<void>
  getFileChanges: (args: { conversationId: string }) => Promise<FileChange[]>
  generatePrDescription: (args: { conversationId: string }) => Promise<{ description: string }>

  // Agents
  getAgentStatuses: () => Promise<AgentStatus[]>
  stopAllAgents: () => Promise<string[]>

  // Orchestrator
  startOrchestrator: (workspacePath: string) => Promise<void>

  // Specialists
  listSpecialists: () => Promise<Specialist[]>
  getSpecialist: (args: { id: string }) => Promise<Specialist>
  createSpecialist: (args: CreateSpecialistInput) => Promise<Specialist>
  updateSpecialist: (args: { id: string } & UpdateSpecialistInput) => Promise<Specialist>
  deleteSpecialist: (args: { id: string }) => Promise<void>
  assignSkillToSpecialist: (args: { specialistId: string; skillId: string }) => Promise<void>
  removeSkillFromSpecialist: (args: { specialistId: string; skillId: string }) => Promise<void>

  // Specialist Marketplace
  deploySpecialist: (args: { workspacePath: string; specialistId: string }) => Promise<void>
  undeploySpecialist: (args: { workspacePath: string; specialistId: string }) => Promise<void>
  updateSpecialistConfig: (args: {
    id: string
    displayName?: string
    icon?: string
    color?: string
    alias?: string | null
    avatarUrl?: string | null
    priority?: number
  }) => Promise<Specialist>
  getMarketplace: (args: { workspacePath: string }) => Promise<MarketplaceSpecialist[]>

  // Skills
  listSkills: () => Promise<Skill[]>
  getSkill: (args: { id: string }) => Promise<Skill>
  importSkill: (args: { filePath: string }) => Promise<Skill>
  updateSkill: (args: { id: string; name?: string; description?: string }) => Promise<Skill>
  deleteSkill: (args: { id: string }) => Promise<void>
  activateSkill: (args: { id: string }) => Promise<Skill>
  deactivateSkill: (args: { id: string }) => Promise<Skill>
  selectSkillFile: () => Promise<string | null>

  // Workspace Deploy
  scanWorkspaceClaude: (args: { workspacePath: string }) => Promise<WorkspaceClaudeStatus>
  activateAgents: (args: { workspacePath: string }) => Promise<ActivationResult>
  readWorkspaceFile: (args: { filePath: string }) => Promise<string>
  writeWorkspaceFile: (args: { filePath: string; content: string }) => Promise<void>
  scanWorkspaceSkills: (args: { workspacePath: string }) => Promise<DiscoveredSkill[]>
  scanWorkspaceAgents: (args: { workspacePath: string }) => Promise<DiscoveredAgent[]>
  confirmClaudeMd: (args: { workspacePath: string; content: string }) => Promise<void>
  cancelActivation: () => Promise<void>
  cleanActivation: (args: { workspacePath: string; removeClaudeMd?: boolean }) => Promise<void>

  // Agent/Skill individual delete & sync
  deleteAgentFromWorkspace: (args: { workspacePath: string; filename: string }) => Promise<void>
  syncAgentToWorkspace: (args: { workspacePath: string; filename: string }) => Promise<void>
  deleteSkillFromWorkspace: (args: { workspacePath: string; skillName: string }) => Promise<void>
  syncSkillToWorkspace: (args: { workspacePath: string; skillName: string }) => Promise<void>

  // Agent activate/deactivate
  activateAgent: (args: { workspacePath: string; agentName: string }) => Promise<void>
  deactivateAgent: (args: { workspacePath: string; agentName: string }) => Promise<void>

  // Bulk delete all agents/skills
  deleteAllAgents: (args: { workspacePath: string }) => Promise<void>
  deleteAllSkills: (args: { workspacePath: string }) => Promise<void>

  // Deploy all (inactive) to workspace
  deployAll: (args: { workspacePath: string }) => Promise<{ agents: number; skills: number }>

  // Worktrees
  listWorktrees: (args: { conversationId: string }) => Promise<AgentWorktree[]>
  getWorktreeDiff: (args: { worktreeId: string }) => Promise<string>
  mergeWorktree: (args: {
    worktreeId: string
  }) => Promise<{ success: boolean; conflictedFiles?: string[] }>
  mergeAllWorktrees: (args: { conversationId: string }) => Promise<MergeAllResult>
  abandonWorktree: (args: { worktreeId: string }) => Promise<void>

  // Pixel Office
  popoutPixelOffice: () => Promise<void>

  // Memory (auto memory system)
  listMemories: (args: { workspaceId: string }) => Promise<Memory[]>
  searchMemories: (args: { workspaceId: string; query: string }) => Promise<Memory[]>
  createMemory: (args: {
    workspaceId: string | null
    type: MemoryType
    title: string
    content: string
    tags?: string[]
    importance?: number
  }) => Promise<Memory>
  updateMemory: (args: {
    id: string
    title?: string
    content?: string
    tags?: string[]
    importance?: number
  }) => Promise<Memory>
  deleteMemory: (args: { id: string }) => Promise<void>
  memoryUpdateSetting: (args: { workspaceId: string; memoryEnabled: boolean }) => Promise<void>

  // Memory Feed
  memorySelectDocument: () => Promise<string | null>
  memoryFeedCancel: () => Promise<void>
  memoryGetFeedTimestamps: (args: { workspaceId: string }) => Promise<WorkspaceFeedTimestamps>
  memoryFeedClaudeMd: (args: { workspacePath: string }) => Promise<MemoryFeedResult>
  memoryRegenerateClaudeMd: (args: {
    workspacePath: string
  }) => Promise<{ success: boolean; content: string; existing: string | null; error?: string }>
  memoryFeedCodebase: (args: { workspacePath: string }) => Promise<MemoryFeedResult>
  memoryFeedDocument: (args: {
    workspacePath: string
    filePath: string
  }) => Promise<MemoryFeedResult>
  onMemoryFeedProgress: (callback: (data: MemoryFeedProgress) => void) => () => void

  // Dream (auto consolidation)
  triggerDream: (args: { workspaceId: string }) => Promise<DreamRun>
  cancelDream: (args: { workspaceId: string }) => Promise<void>
  getDreamStatus: (args: { workspaceId: string }) => Promise<DreamRun | null>
  getDreamHistory: (args: { workspaceId: string; limit?: number }) => Promise<DreamRun[]>
  onDreamProgress: (callback: (data: DreamProgress) => void) => () => void

  computeSyncDiff: (args: { workspacePath: string }) => Promise<SyncDiff>
  applySync: (args: { workspacePath: string; skipRemoved?: boolean }) => Promise<SyncResult>

  // Tokens
  getWorkspaceTokenSummary: (args: { workspaceId: string }) => Promise<TokenSummary>
  getConversationTokenSummary: (args: { conversationId: string }) => Promise<TokenSummary>
  getRecentSessions: (args: {
    workspaceId: string
    limit?: number
  }) => Promise<AgentSessionRecord[]>

  // Ideas
  listIdeas: (args: { workspaceId: string }) => Promise<Idea[]>
  createIdea: (args: { workspaceId: string; title: string; description: string }) => Promise<Idea>
  updateIdea: (args: { id: string; title?: string; description?: string }) => Promise<Idea>
  deleteIdea: (args: { id: string }) => Promise<void>
  startIdeaGrill: (args: {
    ideaId: string
    workspaceId: string
  }) => Promise<{ idea: Idea; conversation: Conversation }>
  convertIdeaDirect: (args: {
    ideaId: string
    workspaceId: string
  }) => Promise<{ idea: Idea; conversation: Conversation }>
  completeIdeaFromGrill: (args: {
    conversationId: string
    summary?: string
  }) => Promise<Idea | null>
  saveIdeaGrillDecisions: (args: {
    ideaId: string
    decisions: string
  }) => Promise<Idea>

  // Auto-update
  checkForUpdate: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>

  // Events (main → renderer) with cleanup
  onActivationProgress: (callback: (data: ActivationProgressEvent) => void) => () => void
  onMessageChunk: (
    callback: (data: {
      conversationId: string
      chunk: string
      role: string
      taskId?: string
      specialist?: string
      toolActivity?: {
        id: string
        toolName: string
        status: 'running' | 'completed' | 'error'
        input?: string
        startedAt?: number
        completedAt?: number
      }
      compactNeeded?: {
        level: string
        inputTokens: number
      }
    }) => void
  ) => () => void
  onMessageComplete: (
    callback: (data: { conversationId: string; messageId: string; taskId?: string }) => void
  ) => () => void
  onHandoff: (
    callback: (data: {
      conversationId: string
      summary: string
      specialists: string[]
      mode: string
    }) => void
  ) => () => void
  onGrillComplete: (
    callback: (data: {
      conversationId: string
      summary: string
      proposedTasks: GrillProposedTask[]
    }) => void
  ) => () => void
  onGrillQuestion: (
    callback: (data: { conversationId: string; questions: GrillQuestion[] }) => void
  ) => () => void
  onAskQuestion: (
    callback: (data: { conversationId: string; questions: GrillQuestion[] }) => void
  ) => () => void
  onGrillEvaluation: (
    callback: (data: {
      conversationId: string
      trackId?: GrillTrackId
      score: number
      scoreLabel: string
      feedback: string
      questions: GrillQuestion[]
      suggestedNextTrack?: { trackId: GrillTrackId; reason: string }
    }) => void
  ) => () => void
  onTaskPlan: (callback: (data: TaskPlan) => void) => () => void
  onInvestigationReport: (
    callback: (data: {
      conversationId: string
      taskId: string
      specialist: string
      report: InvestigationReport
    }) => void
  ) => () => void
  onTaskProgress: (callback: (data: TaskExecutionProgress) => void) => () => void
  onOrchestratorReady: (callback: () => void) => () => void
  onAgentTaskChunk: (
    callback: (data: { agentId: string; taskId: string; text: string }) => void
  ) => () => void
  onAgentStatusUpdate: (
    callback: (data: {
      agentId: string
      agentType: string
      status: string
      elapsedMs: number
      tokenUsage: number
      model?: 'haiku' | 'sonnet' | 'opus'
      complexityTier?: 'simple' | 'moderate' | 'complex'
    }) => void
  ) => () => void

  // Auto-update events
  onUpdateAvailable: (
    callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void
  ) => () => void
  onUpdateNotAvailable: (callback: () => void) => () => void
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void
  onUpdateProgress: (
    callback: (progress: {
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }) => void
  ) => () => void
  onUpdateError: (callback: (message: string) => void) => () => void

  // Documents
  listDocs: (args: { workspacePath: string }) => Promise<DocFile[]>
  readDocFile: (args: { filePath: string }) => Promise<string>
  renderMermaid: (args: { definition: string; id?: string }) => Promise<{ svg: string }>

  // GitHub
  saveGitHubToken: (args: { workspaceId: string; token: string }) => Promise<{ login: string }>
  validateGitHubToken: (args: {
    token: string
  }) => Promise<{ valid: boolean; login: string; scopes: string[] }>
  getGitHubStatus: (args: {
    workspaceId: string
  }) => Promise<{ configured: boolean; login?: string }>
  removeGitHubToken: (args: { workspaceId: string }) => Promise<void>

  // Repository
  initRepo: (args: { workspaceId: string }) => Promise<void>
  setRepoRemote: (args: { workspaceId: string; remoteUrl: string }) => Promise<void>
  getRepoInfo: (args: { workspaceId: string }) => Promise<RepoInfo>
  hasUnsavedChanges: (args: {
    conversationId: string
  }) => Promise<{ hasChanges: boolean; fileCount: number; files: string[] }>

  // User Profile
  getUserProfile: () => Promise<UserProfile | null>
  upsertUserProfile: (args: { displayName: string; avatarKey: string }) => Promise<UserProfile>

  // Core Agent Aliases
  listCoreAgentAliases: () => Promise<CoreAgentAlias[]>
  upsertCoreAgentAlias: (args: {
    agentRole: 'generalist' | 'coordinator'
    alias: string | null
    avatarKey: string | null
  }) => Promise<CoreAgentAlias>

  // Renderer logging bridge
  log: (args: {
    level: 'error' | 'warn' | 'info' | 'debug'
    message: string
    data?: unknown[]
  }) => void

  // Zoom
  zoomIn: () => Promise<number>
  zoomOut: () => Promise<number>
  zoomReset: () => Promise<number>
  zoomSet: (factor: number) => Promise<number>
  zoomGet: () => Promise<number>
  onZoomChanged: (callback: (factor: number) => void) => () => void

  // Shell
  showItemInFolder: (filePath: string) => Promise<void>

  // Checkpoints
  listCheckpoints: (args: { conversationId: string }) => Promise<
    { id: string; label: string; gitBranch?: string; gitCommitSha?: string; createdAt: string }[]
  >
  restoreCheckpoint: (args: {
    checkpointId: string
  }) => Promise<{ success: boolean; message: string }>

  // Cost tracking
  getCostSummary: (args: { workspaceId: string }) => Promise<{
    totalCostCents: number
    totalTokens: number
    sessionCount: number
    byAgent: { agentType: string; costCents: number; tokens: number; sessions: number }[]
  }>
  checkBudget: (args: { workspaceId: string }) => Promise<{
    currentCostCents: number
    dailyBudgetCents: number
    sessionBudgetCents: number
    dailyPercentUsed: number
    dailyWarning: boolean
    dailyExceeded: boolean
  }>
  onBudgetWarning: (
    callback: (data: {
      workspaceId: string
      currentCostCents: number
      budgetCents: number
      percentUsed: number
    }) => void
  ) => () => void
  onBudgetExceeded: (
    callback: (data: {
      workspaceId: string
      currentCostCents: number
      budgetCents: number
    }) => void
  ) => () => void

  // Events (audit log)
  getRecentEvents: (args?: { limit?: number }) => Promise<
    {
      id: string
      sessionId: string | null
      conversationId: string | null
      workspaceId: string | null
      eventType: string
      category: string
      message: string
      dataJson: string
      agentId: string | null
      model: string | null
      createdAt: string
    }[]
  >
  getConversationEvents: (args: {
    conversationId: string
    limit?: number
  }) => Promise<
    {
      id: string
      sessionId: string | null
      conversationId: string | null
      workspaceId: string | null
      eventType: string
      category: string
      message: string
      dataJson: string
      agentId: string | null
      model: string | null
      createdAt: string
    }[]
  >

  // Gate results
  getGateResults: (args: { conversationId: string }) => Promise<
    {
      id: string
      sessionId: string | null
      conversationId: string | null
      taskId: string | null
      agentId: string | null
      gateType: string
      passed: boolean
      summary: string
      createdAt: string
    }[]
  >

  // Agent events (specialist pool)
  onAbandonmentDetected: (
    callback: (data: { taskId: string; specialist: string; pattern: string }) => void
  ) => () => void
  onGateFailure: (
    callback: (data: {
      taskId: string
      specialist: string
      gate: { type: string; passed: boolean; summary: string }
    }) => void
  ) => () => void

  // Tool approval
  onToolApprovalRequest: (
    callback: (data: {
      requestId: string
      toolName: string
      toolInput: string
      agentId: string
      taskId?: string
    }) => void
  ) => () => void
  respondToolApproval: (requestId: string, approved: boolean) => Promise<void>
}

declare global {
  interface Window {
    api: Api
  }
}
