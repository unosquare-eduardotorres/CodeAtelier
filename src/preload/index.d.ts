import type {
  Workspace,
  Conversation,
  ConversationMode,
  Message,
  AgentStatus,
  Specialist,
  ConversationSpecialist,
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
  ExecutionStrategy,
  InvestigationDepth,
  CompleteResult,
  GrillProposedTask,
  GrillQuestion,
  GrillTrackId,
  Memory,
  MemoryType,
  MemoryFeedProgress,
  MemoryFeedResult,
  WorkspaceFeedTimestamps,
  TokenSummary,
  AgentSessionRecord,
  Idea,
  DocFile,
  RepoInfo,
  UserProfile,
  CoreAgentAlias,
  CoreAgentPrompt,
  SubscriptionCheckResult,
  AutoConfigureResult,
  SpecialistTokenEstimate,
  AppPreferences,
  EmbeddingModelStatus,
  EmbeddingModelProgress,
  SemanticSearchResult,
  OllamaStatus,
  OmlxExtendedStatus,
  PullProgress,
  IndexingState,
  CodeGraphIndexingState,
  ContextUsage,
  StructuredPlan,
  BugRecord,
  AuditRun,
  AuditPlanRecord,
  AuditMode,
  AuditTrackId,
  AuditSelectedSkills,
  AuditFinding,
  AuditProgressEvent,
  AuditResult,
  AuditStreamChunkEvent,
  AuditIntermediateEvent,
  LLMProvider,
  CommunicationTone,
  UpdateConfig,
  GrillDecision,
  GrillTrackScore,
  GrillStructuredPlan
} from '../shared/types'

interface Api {
  // Workspace
  listWorkspaces: () => Promise<Workspace[]>
  createWorkspace: (args: { name: string; repoPath: string }) => Promise<Workspace>
  openWorkspace: (args: { id: string }) => Promise<Workspace>
  deleteWorkspace: (args: { id: string }) => Promise<void>
  createProject: (args: {
    name: string
    parentFolder: string
    description: string
    attachments?: string[]
    grillDecisions?: GrillDecision[]
    trackScores?: GrillTrackScore[]
    tempGrillSessionId?: string
  }) => Promise<Workspace>
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
    llmProvider?: LLMProvider
    mcpOverrides?: Record<string, boolean>
    communicationTone?: CommunicationTone | null
  }) => Promise<Conversation>
  updatePersona: (args: {
    conversationId: string
    personaSpecialistId: string | null
  }) => Promise<Conversation>
  updateMcpOverrides: (args: {
    conversationId: string
    overrides: Record<string, boolean>
  }) => Promise<Conversation>
  updateConversationTone: (args: {
    conversationId: string
    communicationTone: CommunicationTone | null
  }) => Promise<Conversation>
  checkExternalMcp: (args: { command: string }) => Promise<{ available: boolean; path?: string }>
  getMessages: (args: { conversationId: string }) => Promise<Message[]>
  deleteConversation: (args: { conversationId: string }) => Promise<void>
  updateConversationMode: (args: {
    conversationId: string
    mode: ConversationMode
  }) => Promise<Conversation>
  updateEffort: (args: {
    conversationId: string
    effort: 'low' | 'medium' | 'high'
  }) => Promise<{ effort: string }>
  renameConversation: (args: { conversationId: string; title: string }) => Promise<Conversation>
  stopGeneration: () => Promise<void>
  getStreamingState: () => Promise<{
    isStreaming: boolean
    conversationId: string | null
    state: string
    requestId: string | null
  }>
  compactConversation: (args?: { extractNuance?: boolean }) => Promise<void>
  /** Accept DaVinci's specialist-swap proposal — rebuilds the session as the Project Specialist. */
  swapToSpecialist: (args: { workspaceId?: string; workspacePath?: string }) => Promise<void>

  // Chat commands
  completeConversation: (args: {
    conversationId: string
    branchName: string
    commitMessage: string
    description: string
  }) => Promise<CompleteResult>
  closeConversation: (args: { conversationId: string }) => Promise<void>
  getFileChanges: (args: {
    conversationId: string
  }) => Promise<
    Array<{ filePath: string; changeType: 'created' | 'modified' | 'deleted'; staged: boolean }>
  >
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
  startAgent: (args: string | { workspacePath: string; workspaceId: string }) => Promise<void>

  // Specialists
  listSpecialists: () => Promise<Specialist[]>
  getSpecialist: (args: { id: string }) => Promise<Specialist>
  createSpecialist: (args: CreateSpecialistInput) => Promise<Specialist>
  updateSpecialist: (args: { id: string } & UpdateSpecialistInput) => Promise<Specialist>
  deleteSpecialist: (args: { id: string }) => Promise<void>
  assignSkillToSpecialist: (args: { specialistId: string; skillId: string }) => Promise<void>
  removeSkillFromSpecialist: (args: { specialistId: string; skillId: string }) => Promise<void>
  reorderSpecialists: (args: { orderedIds: string[] }) => Promise<void>

  // Conversation Specialist Activation (skill gating)
  listConvSpecialists: (args: { conversationId: string }) => Promise<ConversationSpecialist[]>
  upsertConvSpecialist: (args: {
    conversationId: string
    specialistId: string
    isActive?: boolean
  }) => Promise<void>
  removeConvSpecialist: (args: { conversationId: string; specialistId: string }) => Promise<void>
  resetConvSpecialists: (args: { conversationId: string }) => Promise<void>
  estimateConvTokens: (args: { conversationId: string }) => Promise<SpecialistTokenEstimate[]>

  // App Preferences
  getAppPreferences: () => Promise<AppPreferences>
  setAppPreference: (args: { key: string; value: string }) => Promise<void>

  // Project Specialist (Phase 2 refactor)
  getProjectSpecialist: (args: { workspaceId: string }) => Promise<unknown | null>
  buildProjectSpecialist: (args: { workspaceId: string }) => Promise<unknown>
  rebuildProjectSpecialistPrompt: (args: { specialistId: string }) => Promise<unknown>
  rebuildProjectSpecialistSkills: (args: { specialistId: string }) => Promise<unknown>
  updateProjectSpecialistPrompt: (args: {
    specialistId: string
    prompt: string
  }) => Promise<{ ok: true }>
  toggleProjectSpecialistSkill: (args: {
    specialistId: string
    skillId: string
    enabled: boolean
  }) => Promise<{ ok: true }>
  attachProjectSpecialistSkill: (args: {
    specialistId: string
    skillId: string
  }) => Promise<{ ok: true }>
  detachProjectSpecialistSkill: (args: {
    specialistId: string
    skillId: string
  }) => Promise<{ ok: true }>
  getProjectSpecialistDrift: (args: { workspaceId: string }) => Promise<unknown | null>
  refreshProjectSpecialistRecommendations: (args: { specialistId: string }) => Promise<{ ok: true }>
  onProjectSpecialistBuildProgress: (
    callback: (data: { specialistId: string; phase: string; message: string; at: string }) => void
  ) => () => void

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
  getUpdateConfig: () => Promise<UpdateConfig>
  setUpdateConfig: (config: Partial<UpdateConfig>) => Promise<UpdateConfig>

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
      keepalive?: boolean
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
        breakdown?: import('../shared/types').ContextUsageBreakdown
      }
      turnBoundary?: boolean
      turnId?: string
      budgetCapReached?: {
        message: string
        canContinue: boolean
      }
      contextUsageUpdate?: {
        inputTokens: number
        contextWindowSize: number
        percentage: number
        cacheHitRate?: number
      }
      todoUpdate?: {
        action: 'add' | 'complete' | 'remove' | 'update'
        text: string
        index?: number
      }
    }) => void
  ) => () => void
  onMessageComplete: (
    callback: (data: {
      conversationId: string
      messageId: string
      taskId?: string
      requestId?: string
    }) => void
  ) => () => void
  onAskQuestion: (
    callback: (data: {
      conversationId: string
      questions: GrillQuestion[]
      action?: string
      requestId?: string
    }) => void
  ) => () => void
  respondToAskUser: (data: { requestId: string; response: string }) => Promise<void>
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
  onAgentReady: (callback: (data?: { workspaceId?: string }) => void) => () => void
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
      inputTokens?: number
      outputTokens?: number
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
  saveGitHubToken: (args: {
    workspaceId: string
    token: string
  }) => Promise<{ login: string; tokenType: string }>
  validateGitHubToken: (args: {
    token: string
  }) => Promise<{ valid: boolean; login: string; scopes: string[]; tokenType: string }>
  getGitHubStatus: (args: {
    workspaceId: string
  }) => Promise<{ configured: boolean; login?: string; tokenType?: string }>
  removeGitHubToken: (args: { workspaceId: string }) => Promise<void>

  // Repository
  initRepo: (args: { workspaceId: string }) => Promise<void>
  setRepoRemote: (args: { workspaceId: string; remoteUrl: string }) => Promise<void>
  getRepoInfo: (args: { workspaceId: string }) => Promise<RepoInfo>
  switchBranch: (args: {
    conversationId: string
  }) => Promise<{ switched: boolean; branch: string | null }>

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
    agentRole: 'da-vinci'
    alias: string | null
    avatarKey: string | null
  }) => Promise<CoreAgentAlias>

  // Core Agent Prompts
  listCoreAgentPrompts: () => Promise<CoreAgentPrompt[]>
  getCoreAgentPrompt: (args: {
    agentRole: 'da-vinci'
    mode: 'plan' | 'build' | 'danger'
  }) => Promise<CoreAgentPrompt | undefined>
  upsertCoreAgentPrompt: (args: {
    agentRole: 'da-vinci'
    mode: 'plan' | 'build' | 'danger'
    promptText: string
  }) => Promise<CoreAgentPrompt>
  resetCoreAgentPrompt: (args: {
    agentRole: 'da-vinci'
    mode: 'plan' | 'build' | 'danger'
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
  rewindToCheckpoint: (args: {
    checkpointId: string
    conversationId: string
  }) => Promise<{ success: boolean; message: string; messagesRemoved: number }>

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

  // Conversation Insights
  getConversationInsights: (args: {
    conversationId: string
  }) => Promise<{
    messageCount: { user: number; assistant: number }
    tokenSummary: { inputTokens: number; outputTokens: number }
    costCents: number
    durationMs: number
  }>

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

  // Agent events
  onAbandonmentDetected: (
    callback: (data: { taskId: string; specialist: string; pattern: string }) => void
  ) => () => void

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

  // Embedding Provider
  embeddingCheckStatus: () => Promise<EmbeddingModelStatus>
  embeddingInitialize: () => Promise<void>
  onEmbeddingModelProgress: (callback: (data: EmbeddingModelProgress) => void) => () => void
  onEmbeddingModelReady: (callback: () => void) => () => void
  onEmbeddingModelError: (callback: (error: string) => void) => () => void

  // Ollama — @deprecated for semantic search (still used by Local LLM chat)
  ollamaCheckStatus: (args?: { baseUrl?: string }) => Promise<OllamaStatus>
  ollamaPullModel: (args: { model: string; baseUrl?: string }) => Promise<void>
  ollamaCancelPull: () => Promise<void>
  ollamaRemoveModel: (args: { model: string; baseUrl?: string }) => Promise<void>
  ollamaStart: () => Promise<boolean>
  onOllamaPullProgress: (callback: (data: PullProgress) => void) => () => void
  onOllamaPullComplete: (callback: (model: string) => void) => () => void
  onOllamaPullError: (callback: (error: string) => void) => () => void

  // oMLX
  omlxCheckStatus: (args?: { baseUrl?: string; apiKey?: string }) => Promise<OmlxExtendedStatus>
  omlxStart: () => Promise<boolean>
  omlxAdminUrl: (args?: { baseUrl?: string }) => Promise<string>
  omlxLoadModel: (args: { modelId: string; baseUrl?: string; apiKey?: string }) => Promise<void>
  omlxUnloadModel: (args: { modelId: string; baseUrl?: string; apiKey?: string }) => Promise<void>

  // Platform
  getPlatformInfo: () => Promise<import('../shared/types').PlatformInfo>

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
  // Semantic Search query
  semanticSearchQuery: (args: {
    workspaceId: string
    query: string
    nResults?: number
  }) => Promise<SemanticSearchResult[]>

  // Code Graph (persisted repomap)
  codeGraphIndexStart: (args: { workspaceId: string }) => Promise<void>
  codeGraphGetStatus: (args: { workspaceId: string }) => Promise<CodeGraphIndexingState>
  codeGraphHasIndex: (args: { workspaceId: string }) => Promise<boolean>
  onCodeGraphProgress: (callback: (state: CodeGraphIndexingState) => void) => () => void

  // Context Usage
  getContextUsage: (args: { conversationId: string }) => Promise<ContextUsage>

  // Conversation Reorder
  reorderConversations: (args: { orderedIds: string[] }) => Promise<void>

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
  onAuthStatus: (callback: (data: { message: string; requestId?: string }) => void) => () => void
  onFilesPersisted: (
    callback: (data: { conversationId: string; files: string[]; requestId?: string }) => void
  ) => () => void
  onHookLifecycle: (
    callback: (data: { hookName?: string; hookState?: string; requestId?: string }) => void
  ) => () => void
  onLspDiagnostics: (
    callback: (data: {
      conversationId: string
      diagnostics: Array<{
        file: string
        line: number
        severity: 'error' | 'warning' | 'info' | 'hint'
        message: string
        source?: string
      }>
      requestId?: string
    }) => void
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
  sdkStopTask: (args: { taskId: string }) => Promise<unknown>
  sdkSupportedModels: () => Promise<unknown>

  // SDK Subagent inspection (0.2.96+)
  sdkListSubagents: (args: { sessionId: string }) => Promise<string[]>
  sdkGetSubagentMessages: (args: { sessionId: string; subagentId: string }) => Promise<unknown[]>

  // SDK Elicitation (enriched — via elicitation.service)
  onSdkElicitationRequest: (callback: (data: unknown) => void) => () => void
  sdkElicitationRespond: (args: {
    requestId: string
    action: string
    content?: Record<string, unknown>
  }) => Promise<void>

  // Session Management (SDK top-level functions)
  sessionList: (args?: { dir?: string; limit?: number; offset?: number }) => Promise<unknown[]>
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

  // SDK Diagnostics (@alpha — 0.2.138+)
  resolveSettings(): Promise<{
    success: boolean
    settings?: Record<string, unknown>
    error?: string
  }>

  // Chat resume at checkpoint
  chatResumeAt: (args: { conversationId: string; messageId: string }) => Promise<void>

  // Bug Tracker
  reportBug: (input: {
    process: 'main' | 'renderer' | 'preload'
    severity: 'error' | 'fatal'
    errorMessage: string
    stackTrace?: string
    sourceFile?: string
    sourceLine?: number
    sourceColumn?: number
    componentName?: string
    activeView?: string
    workspaceId?: string
    agentId?: string
    appVersion: string
    osInfo?: string
  }) => Promise<{ isNew: boolean; bugId: string }>
  getBugs: (filters?: {
    process?: 'main' | 'renderer' | 'preload'
    isResolved?: boolean
    workspaceId?: string
    sortBy?: 'last_seen_at' | 'occurrence_count' | 'severity'
    sortDir?: 'asc' | 'desc'
  }) => Promise<BugRecord[]>
  getBug: (args: { id: string }) => Promise<BugRecord | null>
  resolveBug: (args: { id: string }) => Promise<void>
  unresolveBug: (args: { id: string }) => Promise<void>
  deleteBug: (args: { id: string }) => Promise<void>
  updateBugNote: (args: { id: string; note: string }) => Promise<void>
  getBugCount: () => Promise<number>
  onNewBug: (callback: (bug: BugRecord) => void) => () => void

  // Audit (Workspace Health)
  auditStart: (args: {
    workspaceId: string
    mode: AuditMode
    tracks: AuditTrackId[]
    llmProvider?: LLMProvider
    selectedSkills?: AuditSelectedSkills
  }) => Promise<AuditRun>
  auditCancel: () => Promise<void>
  auditGetLatest: (args: { workspaceId: string }) => Promise<AuditRun | null>
  auditConvertFindings: (args: {
    workspaceId: string
    findings: AuditFinding[]
  }) => Promise<{ conversationId: string }>
  auditRerunTrack: (args: {
    workspaceId: string
    trackId: AuditTrackId
    mode: AuditMode
  }) => Promise<void>
  auditResume: (args: { workspaceId: string }) => Promise<AuditRun | null>
  auditExportMarkdown: (args: { workspaceId: string }) => Promise<void>
  auditGetHistory: (args: { workspaceId: string; limit?: number }) => Promise<AuditRun[]>
  auditDeleteRun: (args: { runId: string }) => Promise<{ deleted: boolean }>
  auditGeneratePlan: (args: {
    workspaceId: string
    runId: string
    findings: AuditFinding[]
  }) => Promise<AuditPlanRecord>
  auditGetPlans: (args: { runId: string }) => Promise<AuditPlanRecord[]>
  onAuditProgress: (cb: (data: AuditProgressEvent) => void) => () => void
  onAuditResult: (cb: (data: AuditResult) => void) => () => void
  onAuditComplete: (cb: (data: AuditRun) => void) => () => void
  onAuditStreamChunk: (cb: (data: AuditStreamChunkEvent) => void) => () => void
  onAuditIntermediate: (cb: (data: AuditIntermediateEvent) => void) => () => void

  // Grill (dedicated agent)
  grillEvaluate: (args: {
    workspaceId: string
    trackId: GrillTrackId
    ideaTitle: string
    ideaDescription: string
    iterationHistory?: string
    previousScore?: number
    ideaId?: string
    llmProvider?: LLMProvider
    greenfield?: boolean
    projectName?: string
  }) => Promise<void>
  grillCancel: () => Promise<void>
  onGrillStreamChunk: (
    cb: (data: { type: string; content?: string; toolActivity?: Record<string, unknown> }) => void
  ) => () => void
  onGrillEvaluationResult: (
    cb: (data: {
      trackId?: GrillTrackId
      score: number
      scoreLabel: string
      feedback: string
      questions: GrillQuestion[]
      suggestedNextTrack?: { trackId: GrillTrackId; reason: string }
    }) => void
  ) => () => void
  onGrillStreamComplete: (cb: () => void) => () => void
  grillCondenseRequirement: (args: { text: string }) => Promise<{ condensed: string }>
  grillGeneratePlan: (args: { sessionId: string; workspaceId: string }) => Promise<GrillStructuredPlan>
  grillGetStatus: (args: { workspaceId: string }) => Promise<{
    status: string
    ideaId: string
    trackId: string | null
    score: number | null
  } | null>
  grillGetSession: (args: { ideaId: string }) => Promise<unknown | null>
  grillSaveAnswers: (args: {
    sessionId: string
    questionStates: Record<string, unknown>
  }) => Promise<void>
  onGrillStatusChanged: (
    cb: (data: {
      status: string
      ideaId: string
      trackId: string | null
      score: number | null
    }) => void
  ) => () => void

  // MPA (Multi-Phased Agent Pipeline)
  mpaStart: (args: {
    workspaceId: string
    goal: string
    title: string
    goalType: string
    phases: string[]
    grillSessionId?: string
    grillDecisions?: Array<{ header: string; selectedOption: string; reason: string }>
  }) => Promise<{ started: boolean }>
  mpaCancel: (args?: { workspaceId?: string }) => Promise<{ cancelled: boolean }>
  mpaGetStatus: (args: { workspaceId: string }) => Promise<{
    status: string
    runId: string | null
    currentPhase: string | null
    phaseIndex: number
    totalPhases: number
    iteration: number
    awaitingApproval: boolean
  }>
  mpaGetRun: (args: { runId: string }) => Promise<unknown>
  mpaGetHistory: (args: { workspaceId: string; limit?: number }) => Promise<unknown[]>
  mpaClassifyGoal: (args: { goal: string }) => Promise<{
    goalType: string
    phases: string[]
    isValid: boolean
    rejectionReason?: string
    suggestedGoal?: string
  }>
  mpaApprovalRespond: (args: { runId: string; approved: boolean; feedback?: string }) => Promise<{ responded: boolean }>
  mpaResume: (args: { runId: string; workspaceId: string }) => Promise<{ resumed: boolean }>
  onMpaPhaseStart: (cb: (data: { workspaceId: string; runId: string; phaseId: string; phaseType: string; iteration: number; agentRole: string }) => void) => () => void
  onMpaPhaseProgress: (cb: (data: { workspaceId: string; runId: string; phaseId: string; phaseType: string; streamChunk: string }) => void) => () => void
  onMpaPhaseComplete: (cb: (data: { workspaceId: string; runId: string; phaseId: string; phaseType: string; status: string; tokensUsed: number }) => void) => () => void
  onMpaFeedbackLoop: (cb: (data: { workspaceId: string; runId: string; fromPhase: string; toPhase: string; iteration: number; reason: string }) => void) => () => void
  onMpaApprovalNeeded: (cb: (data: { workspaceId: string; runId: string; phaseId: string; artifactId: string; artifact: unknown }) => void) => () => void
  onMpaPipelineComplete: (cb: (data: { workspaceId: string; runId: string; status: string; totalTokens: number }) => void) => () => void

  // Council (LLM Council — multi-advisor review)
  councilStart: (args: {
    workspaceId: string
    inputType: string
    planContent: string
    structuredPlan?: unknown
    originalUserRequest: string
    workspaceContext?: string
    filesInScope?: string[]
    conversationId?: string
    llmProvider?: string
    grillSessionId?: string
  }) => Promise<{ sessionId: string }>
  councilCancel: (args?: { workspaceId?: string }) => Promise<void>
  councilGetSession: (args: { workspaceId: string }) => Promise<unknown>
  onCouncilPhaseChanged: (cb: (data: { workspaceId: string; phase: string }) => void) => () => void
  onCouncilMemberStream: (cb: (data: { advisorRole: string; type: string; content?: string; toolActivity?: Record<string, unknown> }) => void) => () => void
  onCouncilMemberComplete: (cb: (data: { advisorRole: string; review: unknown }) => void) => () => void
  onCouncilPeerReviewComplete: (cb: (data: { peerReviews: unknown[] }) => void) => () => void
  onCouncilVerdict: (cb: (data: { verdict: unknown }) => void) => () => void
  onCouncilComplete: (cb: () => void) => () => void
  councilResume: (args: { sessionId: string; workspaceId: string }) => Promise<{ resumed: boolean }>
  councilGetHistory: (args: { workspaceId: string; limit?: number }) => Promise<unknown[]>
  councilDeleteSession: (args: { sessionId: string }) => Promise<{ deleted: boolean }>

  // Multi-Workspace Session Management
  getAllWorkspaceStatuses: () => Promise<Record<string, unknown>>
  onWorkspaceStatusUpdate: (cb: (data: { workspaceId: string; status: string; agentId: string; agentType: string; elapsedMs: number; tokenUsage: number }) => void) => () => void
  onPermissionRequest: (cb: (data: { id: string; workspaceId: string; workspaceName: string; type: string; summary: string; isSimple: boolean; payload: unknown; receivedAt: number }) => void) => () => void
  respondToPermission: (args: { permissionId: string; workspaceId: string; type: string; response: unknown }) => Promise<void>
  onCompletionNotification: (cb: (data: { workspaceId: string; workspaceName: string; service: string; status: string; summary: string }) => void) => () => void
}

declare global {
  interface Window {
    api: Api
  }
}
