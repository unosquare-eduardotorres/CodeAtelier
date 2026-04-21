import type {
  Workspace,
  Conversation,
  ConversationMode,
  Message,
  AgentStatus,
  Specialist,
  ConversationSpecialist,
  SpecialistConversationAction,
  SpecialistConversationHistoryEntry,
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
  ExecutionStrategy,
  InvestigationDepth,
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
  CoreAgentPrompt,
  MarketplaceSpecialist,
  SubscriptionCheckResult,
  AutoConfigureResult,
  SpecialistTokenEstimate,
  AppPreferences,
  OllamaStatus,
  PullProgress,
  IndexingState,
  CodeGraphIndexingState,
  SchedulingWeights,
  ContextUsage,
  StructuredPlan,
  BugCouncilResult,
  BugCouncilActivatedEvent,
  BugCouncilCompleteEvent
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
  }) => Promise<{ requestId: string }>
  getConversations: (args: { workspaceId: string }) => Promise<Conversation[]>
  createConversation: (args: {
    workspaceId: string
    title?: string
    mode?: ConversationMode
    personaSpecialistId?: string
  }) => Promise<Conversation>
  updatePersona: (args: {
    conversationId: string
    personaSpecialistId: string | null
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
    investigationDepth?: InvestigationDepth
  }) => Promise<void>
  executeInvestigationFix: (args: {
    conversationId: string
    strategy: ExecutionStrategy
    report: InvestigationReport
  }) => Promise<void>

  /** Direct plan-to-build: skip generalist round-trip when user clicks "Build This" on inline plan */
  buildFromPlan: (args: {
    conversationId: string
    plan: StructuredPlan
    planContent: string
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
  /** Strategy M + θ: Cache efficiency metrics with per-turn breakdown for dashboard */
  getCacheEfficiency: () => Promise<{
    hitRate: number
    savedTokens: number
    totalInput: number
    turns: number
    turnBreakdown: Array<{
      turn: number
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheCreationTokens: number
      cacheHitRate: number
      timestamp: number
    }>
  }>

  // Agent lifecycle
  startAgent: (workspacePath: string) => Promise<void>

  // Specialists
  listSpecialists: () => Promise<Specialist[]>
  getSpecialist: (args: { id: string }) => Promise<Specialist>
  createSpecialist: (args: CreateSpecialistInput) => Promise<Specialist>
  updateSpecialist: (args: { id: string } & UpdateSpecialistInput) => Promise<Specialist>
  deleteSpecialist: (args: { id: string }) => Promise<void>
  assignSkillToSpecialist: (args: { specialistId: string; skillId: string }) => Promise<void>
  removeSkillFromSpecialist: (args: { specialistId: string; skillId: string }) => Promise<void>
  reorderSpecialists: (args: { orderedIds: string[] }) => Promise<void>
  getConversationSpecialists: (args: {
    conversationId: string
  }) => Promise<ConversationSpecialist[]>
  addConversationSpecialist: (args: {
    conversationId: string
    specialistId: string
  }) => Promise<ConversationSpecialist>
  removeConversationSpecialist: (args: {
    conversationId: string
    specialistId: string
  }) => Promise<void>
  replaceConversationSpecialists: (args: {
    conversationId: string
    specialistIds: string[]
  }) => Promise<ConversationSpecialist[]>
  getConversationHistory: (args: {
    conversationId: string
    limit?: number
  }) => Promise<SpecialistConversationHistoryEntry[]>
  addConversationHistoryEntry: (args: {
    conversationId: string
    specialistId: string
    action: SpecialistConversationAction
  }) => Promise<SpecialistConversationHistoryEntry>
  clearConversationHistory: (args: { conversationId: string }) => Promise<void>

  // Conversation Specialist Activation (skill gating)
  listConvSpecialists: (args: { conversationId: string }) => Promise<ConversationSpecialist[]>
  upsertConvSpecialist: (args: {
    conversationId: string
    specialistId: string
    isActive?: boolean
    skillsEnabled?: boolean
    skillOverrides?: string[] | null
  }) => Promise<void>
  removeConvSpecialist: (args: { conversationId: string; specialistId: string }) => Promise<void>
  resetConvSpecialists: (args: { conversationId: string }) => Promise<void>
  estimateConvTokens: (args: { conversationId: string }) => Promise<SpecialistTokenEstimate[]>

  // App Preferences
  getAppPreferences: () => Promise<AppPreferences>
  setAppPreference: (args: { key: string; value: string }) => Promise<void>

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

  // Cache metrics (Strategy 15)
  getCacheMetrics: () => Promise<{
    totalInputTokens: number
    totalOutputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    cacheHitRate: number
    taskCount: number
  }>

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
  saveOfficeLayout: (args: { layout: string }) => Promise<{ success: boolean }>
  loadOfficeLayout: () => Promise<{ layout: string | null }>
  exportOfficeLayout: (args: { layout: string }) => Promise<{ success: boolean; path?: string }>
  importOfficeLayout: () => Promise<{ layout: string | null }>

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
  memoryRegenerateClaudeMd: (args: {
    workspacePath: string
  }) => Promise<{ success: boolean; content: string; existing: string | null; error?: string }>
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
  saveIdeaGrillDecisions: (args: { ideaId: string; decisions: string }) => Promise<Idea>

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
      requestId?: string
      toolActivity?: {
        id: string
        toolName: string
        status: 'running' | 'completed' | 'error'
        input?: string
        startedAt?: number
        completedAt?: number
        elapsedSeconds?: number
      }
      compactNeeded?: {
        level: string
        inputTokens: number
      }
      turnBoundary?: boolean
      turnId?: string
    }) => void
  ) => () => void
  onMessageComplete: (
    callback: (data: {
      conversationId: string
      messageId: string
      taskId?: string
      isHandoff?: boolean
      requestId?: string
    }) => void
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
  onInvestigationReport: (
    callback: (data: {
      conversationId: string
      taskId: string
      specialist: string
      report: InvestigationReport
    }) => void
  ) => () => void
  onTaskProgress: (callback: (data: TaskExecutionProgress) => void) => () => void
  onBuildTasks: (
    callback: (data: { conversationId: string; tasks: DecomposedTask[] }) => void
  ) => () => void
  onTaskRetry: (
    callback: (data: {
      taskId: string
      specialist: string
      attempt: number
      maxRetries: number
      escalation?: { fromModel: string; toModel: string }
      reason: string
    }) => void
  ) => () => void
  onAgentReady: (callback: () => void) => () => void
  onAgentTaskChunk: (
    callback: (data: { agentId: string; taskId: string; text: string }) => void
  ) => () => void
  onAgentStatusUpdate: (
    callback: (data: {
      agentId: string
      agentType: string
      status: string
      currentTask?: string
      elapsedMs: number
      tokenUsage: number
      model?: 'haiku' | 'sonnet' | 'opus'
      complexityTier?: 'simple' | 'moderate' | 'complex'
      activeMcpTools?: string[]
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

  // Code Changes
  getFileDetails: (args: {
    conversationId: string
  }) => Promise<
    Array<{ filePath: string; changeType: 'created' | 'modified' | 'deleted'; staged: boolean }>
  >
  getFileDiff: (args: {
    conversationId: string
    filePath: string
  }) => Promise<{ oldContent: string; newContent: string; language: string }>
  commitFiles: (args: {
    conversationId: string
    filePaths: string[]
    message: string
  }) => Promise<{ commitHash: string }>
  repoPush: (args: { conversationId: string }) => Promise<{ branch: string; remote: string }>
  getPushStatus: (args: {
    conversationId: string
  }) => Promise<{ branch: string; commitsAhead: number; hasRemote: boolean }>
  generateCommitMessage: (args: {
    conversationId: string
    filePaths: string[]
  }) => Promise<{ message: string }>
  createPr: (args: {
    conversationId: string
    title: string
    body: string
    base: string
    head: string
  }) => Promise<{ url: string; number: number }>

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

  // Core Agent Prompts
  listCoreAgentPrompts: () => Promise<CoreAgentPrompt[]>
  getCoreAgentPrompt: (args: {
    agentRole: 'generalist'
    mode: 'plan' | 'build'
  }) => Promise<CoreAgentPrompt | undefined>
  upsertCoreAgentPrompt: (args: {
    agentRole: 'generalist'
    mode: 'plan' | 'build'
    promptText: string
  }) => Promise<CoreAgentPrompt>
  resetCoreAgentPrompt: (args: {
    agentRole: 'generalist'
    mode: 'plan' | 'build'
  }) => Promise<CoreAgentPrompt>

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
  listCheckpoints: (args: {
    conversationId: string
  }) => Promise<
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
    cacheReadTokens: number
    cacheCreationTokens: number
    cacheHitRate: number
    byAgent: { agentType: string; costCents: number; tokens: number; sessions: number }[]
  }>
  getConversationCost: (args: { conversationId: string }) => Promise<number>
  getWorkspaceConversationCosts: (args: {
    workspaceId: string
  }) => Promise<{ conversationId: string; costCents: number; totalTokens: number }[]>
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
    callback: (data: { workspaceId: string; currentCostCents: number; budgetCents: number }) => void
  ) => () => void

  // Events (audit log)
  getRecentEvents: (args?: { workspaceId?: string; limit?: number }) => Promise<
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
  getConversationEvents: (args: { conversationId: string; limit?: number }) => Promise<
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
  setToolApprovalMode: (mode: 'dangerous-only' | 'accept-all') => Promise<void>
  getToolApprovalMode: () => Promise<string>

  // Checkpoint approval
  onCheckpointApprovalRequest: (
    callback: (data: {
      id: string
      type: 'phase_gate' | 'merge_approval' | 'destructive_action'
      title: string
      summary: string
      details: {
        what: string
        why: string
        risk: string
        changedFiles?: string[]
        testResults?: string
      }
      createdAt: string
    }) => void
  ) => () => void
  respondCheckpointApproval: (checkpointId: string, approved: boolean) => Promise<void>

  // Hooks
  listHooks: () => Promise<
    Array<{
      event: string
      name: string
      command: string
      blocking: boolean
      condition?: { mode?: string; model?: string; agent?: string }
      timeout?: number
    }>
  >
  reloadHooks: (args: { workspacePath: string }) => Promise<
    Array<{
      event: string
      name: string
      command: string
      blocking: boolean
      condition?: { mode?: string; model?: string; agent?: string }
      timeout?: number
    }>
  >

  // AI Subscriptions
  validateSubscriptions: () => Promise<SubscriptionCheckResult>
  checkClaudeCli: () => Promise<{
    installed: boolean
    version: string | null
    error: string | null
  }>
  autoConfigureClaude: () => Promise<AutoConfigureResult>

  // Ollama
  ollamaCheckStatus: () => Promise<OllamaStatus>
  ollamaPullModel: (args: { model: string }) => Promise<void>
  ollamaCancelPull: () => Promise<void>
  ollamaRemoveModel: (args: { model: string }) => Promise<void>
  ollamaStart: () => Promise<boolean>
  onOllamaPullProgress: (callback: (data: PullProgress) => void) => () => void
  onOllamaPullComplete: (callback: (model: string) => void) => () => void
  onOllamaPullError: (callback: (error: string) => void) => () => void

  // Indexing (semantic search)
  indexingStart: (args: { workspaceId: string }) => Promise<void>
  indexingPause: (args: { workspaceId: string }) => Promise<void>
  indexingResume: (args: { workspaceId: string }) => Promise<void>
  indexingCancel: (args: { workspaceId: string }) => Promise<void>
  indexingGetStatus: (args: { workspaceId: string }) => Promise<IndexingState>
  loadPersistedIndex: (args: {
    workspaceId: string
  }) => Promise<{ loaded: boolean; status: string; symbolCount?: number }>
  onIndexingProgress: (callback: (state: IndexingState) => void) => () => void
  // Code Graph (persisted repomap)
  codeGraphIndexStart: (args: { workspaceId: string }) => Promise<void>
  codeGraphGetStatus: (args: { workspaceId: string }) => Promise<CodeGraphIndexingState>
  codeGraphHasIndex: (args: { workspaceId: string }) => Promise<boolean>
  onCodeGraphProgress: (callback: (state: CodeGraphIndexingState) => void) => () => void

  // Scheduling Strategy
  getSchedulingWeights: () => Promise<SchedulingWeights>
  setSchedulingWeights: (weights: SchedulingWeights) => Promise<void>

  // Context Usage
  getContextUsage: (args: { conversationId: string }) => Promise<ContextUsage>

  // Conversation Reorder
  reorderConversations: (args: { orderedIds: string[] }) => Promise<void>

  // Bug Council
  getBugCouncilSession: (args: { sessionId: string }) => Promise<BugCouncilResult | null>
  listBugCouncilSessions: (args: { conversationId: string }) => Promise<BugCouncilResult[]>
  onBugCouncilActivated: (callback: (data: BugCouncilActivatedEvent) => void) => () => void
  onBugCouncilComplete: (callback: (data: BugCouncilCompleteEvent) => void) => () => void

  // SDK Events
  onRateLimitEvent: (
    callback: (data: {
      status: string
      utilization?: number
      resetsAt?: number
      rateLimitType?: string
    }) => void
  ) => () => void
  onPromptSuggestion: (
    callback: (data: { conversationId: string; suggestion: string }) => void
  ) => () => void
  onApiRetry: (
    callback: (data: {
      attempt: number
      maxRetries: number
      retryDelayMs: number
      errorStatus: number | null
    }) => void
  ) => () => void
  onSessionState: (callback: (data: { state: string }) => void) => () => void
  onSessionRecovery: (
    callback: (data: { conversationId: string; phase: string; message: string }) => void
  ) => () => void
  onStateChange: (
    callback: (data: {
      conversationId: string | null
      from: string
      to: string
      event: string
    }) => void
  ) => () => void

  // SDK Control — Query instance methods
  sdkGetContextUsage: () => Promise<{
    totalTokens: number
    maxTokens: number
    percentage: number
    model: string
    categories: { name: string; tokens: number; color: string }[]
  } | null>
  sdkStopTask: (args: { taskId: string }) => Promise<unknown>
  sdkInterrupt: () => Promise<unknown>
  sdkAccountInfo: () => Promise<unknown>
  sdkSupportedModels: () => Promise<unknown>
  sdkMcpServerStatus: () => Promise<unknown>
  sdkSetModel: (args: { model?: string }) => Promise<unknown>
  sdkSetPermissionMode: (args: { mode: string }) => Promise<unknown>
  sdkApplyFlagSettings: (args: { settings: Record<string, unknown> }) => Promise<unknown>
  sdkSetMcpServers: (args: { servers: Record<string, unknown> }) => Promise<unknown>
  sdkRewindFiles: (args: { userMessageId: string; dryRun?: boolean }) => Promise<unknown>
  sdkReconnectMcp: (args: { serverName: string }) => Promise<unknown>
  sdkSupportedAgents: () => Promise<unknown>
  sdkToggleMcpServer: (args: { serverName: string; enabled: boolean }) => Promise<unknown>

  // SDK Subagent inspection (0.2.96+)
  sdkListSubagents: (args: { sessionId: string }) => Promise<string[]>
  sdkGetSubagentMessages: (args: { sessionId: string; subagentId: string }) => Promise<unknown[]>

  // SDK Query — close + seedReadState
  sdkCloseQuery: () => Promise<void>
  sdkSeedReadState: (args: { path: string; mtime: number }) => Promise<void>

  // SDK Elicitation (enriched — via elicitation.service)
  onSdkElicitationRequest: (callback: (data: unknown) => void) => () => void
  sdkElicitationRespond: (args: {
    requestId: string
    action: string
    content?: Record<string, unknown>
  }) => Promise<void>

  // Session Management (SDK top-level functions)
  sessionList: (args?: {
    dir?: string
    limit?: number
    offset?: number
  }) => Promise<unknown[]>
  sessionGetInfo: (args: { sessionId: string; dir?: string }) => Promise<unknown>
  sessionGetMessages: (args: {
    sessionId: string
    dir?: string
    includeSystemMessages?: boolean
  }) => Promise<unknown[]>
  sessionRename: (args: { sessionId: string; title: string; dir?: string }) => Promise<void>
  sessionTag: (args: { sessionId: string; tag: string | null; dir?: string }) => Promise<void>
  sessionFork: (args: {
    sessionId: string
    upToMessageId?: string
    title?: string
    dir?: string
  }) => Promise<{ sessionId: string }>

  // Chat resume at checkpoint
  chatResumeAt: (args: { conversationId: string; messageId: string }) => Promise<void>
}

declare global {
  interface Window {
    api: Api
  }
}
