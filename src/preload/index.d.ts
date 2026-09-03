import type {
  IntegrationConnectionResult,
  IntegrationCredentialStatus
} from '../shared/integration-credentials.types'
import type {
  JiraBoard,
  JiraCreateBlueprintsResult,
  JiraCurrentUser,
  JiraIssueDetail,
  JiraProject,
  JiraSearchResult,
  JiraSprint,
  JiraTransition
} from '../shared/jira.types'
import type {
  Workspace,
  Conversation,
  ConversationMode,
  FileDiffResult,
  Message,
  AgentStatus,
  BackgroundProcessInfo,
  ProcessStopResult,
  ProcessCancelWatchResult,
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
  CompleteResult,
  GrillQuestion,
  GrillTrackId,
  MemoryFeedProgress,
  MemoryFeedResult,
  TokenSummary,
  WorkspaceUsageSummary,
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
  ModelsRuntimeStatus,
  SemanticSearchResult,
  OllamaStatus,
  OmlxExtendedStatus,
  PullProgress,
  IndexingState,
  ExclusionPreflightResult,
  CodeGraphIndexingState,
  ContextUsage,
  BugRecord,
  GlmQuotaStatus,
  GlmConnectionResult,
  AuditRun,
  AuditPlanRecord,
  AuditMode,
  AuditTrackId,
  AuditSelectedSkills,
  AuditFinding,
  AuditFindingHandoff,
  AuditHandoffTarget,
  AuditProgressEvent,
  AuditResult,
  AuditStreamChunkEvent,
  AuditIntermediateEvent,
  LLMProvider,
  ModelRoleMap,
  CommunicationTone,
  UpdateConfig,
  GrillDecision,
  GrillTrackScore,
  GrillStructuredPlan,
  PlanRecord,
  PlanStatusHistoryEntry,
  MemoryFact,
  MemoryFactCategory,
  MemoryFactTier,
  MemoryFactStatus,
  MemoryContradiction,
  MemoryCaptureSettings,
  MemoryEmbeddingStatus,
  MemoryPromotionDiagnostics,
  MemoryGraphData,
  IngestionProgress,
  BootstrapProgress,
  BootstrapMode,
  BootstrapScope,
  BootstrapItemStatus,
  BootstrapItemView,
  BootstrapPhaseLabel,
  BootstrapRunSummary,
  ContradictionStatus,
  E2EScenarioSummary,
  E2EPreflightResult,
  E2ERunSummary,
  E2EResultSummary,
  E2EResultDetail,
  E2EProgressEvent,
  PhaseProgressEvent
} from '../shared/types'
import type {
  HandoffRecord,
  HandoffSource,
  HandoffTarget,
  HandoffPriority,
  HandoffRenderFormat,
  CompletedStep,
  RemainingStep,
  HandoffDecision,
  HandoffRisk,
  ArtifactRef,
  CodeAnchor
} from '../shared/handoff-types'
import type {
  TrackListResult,
  LandingResult,
  LandingPreview,
  MainlineSyncResult,
  TrackLandingMode
} from '../shared/track-types'
import type {
  BlueprintBranchOptions,
  BlueprintBranchChoice,
  ResolvedBlueprintBase
} from '../shared/blueprint-types'
import type {
  BlueprintHandoffIntent,
  BlueprintBranchMode,
  BlueprintHandoffOptions
} from '../shared/blueprint-handoff'

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
  createProjectShell: (args: {
    name: string
    parentFolder: string
    description?: string
    attachments?: string[]
    tempGrillSessionId?: string
  }) => Promise<Workspace>
  finalizeProjectBlueprint: (args: {
    workspaceId: string
    projectName: string
    description?: string
    grillDecisions?: GrillDecision[]
    trackScores?: GrillTrackScore[]
  }) => Promise<void>
  discardProjectShell: (args: { workspaceId: string }) => Promise<void>
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
  stageImageFile: (args: { scope: string; sourcePath: string }) => Promise<string>
  clearStagedImages: (args: { scope: string }) => Promise<{ cleared: boolean }>

  // Chat
  sendMessage: (args: {
    conversationId: string
    text: string
    attachments?: string[]
    skipOptimizer?: boolean
    hidden?: boolean
  }) => Promise<{ requestId: string }>
  chatSetGoal: (args: {
    conversationId: string
    goal: string
    goalMode?: 'advisory' | 'enforce'
  }) => Promise<void>
  getConversations: (args: { workspaceId: string }) => Promise<Conversation[]>
  createConversation: (args: {
    workspaceId: string
    title?: string
    mode?: ConversationMode
    personaSpecialistId?: string
    llmProvider?: LLMProvider
    routingOverrides?: Partial<ModelRoleMap>
    mcpOverrides?: Record<string, boolean>
    communicationTone?: CommunicationTone | null
    sourceAuditRunId?: string
    branchName?: string
    autoBranch?: boolean
    /** Take the selected branch from its current holder. Explicit confirmation only. */
    takeover?: boolean
  }) => Promise<Conversation>
  chatBranchOptions: (args: { workspaceId: string }) => Promise<BlueprintBranchOptions>

  updateMcpOverrides: (args: {
    conversationId: string
    overrides: Record<string, boolean>
  }) => Promise<Conversation>
  updateConversationTone: (args: {
    conversationId: string
    communicationTone: CommunicationTone | null
  }) => Promise<Conversation>
  updateConversationRouting: (args: {
    conversationId: string
    workspaceId: string
    llmProvider?: LLMProvider
    routingOverrides?: Partial<ModelRoleMap>
  }) => Promise<Conversation>
  checkExternalMcp: (args: { command: string }) => Promise<{ available: boolean; path?: string }>
  saveIntegrationCredentials: (args: {
    workspaceId: string
    integrationId: string
    values: Record<string, string>
  }) => Promise<IntegrationCredentialStatus>
  getIntegrationCredentialStatus: (args: {
    workspaceId: string
    integrationId: string
  }) => Promise<IntegrationCredentialStatus>
  testIntegrationConnection: (args: {
    workspaceId: string
    integrationId: string
    values?: Record<string, string>
  }) => Promise<IntegrationConnectionResult>
  clearIntegrationCredentials: (args: {
    workspaceId: string
    integrationId: string
  }) => Promise<{ success: boolean }>
  jiraSearchIssues: (args: {
    workspaceId: string
    jql: string
    maxResults?: number
    cursor?: string
  }) => Promise<JiraSearchResult>
  jiraListProjects: (args: { workspaceId: string }) => Promise<JiraProject[]>
  jiraListBoards: (args: { workspaceId: string; projectKey: string }) => Promise<JiraBoard[]>
  jiraListSprints: (args: { workspaceId: string; boardId: number }) => Promise<JiraSprint[]>
  jiraConvertedKeys: (args: { workspaceId: string }) => Promise<Record<string, string>>
  jiraAssignToMe: (args: { workspaceId: string; issueKey: string }) => Promise<JiraCurrentUser>
  jiraListTransitions: (args: {
    workspaceId: string
    issueKey: string
  }) => Promise<JiraTransition[]>
  jiraTransitionIssue: (args: {
    workspaceId: string
    issueKey: string
    transitionId: string
  }) => Promise<{ success: true }>
  jiraGetIssue: (args: { workspaceId: string; issueKey: string }) => Promise<JiraIssueDetail>
  jiraAddComment: (args: {
    workspaceId: string
    issueKey: string
    body: string
  }) => Promise<{ success: true }>
  jiraCreateBlueprints: (args: {
    workspaceId: string
    issueKeys: string[]
  }) => Promise<JiraCreateBlueprintsResult>
  getMessages: (args: { conversationId: string }) => Promise<Message[]>
  getTodos: (args: { conversationId: string }) => Promise<
    Array<{
      id: number
      conversationId: string
      text: string
      completed: boolean
      itemIndex: number | null
      createdAt: string
      updatedAt: string
    }>
  >
  deleteConversation: (args: { conversationId: string }) => Promise<void>
  updateConversationMode: (args: {
    conversationId: string
    mode: ConversationMode
  }) => Promise<Conversation>
  updateEffort: (args: {
    conversationId: string
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  }) => Promise<{ effort: string }>
  renameConversation: (args: { conversationId: string; title: string }) => Promise<Conversation>
  stopGeneration: (conversationId?: string) => Promise<void>
  forceReleaseConversation: (conversationId: string) => Promise<{ released: boolean }>
  getStreamingState: () => Promise<{
    isStreaming: boolean
    conversationId: string | null
    state: string
    requestId: string | null
    /** MULTI-CHAT-06: Per-conversation active streams from LifecycleRegistry */
    streams: Array<{ conversationId: string; requestId: string }>
  }>
  compactConversation: (args?: { extractNuance?: boolean }) => Promise<void>

  // Chat commands
  completeConversation: (args: {
    conversationId: string
    branchName: string
    commitMessage: string
    description: string
    baseBranch?: string
  }) => Promise<CompleteResult>
  closeConversation: (args: { conversationId: string }) => Promise<void>
  getFileChanges: (args: {
    conversationId: string
  }) => Promise<
    Array<{ filePath: string; changeType: 'created' | 'modified' | 'deleted'; staged: boolean }>
  >
  generatePrDescription: (args: { conversationId: string }) => Promise<{ description: string }>
  listBranches: (args: { workspaceId: string }) => Promise<{
    local: string[]
    remote: string[]
    current: string
  }>

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

  // Memory Engine (knowledge-aware facts)
  memoryFactsList: (args: {
    workspaceId: string
    status?: MemoryFactStatus
  }) => Promise<MemoryFact[]>
  memoryFactsSearch: (args: {
    workspaceId: string
    query: string
    category?: MemoryFactCategory
  }) => Promise<MemoryFact[]>
  memoryFactsGet: (args: { id: string }) => Promise<MemoryFact>
  memoryFactsUpdate: (args: {
    id: string
    title?: string
    content?: string
    tags?: string[]
    scopePaths?: string[]
    category?: MemoryFactCategory
  }) => Promise<MemoryFact>
  memoryFactsArchive: (args: { id: string }) => Promise<void>
  memoryFactsConfirm: (args: { id: string }) => Promise<MemoryFact>
  memoryFactsPromote: (args: { id: string; tier: MemoryFactTier }) => Promise<MemoryFact>
  memoryFactsScopeToggle: (args: {
    id: string
    global: boolean
    workspaceId?: string
  }) => Promise<MemoryFact>
  memoryFactsDelete: (args: { id: string }) => Promise<void>
  memoryContradictionsList: (args?: {
    status?: ContradictionStatus
    limit?: number
    offset?: number
  }) => Promise<{ items: MemoryContradiction[]; total: number; pendingCount: number }>
  memoryContradictionsResolve: (args: {
    id: string
    resolution: string
    keepFactId: string
    archiveFactId?: string
  }) => Promise<MemoryContradiction>
  memoryCaptureSettingsGet: (args: { workspaceId: string }) => Promise<MemoryCaptureSettings>
  memoryCaptureSettingsSet: (args: {
    workspaceId: string
    settings: Partial<MemoryCaptureSettings>
  }) => Promise<void>
  memoryEmbeddingStatus: (args?: { workspaceId?: string }) => Promise<MemoryEmbeddingStatus>
  memoryPromotionDiagnostics: (args?: {
    workspaceId?: string
  }) => Promise<MemoryPromotionDiagnostics>
  memoryEmbeddingBackfill: () => Promise<{ backfilled: number; error?: string }>
  onMemoryEmbeddingProgress: (
    callback: (data: { processed: number; total: number; done: boolean; error?: string }) => void
  ) => () => void
  memoryDedupScan: (args: {
    workspaceId: string
  }) => Promise<{ clustersFound: number; autoMerged: number }>
  memoryDedupAutoresolve: (args: {
    workspaceId: string
    minCosine?: number
  }) => Promise<{ resolvedCount: number }>
  memoryConsolidate: (args: { workspaceId: string }) => Promise<{
    clustersFound: number
    autoMerged: number
    reviewItemsCreated: number
    staleArchived: number
    contradictionsPruned: number
    reviewQueueCapped: number
    promoted: number
  }>
  memoryReadClaudeMd: (args: {
    workspacePath: string
  }) => Promise<{ content: string | null; path: string }>
  memoryGraphGet: (args: { workspaceId: string }) => Promise<MemoryGraphData>
  memorySaveMessage: (args: {
    workspaceId: string
    messageContent: string
    workspacePath?: string
  }) => Promise<{ created: number }>
  memorySavePlanExecution: (args: {
    workspaceId: string
    workspacePath: string
    conversationId: string
    planTitle: string
    planGoal?: string
    status: 'completed' | 'partial' | 'failed'
    phases: Array<{
      phaseTitle: string
      status: string
      touchedFiles: string[]
      tasks: Array<{ title: string; status: string }>
    }>
    durationMs: number
  }) => Promise<{ enqueued: boolean }>

  // Memory Document Ingestion
  memoryIngestSelectFiles: () => Promise<string[] | null>
  memoryIngestSelectFolder: () => Promise<string | null>
  memoryIngestDiscover: (args: {
    folderPath: string
  }) => Promise<{ files: string[]; counts: Record<string, number>; truncated: boolean }>
  memoryIngestDocuments: (args: {
    files: string[]
    workspaceId: string
    workspacePath: string
  }) => Promise<{ jobId: string; factsCreated: number }>
  memoryIngestCancel: (args: { jobId: string }) => Promise<boolean>
  onMemoryIngestProgress: (callback: (data: IngestionProgress) => void) => () => void

  // Memory Bootstrap
  memoryBootstrapStart: (args: {
    workspaceId: string
    workspacePath: string
    mode?: BootstrapMode
    force?: boolean
    scope?: BootstrapScope
  }) => Promise<{ jobId: string; runId: string; factsCreated: number }>
  memoryBootstrapCancel: (args: { jobId: string }) => Promise<boolean>
  memoryBootstrapPause: (args: { workspaceId: string }) => Promise<boolean>
  memoryBootstrapResume: (args: {
    runId: string
    workspacePath: string
  }) => Promise<{ jobId: string; runId: string; factsCreated: number }>
  memoryBootstrapSnapshot: (args: { workspaceId: string }) => Promise<{
    progress: BootstrapProgress | null
    latestRun: BootstrapRunSummary | null
    resumableRunId: string | null
  }>
  memoryBootstrapListRuns: (args: {
    workspaceId: string
    limit?: number
  }) => Promise<BootstrapRunSummary[]>
  memoryBootstrapListItems: (args: {
    runId: string
    status?: BootstrapItemStatus
    phase?: BootstrapPhaseLabel
    limit?: number
    offset?: number
  }) => Promise<{ items: BootstrapItemView[]; total: number }>
  onMemoryBootstrapProgress: (callback: (data: BootstrapProgress) => void) => () => void

  // Memory Feed (retained)
  memorySelectDocument: () => Promise<string | null>
  memoryFeedCancel: () => Promise<void>
  memoryRegenerateClaudeMd: (args: {
    workspacePath: string
    workspaceId: string
  }) => Promise<{ success: boolean; content: string; existing: string | null; error?: string }>
  memoryProjectExport: (args: { workspaceId: string; workspacePath: string }) => Promise<{
    indexPath: string
    topicPaths: string[]
    factsProjected: number
    factsPruned: number
    warnings: string[]
  }>
  memoryReflectionList: (args: {
    workspaceId: string
  }) => Promise<Array<{ parent: MemoryFact; children: MemoryFact[] }>>
  memoryReflectionApprove: (args: { id: string }) => Promise<MemoryFact | null>
  memoryReflectionReject: (args: { id: string }) => Promise<void>
  memoryReflectionRun: (args: {
    workspaceId: string
    workspacePath: string
  }) => Promise<{ clustersConsidered: number; parentsProposed: number; errors: number }>
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
  getWorkspaceUsageSummary: (args: { workspaceId: string }) => Promise<WorkspaceUsageSummary>
  getGlobalUsageSummary: () => Promise<WorkspaceUsageSummary>

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
      todoSync?: Array<{ text: string; completed: boolean; index: number }>
      phaseProgress?: PhaseProgressEvent
      turnLimit?: {
        continuable: boolean
        continuationsUsed: number
        continuationsMax: number
      }
    }) => void
  ) => () => void
  onMessageComplete: (
    callback: (data: {
      conversationId: string
      messageId: string
      taskId?: string
      requestId?: string
      /** Workspace that owns the conversation — set even when it is not the active one. */
      workspaceId?: string
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
  /** IPC-BACKPRESSURE: Send ACK to backend after processing a batch of chunks. */
  chunkAck: (data: {
    processed: number
    timestamp: number
    perConversation?: Record<string, number>
  }) => void
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
      contextTokens?: number
      model?: 'haiku' | 'sonnet' | 'opus'
      complexityTier?: 'simple' | 'moderate' | 'complex'
      activeMcpTools?: string[]
    }) => void
  ) => () => void

  // Auto-update events
  onUpdateAvailable: (
    callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void
  ) => () => void
  onUpdateNotAvailable: (callback: (info: { currentVersion?: string }) => void) => () => void
  onUpdateStaging: (callback: (info: { version: string }) => void) => () => void
  onUpdateInstallFailed: (callback: (message: string) => void) => () => void
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
  getFileDetails: (args: { conversationId: string }) => Promise<
    Array<{
      filePath: string
      changeType: 'created' | 'modified' | 'deleted'
      staged: boolean
      oldPath?: string
    }>
  >

  // File Viewer
  filesViewerRead: (args: {
    conversationId?: string
    blueprintId?: string
    workspacePath?: string
    filePath: string
  }) => Promise<{ content: string; size: number; truncated: boolean }>,

  // Blueprint modified files (VERIFY deliverable)
  getBlueprintModifiedFiles: (args: {
    blueprintId: string
  }) => Promise<{
    files: Array<{ path: string; status: 'M' | 'A' | 'D'; additions: number; deletions: number }>
    source: 'git' | 'none'
  }>
  getFileDiff: (args: {
    conversationId: string
    filePath: string
    oldPath?: string
  }) => Promise<FileDiffResult>
  getRefFileDetails: (args: { conversationId: string; fromRef: string; toRef: string }) => Promise<
    Array<{
      filePath: string
      changeType: 'created' | 'modified' | 'deleted'
      staged: boolean
      oldPath?: string
    }>
  >
  getRefFileDiff: (args: {
    conversationId: string
    filePath: string
    fromRef: string
    toRef: string
    oldPath?: string
  }) => Promise<FileDiffResult>
  fetchOrigin: (args: { conversationId: string }) => Promise<{ fetched: boolean; error?: string }>
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
    agentRole: 'specialist'
    alias: string | null
    avatarKey: string | null
  }) => Promise<CoreAgentAlias>

  // Core Agent Prompts
  listCoreAgentPrompts: () => Promise<CoreAgentPrompt[]>
  getCoreAgentPrompt: (args: {
    agentRole: 'specialist'
    mode: 'plan' | 'build' | 'danger'
  }) => Promise<CoreAgentPrompt | undefined>
  upsertCoreAgentPrompt: (args: {
    agentRole: 'specialist'
    mode: 'plan' | 'build' | 'danger'
    promptText: string
  }) => Promise<CoreAgentPrompt>
  resetCoreAgentPrompt: (args: {
    agentRole: 'specialist'
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

  // File Utilities
  /** Electron 32+ replacement for the removed File.path property */
  getPathForFile: (file: File) => string

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
  /** GLM Coding Plan credit quota. Resolves to null when the workspace isn't on GLM. */
  getGlmQuota: (args: { workspaceId: string }) => Promise<GlmQuotaStatus | null>
  /** Probe {baseUrl}/models. Omit apiKey to use the stored (encrypted) one. */
  glmTestConnection: (args: {
    workspacePath?: string
    baseUrl: string
    apiKey?: string
  }) => Promise<GlmConnectionResult>
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
  getConversationInsights: (args: { conversationId: string }) => Promise<{
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
  checkOpenCodeCli: () => Promise<{
    available: boolean
    version?: string
    error?: string
  }>
  autoConfigureClaude: () => Promise<AutoConfigureResult>

  // Embedding Provider
  embeddingCheckStatus: (args?: {
    baseUrl?: string
    apiKey?: string
    workspaceId?: string
  }) => Promise<EmbeddingModelStatus>
  embeddingInitialize: (args?: {
    baseUrl?: string
    apiKey?: string
    workspaceId?: string
  }) => Promise<void>
  modelsRuntimeStatus: (args: { workspaceId: string }) => Promise<ModelsRuntimeStatus>
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
  indexingPreflightExclusions: (args: { workspaceId: string }) => Promise<ExclusionPreflightResult>
  indexingApplyExclusions: (args: {
    workspaceId: string
    patterns: string[]
  }) => Promise<{ written: string[] }>
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

  // Session mutation — branch a conversation (legacy alias)
  sdkForkSession: (args: {
    sessionId: string
    upToMessageId?: string
  }) => Promise<{ sessionId: string }>

  // SDK Diagnostics (@alpha — 0.2.138+)
  resolveSettings(): Promise<{
    success: boolean
    settings?: Record<string, unknown>
    error?: string
  }>

  // Stream Diagnostics — aggregated streaming health metrics
  getStreamMetrics: () => Promise<{
    completionRate: number
    ttftP50: number | null
    ttftP95: number | null
    ttftP99: number | null
    sampleSize: number
    outcomeCounts: Record<string, number>
  }>

  // Persist plan card action on a message
  chatSetPlanAction: (args: { messageId: string; action: string }) => Promise<{ success: boolean }>

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
  bugExportMarkdown: (args: { markdown: string; defaultFilename?: string }) => Promise<void>
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
  auditHandoffToChat: (args: {
    workspaceId: string
    auditRunId: string
    trackIds?: AuditTrackId[]
    mode: 'consolidated' | 'split'
  }) => Promise<{ conversationIds: string[]; count: number }>
  auditHandoffToBlueprint: (args: {
    workspaceId: string
    auditRunId: string
    findingIds: string[]
  }) => Promise<{ blueprintId: string; title: string; findingCount: number }>
  auditRecordFindingHandoff: (args: {
    workspaceId: string
    auditRunId: string
    findingIds: string[]
    target: AuditHandoffTarget
    refId?: string
    refTitle?: string
  }) => Promise<AuditFindingHandoff[]>
  auditGetFindingHandoffs: (args: { auditRunId: string }) => Promise<AuditFindingHandoff[]>
  auditRerunTrack: (args: {
    workspaceId: string
    trackId: AuditTrackId
    mode: AuditMode
  }) => Promise<void>
  auditResume: (args: { workspaceId: string }) => Promise<AuditRun | null>
  auditExportMarkdown: (args: { workspaceId: string }) => Promise<void>
  auditExportPlanMarkdown: (args: { workspaceId: string }) => Promise<void>
  auditGetHistory: (args: { workspaceId: string; limit?: number }) => Promise<AuditRun[]>
  auditDeleteRun: (args: { runId: string }) => Promise<{ deleted: boolean }>
  auditGeneratePlan: (args: {
    workspaceId: string
    runId: string
    findings: AuditFinding[]
  }) => Promise<AuditPlanRecord>
  auditGetPlans: (args: { runId: string }) => Promise<AuditPlanRecord[]>

  // Plan Hub (unified plan registry)
  planGetAll: (args: {
    workspaceId: string
    filters?: { status?: string | string[]; source?: string; search?: string }
  }) => Promise<PlanRecord[]>
  planGetById: (args: { planId: string }) => Promise<PlanRecord | null>
  planUpdateStatus: (args: {
    planId: string
    status: string
    linkedConversationId?: string
    linkedMpaRunId?: string
    linkedCouncilSessionId?: string
  }) => Promise<{ success: boolean }>
  planDelete: (args: { planId: string }) => Promise<{ deleted: boolean }>
  planImport: (args: {
    planId: string
    workspaceId: string
  }) => Promise<{ conversationId: string; planId: string }>
  planGetStatusHistory: (args: { planId: string }) => Promise<PlanStatusHistoryEntry[]>
  planFindBySource: (args: { source: string; sourceId: string }) => Promise<PlanRecord | null>
  getPhaseProgress: (args: { conversationId: string }) => Promise<{
    planId: string
    planTitle: string
    planGoal?: string
    phases: Array<{
      id: number
      title: string
      tasks: Array<{ taskId: string; title: string; files: string[] }>
    }>
    phaseFiles: Record<number, string[]>
    progress: Array<{
      phaseId: number
      status: string
      startedAt: string | null
      completedAt: string | null
      touchedFiles?: string[]
      tasks?: Array<{ taskId: string; title: string; status: string }>
    }>
  } | null>

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
  grillCondenseRequirement: (args: {
    text: string
    workspaceId?: string
  }) => Promise<{ condensed: string }>
  grillGeneratePlan: (args: {
    sessionId: string
    ideaId?: string
    workspaceId: string
  }) => Promise<GrillStructuredPlan>
  grillGeneratePlanFromDecisions: (args: {
    projectName: string
    description: string
    grillDecisions: GrillDecision[]
    trackScores?: GrillTrackScore[]
    workspaceId: string
  }) => Promise<GrillStructuredPlan>
  grillGetStatus: (args: { workspaceId: string }) => Promise<{
    status: string
    ideaId: string
    trackId: string | null
    score: number | null
  } | null>
  grillGetSession: (args: { ideaId: string }) => Promise<unknown | null>
  grillListPlannedIdeas: (args: { workspaceId: string }) => Promise<string[]>
  grillComplete: (args: { ideaId: string }) => Promise<void>
  grillSeedPlanCard: (args: {
    conversationId: string
    plan: GrillStructuredPlan
  }) => Promise<Message>
  grillDiscard: (args: { ideaId: string }) => Promise<void>
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
  mpaApprovalRespond: (args: {
    runId: string
    approved: boolean
    feedback?: string
  }) => Promise<{ responded: boolean }>
  mpaResume: (args: { runId: string; workspaceId: string }) => Promise<{ resumed: boolean }>
  onMpaPhaseStart: (
    cb: (data: {
      workspaceId: string
      runId: string
      phaseId: string
      phaseType: string
      iteration: number
      agentRole: string
    }) => void
  ) => () => void
  onMpaPhaseProgress: (
    cb: (data: {
      workspaceId: string
      runId: string
      phaseId: string
      phaseType: string
      streamChunk: string
    }) => void
  ) => () => void
  onMpaPhaseComplete: (
    cb: (data: {
      workspaceId: string
      runId: string
      phaseId: string
      phaseType: string
      status: string
      tokensUsed: number
    }) => void
  ) => () => void
  onMpaFeedbackLoop: (
    cb: (data: {
      workspaceId: string
      runId: string
      fromPhase: string
      toPhase: string
      iteration: number
      reason: string
    }) => void
  ) => () => void
  onMpaApprovalNeeded: (
    cb: (data: {
      workspaceId: string
      runId: string
      phaseId: string
      artifactId: string
      artifact: unknown
    }) => void
  ) => () => void
  onMpaPipelineComplete: (
    cb: (data: { workspaceId: string; runId: string; status: string; totalTokens: number }) => void
  ) => () => void

  // MPA Campaigns (sequential measurable-goal runs)
  mpaDecomposeGoals: (args: { workspaceId: string; input: string }) => Promise<{
    goals: Array<{
      id: string
      title: string
      outcome: string
      successCriteria: string[]
      goalType: string
      phases: string[]
    }>
  }>
  mpaCampaignStart: (args: {
    workspaceId: string
    title: string
    originalPlanMd: string
    goals: Array<{
      id: string
      title: string
      outcome: string
      successCriteria: string[]
      goalType: string
      phases: string[]
    }>
  }) => Promise<{ campaignId: string }>
  mpaCampaignRespond: (args: {
    workspaceId: string
    action: 'retry' | 'skip' | 'stop'
  }) => Promise<{ responded: boolean }>
  mpaCampaignCancel: (args: { workspaceId: string }) => Promise<{ cancelled: boolean }>
  mpaCampaignGetHistory: (args: { workspaceId: string; limit?: number }) => Promise<unknown[]>
  mpaCampaignGetDetail: (args: { campaignId: string }) => Promise<unknown>
  onMpaCampaignStarted: (
    cb: (data: {
      workspaceId: string
      campaignId: string
      title: string
      totalGoals: number
    }) => void
  ) => () => void
  onMpaCampaignGoalStart: (
    cb: (data: {
      workspaceId: string
      campaignId: string
      orderIndex: number
      goalId: string
      title: string
    }) => void
  ) => () => void
  onMpaCampaignGoalComplete: (
    cb: (data: {
      workspaceId: string
      campaignId: string
      orderIndex: number
      goalId: string
      status: string
      runId: string | null
    }) => void
  ) => () => void
  onMpaCampaignPaused: (
    cb: (data: {
      workspaceId: string
      campaignId: string
      orderIndex: number
      goalId: string
      runId: string | null
      reason: string
    }) => void
  ) => () => void
  onMpaCampaignComplete: (
    cb: (data: {
      workspaceId: string
      campaignId: string
      status: string
      completedGoals: number
      totalGoals: number
    }) => void
  ) => () => void

  // Blueprint Pipeline (Specify + Clarify)
  blueprintCreate: (args: {
    workspaceId: string
    title: string
    description?: string
    priority?: string
    settingsJson?: Record<string, unknown>
  }) => Promise<unknown>
  blueprintBranchOptions: (args: { workspaceId: string }) => Promise<BlueprintBranchOptions>
  blueprintResolveBase: (args: {
    workspaceId: string
    choice?: BlueprintBranchChoice
  }) => Promise<ResolvedBlueprintBase>
  blueprintCreateFromIdea: (args: { ideaId: string; workspaceId: string }) => Promise<unknown>
  blueprintStartSpecify: (args: {
    blueprintId: string
    workspaceId: string
  }) => Promise<{ started: boolean }>
  blueprintStartClarify: (args: {
    blueprintId: string
    workspaceId: string
  }) => Promise<{ started: boolean }>
  blueprintClarifyAnswer: (args: {
    blueprintId: string
    workspaceId: string
    message: string
  }) => Promise<{ sent: boolean }>
  blueprintSkipClarify: (args: { blueprintId: string }) => Promise<{ skipped: boolean }>
  blueprintClarifyProceed: (args: {
    blueprintId: string
    workspaceId: string
  }) => Promise<{ proceeded: boolean }>
  blueprintClarifyIterate: (args: {
    blueprintId: string
    workspaceId: string
  }) => Promise<{ iterated: boolean }>
  blueprintStartPlan: (args: {
    blueprintId: string
    workspaceId: string
  }) => Promise<{ started: boolean }>
  blueprintStartTasks: (args: {
    blueprintId: string
    workspaceId: string
  }) => Promise<{ started: boolean }>
  blueprintStartReview: (args: {
    blueprintId: string
    workspaceId: string
  }) => Promise<{ started: boolean }>
  blueprintStartBuild: (args: {
    blueprintId: string
    workspaceId: string
  }) => Promise<{ started: boolean }>
  blueprintStartVerify: (args: {
    blueprintId: string
    workspaceId: string
  }) => Promise<{ started: boolean }>
  blueprintGet: (args: { id: string }) => Promise<unknown>
  blueprintGetDetails: (args: { id: string }) => Promise<unknown>
  blueprintList: (args: { workspaceId: string; limit?: number }) => Promise<unknown[]>
  blueprintCancel: (args: { workspaceId: string }) => Promise<{ cancelled: boolean }>
  blueprintUpdate: (args: {
    blueprintId: string
    title?: string
    description?: string
    referenceDocuments?: Array<{ type: string; path: string; name?: string }>
    branchChoice?: BlueprintBranchChoice
  }) => Promise<unknown>
  blueprintDelete: (args: { id: string }) => Promise<{ deleted: boolean }>
  blueprintHandoffToChat: (args: {
    workspaceId: string
    blueprintId: string
    intent?: BlueprintHandoffIntent
    branchMode?: BlueprintBranchMode
  }) => Promise<{
    conversationId: string
    title: string
    branchName: string | null
    inheritedTrack: boolean
    stagedMessage: string
  }>
  blueprintHandoffOptions: (args: {
    workspaceId: string
    blueprintId: string
  }) => Promise<BlueprintHandoffOptions>
  blueprintGetConstitution: (args: {
    workspaceId: string
  }) => Promise<{ constitutionMd: string | null; constitutionVersion: string } | null>
  blueprintSaveConstitution: (args: {
    workspaceId: string
    constitutionMd: string
    version?: string
  }) => Promise<{ saved: boolean }>
  blueprintGetPipelineStatus: (args: {
    workspaceId: string
  }) => Promise<{ running: boolean; blueprintId: string | null; currentPhase: string | null }>
  blueprintRetryPhase: (args: {
    blueprintId: string
    workspaceId: string
  }) => Promise<{ retrying: boolean; phase: string }>
  blueprintSkipTask: (args: {
    blueprintId: string
    taskId: string
    skipped?: boolean
    note?: string
  }) => Promise<{ skipped: boolean; skippedAt: string | null; outcomeKind: string | null }>
  blueprintPlanReviseSend: (args: {
    blueprintId: string
    feedback: string
  }) => Promise<
    | { ok: true; revision: import('../shared/blueprint-types').BlueprintPlanRevision }
    | { ok: false; error: string }
  >
  blueprintPlanReviseAccept: (args: {
    blueprintId: string
  }) => Promise<{ accepted: boolean; error?: string }>
  blueprintPlanReviseHistory: (args: { blueprintId: string }) => Promise<{
    requests: import('../shared/blueprint-types').BlueprintRevisionRequest[]
    revising: boolean
  }>
  blueprintAcknowledgeReview: (args: { blueprintId: string }) => Promise<{ acknowledged: boolean }>
  blueprintGetTranscript: (args: { blueprintId: string; afterSeq?: number }) => Promise<
    Array<{
      id: string
      blueprintId: string
      seq: number
      type: string
      payload: Record<string, unknown>
      createdAt: string
    }>
  >
  onBlueprintPhaseStart: (
    cb: (data: { blueprintId: string; workspaceId: string; phase: string }) => void
  ) => () => void
  onBlueprintPhaseProgress: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      phase: string
      text: string
      kind?: 'text' | 'tool'
      toolActivity?: Record<string, unknown>
      taskId?: string
    }) => void
  ) => () => void
  onBlueprintPhaseComplete: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      phase: string
      status: string
      completion?: unknown
    }) => void
  ) => () => void
  onBlueprintPhaseArtifact: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      phase: string
      artifact: {
        type: string
        filePath?: string
        contentMd?: string
        contentJson?: Record<string, unknown>
      }
    }) => void
  ) => () => void
  blueprintApprovalRespond: (args: {
    blueprintId: string
    approved: boolean
    feedback?: string
  }) => Promise<{ responded: boolean }>
  onBlueprintClarifyAwaitingInput: (
    cb: (data: { blueprintId: string; workspaceId: string }) => void
  ) => () => void
  onBlueprintClarifyFindings: (cb: (data: unknown) => void) => () => void
  onBlueprintClarifyQuestions: (cb: (data: unknown) => void) => () => void
  onBlueprintClarifyGate: (cb: (data: unknown) => void) => () => void
  blueprintPreflightRun: (args: { blueprintId: string; workspaceId: string }) => Promise<{
    checks: Array<{
      id: string
      name: string
      kind: string
      status: string
      message: string
      remediation?: string
      sources: string[]
    }>
    ranAt: string
    hasBlockers: boolean
    hasWarnings: boolean
  } | null>
  onBlueprintPreflightResult: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      result: {
        checks: Array<{
          id: string
          name: string
          kind: string
          status: string
          message: string
          remediation?: string
          sources: string[]
        }>
        ranAt: string
        hasBlockers: boolean
        hasWarnings: boolean
      }
    }) => void
  ) => () => void
  onBlueprintApprovalNeeded: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      phase: string
      planSummary: string
      completion?: Record<string, unknown>
      reviewMarkdown?: string
      revisedPlanMarkdown?: string
      preflight?: {
        result: {
          checks: Array<{
            id: string
            name: string
            kind: string
            status: string
            message: string
            remediation?: string
            sources: string[]
          }>
          ranAt: string
          hasBlockers: boolean
          hasWarnings: boolean
        }
        overridden: boolean
      }
    }) => void
  ) => () => void
  onBlueprintWaveStart: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      wave: number
      taskCount: number
    }) => void
  ) => () => void
  onBlueprintWaveTaskStart: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      wave: number
      taskId: string
      description: string
    }) => void
  ) => () => void
  onBlueprintWaveTaskComplete: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      wave: number
      taskId: string
      status: string
    }) => void
  ) => () => void
  onBlueprintWaveComplete: (
    cb: (data: { blueprintId: string; workspaceId: string; wave: number; status: string }) => void
  ) => () => void

  /** M9.2 — per-task deterministic quality-gate report. Fires once per attempt. */
  onBlueprintTaskGates: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      taskId: string
      report: import('../shared/gate-types').GateReport
    }) => void
  ) => () => void

  // Blueprint Snapshot Sync (M2)
  onBlueprintStateSync: (
    cb: (data: {
      seq: number
      workspaceId: string
      blueprintId: string | null
      running: boolean
      machineState: string
      currentPhase: string | null
      phaseStartedAt: number | null
      clarifyFindings: unknown
      clarifyQuestions: unknown
      pendingApproval: {
        blueprintId: string
        planSummary: string
        completion?: Record<string, unknown>
        reviewMarkdown?: string
        revisedPlanMarkdown?: string
        preflight?: { result: Record<string, unknown>; overridden: boolean }
      } | null
      wave: { wave: number; taskCount: number; tasks: Record<string, string> } | null
      runningTasks: Record<string, { taskId: string; description: string }> | null
      lastError: string | null
    }) => void
  ) => () => void

  // Blueprint Snapshot Pull (M7)
  blueprintGetSnapshot: (args: { workspaceId: string }) => Promise<{
    seq: number
    workspaceId: string
    blueprintId: string | null
    running: boolean
    machineState: string
    currentPhase: string | null
    phaseStartedAt: number | null
    clarifyFindings: unknown
    clarifyQuestions: unknown
    pendingApproval: {
      blueprintId: string
      planSummary: string
      completion?: Record<string, unknown>
      reviewMarkdown?: string
      revisedPlanMarkdown?: string
      preflight?: { result: Record<string, unknown>; overridden: boolean }
    } | null
    wave: { wave: number; taskCount: number; tasks: Record<string, string> } | null
    runningTasks: Record<string, { taskId: string; description: string }> | null
    lastError: string | null
  }>

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
  onCouncilMemberStream: (
    cb: (data: {
      advisorRole: string
      type: string
      content?: string
      toolActivity?: Record<string, unknown>
    }) => void
  ) => () => void
  onCouncilMemberComplete: (
    cb: (data: { advisorRole: string; review: unknown }) => void
  ) => () => void
  onCouncilPeerReviewComplete: (cb: (data: { peerReviews: unknown[] }) => void) => () => void
  onCouncilVerdict: (cb: (data: { verdict: unknown }) => void) => () => void
  onCouncilComplete: (cb: () => void) => () => void
  councilResume: (args: { sessionId: string; workspaceId: string }) => Promise<{ resumed: boolean }>
  councilGetHistory: (args: { workspaceId: string; limit?: number }) => Promise<unknown[]>
  councilDeleteSession: (args: { sessionId: string }) => Promise<{ deleted: boolean }>

  // ── Unified Handoff Protocol ──

  handoffCreate: (args: {
    source: HandoffSource
    target: HandoffTarget
    workspaceId: string
    intent: string
    originalGoal: string
    contextSummary: string
    completedWork?: CompletedStep[]
    remainingWork?: RemainingStep[]
    decisions?: HandoffDecision[]
    constraints?: string[]
    risks?: HandoffRisk[]
    artifacts?: ArtifactRef[]
    codeAnchors?: CodeAnchor[]
    suggestedTools?: string[]
    suggestedSkills?: string[]
    filesToReadFirst?: string[]
    commandsToRunFirst?: string[]
    structuredPlanRef?: string
    parentHandoffId?: string
    sourceSessionId?: string
    extensions?: Record<string, unknown>
    priority?: HandoffPriority
    createdBy?: 'user' | 'system'
    expiresAt?: string
  }) => Promise<HandoffRecord>

  handoffExecute: (args: {
    source: HandoffSource
    target: HandoffTarget
    workspaceId: string
    intent: string
    originalGoal: string
    contextSummary: string
    completedWork?: CompletedStep[]
    remainingWork?: RemainingStep[]
    decisions?: HandoffDecision[]
    constraints?: string[]
    risks?: HandoffRisk[]
    artifacts?: ArtifactRef[]
    codeAnchors?: CodeAnchor[]
    suggestedTools?: string[]
    suggestedSkills?: string[]
    filesToReadFirst?: string[]
    commandsToRunFirst?: string[]
    structuredPlanRef?: string
    parentHandoffId?: string
    sourceSessionId?: string
    extensions?: Record<string, unknown>
    priority?: HandoffPriority
    createdBy?: 'user' | 'system'
    expiresAt?: string
  }) => Promise<{ record: HandoffRecord; action: unknown }>

  handoffAccept: (args: {
    handoffId: string
    targetSessionId: string
  }) => Promise<{ success: boolean; error?: string }>

  handoffReject: (args: {
    handoffId: string
    reason: string
  }) => Promise<{ success: boolean; error?: string }>

  handoffGetHistory: (args: { workspaceId: string; limit?: number }) => Promise<HandoffRecord[]>

  handoffGetChain: (args: { handoffId: string }) => Promise<HandoffRecord[]>

  handoffPreview: (args: {
    source: HandoffSource
    target: HandoffTarget
    workspaceId: string
    intent: string
    originalGoal: string
    contextSummary: string
    completedWork?: CompletedStep[]
    remainingWork?: RemainingStep[]
    decisions?: HandoffDecision[]
    constraints?: string[]
    risks?: HandoffRisk[]
    artifacts?: ArtifactRef[]
    codeAnchors?: CodeAnchor[]
    suggestedTools?: string[]
    suggestedSkills?: string[]
    filesToReadFirst?: string[]
    commandsToRunFirst?: string[]
    structuredPlanRef?: string
    parentHandoffId?: string
    sourceSessionId?: string
    priority?: HandoffPriority
    createdBy?: 'user' | 'system'
    format?: HandoffRenderFormat
  }) => Promise<{ envelope: unknown; markdown: string; action: unknown }>

  // Multi-Workspace Session Management
  getAllWorkspaceStatuses: () => Promise<Record<string, unknown>>
  onWorkspaceStatusUpdate: (
    cb: (data: {
      workspaceId: string
      status: string
      agentId: string
      agentType: string
      elapsedMs: number
      tokenUsage: number
    }) => void
  ) => () => void
  onPermissionRequest: (
    cb: (data: {
      id: string
      workspaceId: string
      workspaceName: string
      type: string
      summary: string
      isSimple: boolean
      payload: unknown
      receivedAt: number
      toolName?: string
      toolInput?: Record<string, unknown>
      conversationTitle?: string
      conversationId?: string
      mode?: string
    }) => void
  ) => () => void
  respondToPermission: (args: {
    permissionId: string
    workspaceId: string
    type: string
    response: unknown
    /** Original request payload — carries requestId back to the control-actions server. */
    payload?: unknown
  }) => Promise<void>
  onPermissionResolved: (
    cb: (data: {
      permissionId: string
      requestId: string
      workspaceId: string
      conversationId?: string
      outcome: 'approved' | 'denied' | 'timedout' | 'cancelled'
    }) => void
  ) => () => void
  onCompletionNotification: (
    cb: (data: {
      workspaceId: string
      workspaceName: string
      service: string
      status: string
      summary: string
      targetPage?: string
      entityId?: string
    }) => void
  ) => () => void
  onNotificationNavigate: (
    cb: (data: { workspaceId: string; targetPage: string; entityId?: string }) => void
  ) => () => void
  probeNotificationSupport: () => Promise<'granted' | 'denied' | 'unsupported'>

  // Background Processes
  processList: () => Promise<BackgroundProcessInfo[]>
  processStop: (args: { pid: number }) => Promise<ProcessStopResult>
  processCancelWatch: (args: { pid: number }) => Promise<ProcessCancelWatchResult>
  onProcessChanged: (cb: () => void) => () => void

  // Work Tracks
  trackList: (args: { workspaceId: string }) => Promise<TrackListResult>
  trackDiscard: (args: { trackId: string }) => Promise<boolean>
  trackReveal: (args: { trackId: string }) => Promise<boolean>
  trackAdopt: (args: { trackId: string }) => Promise<string | null>
  trackLand: (args: {
    trackId: string
    commitMessage: string
    description?: string
    baseBranch?: string
    mode?: TrackLandingMode
  }) => Promise<LandingResult>
  trackLandPreview: (args: {
    trackId: string
    baseBranch?: string
    mode?: TrackLandingMode
  }) => Promise<LandingPreview>
  trackSyncMainline: (args: { workspaceId: string }) => Promise<MainlineSyncResult>
  onTrackChanged: (cb: (data: { workspaceId: string | null }) => void) => () => void

  onTrayNavigate: (cb: (data: { view: string; workspaceId?: string }) => void) => () => void

  // E2E Testing
  testingListScenarios: () => Promise<E2EScenarioSummary[]>
  testingPreflight: (args?: { workspaceId?: string }) => Promise<E2EPreflightResult>
  testingRun: (args?: {
    scenarioIds?: string[]
    category?: string
    workspaceId?: string
  }) => Promise<{ runId: string }>
  testingRequeueFailed: (args: {
    runId: string
    workspaceId?: string
  }) => Promise<{ runId: string }>
  testingResumeRun: (args: { runId: string; workspaceId?: string }) => Promise<{ runId: string }>
  testingCancel: () => Promise<void>
  testingGetRuns: (args?: { workspaceId?: string }) => Promise<E2ERunSummary[]>
  testingGetRunResults: (args: { runId: string }) => Promise<E2EResultSummary[]>
  testingGetResultDetail: (args: { resultId: string }) => Promise<E2EResultDetail | undefined>
  onTestingProgress: (cb: (data: E2EProgressEvent) => void) => () => void

  // Clipboard
  clipboardWriteText: (text: string) => void
}

declare global {
  interface Window {
    api: Api
  }
}
