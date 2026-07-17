import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import type {
  Workspace,
  Conversation,
  ConversationMode,
  Message,
  AgentStatus,
  Specialist,
  ConversationSpecialist,
  Skill,
  WorkspaceClaudeStatus,
  ActivationResult,
  ActivationProgressEvent,
  DiscoveredSkill,
  DiscoveredAgent,
  CompleteResult,
  SyncDiff,
  SyncResult,
  MemoryFeedProgress,
  MemoryFeedResult,
  TokenSummary,
  WorkspaceUsageSummary,
  AgentSessionRecord,
  GrillQuestion,
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
  OllamaStatus,
  PullProgress,
  IndexingState,
  CodeGraphIndexingState,
  ContextUsage,
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
  ModelRoleMap,
  CommunicationTone,
  UpdateConfig,
  SemanticSearchResult,
  GrillDecision,
  GrillTrackScore,
  GrillStructuredPlan,
  PlanRecord,
  MemoryFact,
  MemoryFactCategory,
  MemoryFactTier,
  MemoryFactStatus,
  MemoryContradiction,
  MemoryCaptureSettings,
  MemoryEmbeddingStatus,
  MemoryGraphData,
  ContradictionStatus,
  E2EScenarioSummary,
  E2EPreflightResult,
  E2ERunSummary,
  E2EResultSummary,
  E2EResultDetail,
  E2EProgressEvent
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
  CodeAnchor,
} from '../shared/handoff-types'

const api = {
  // ── Workspace ──
  listWorkspaces: (): Promise<Workspace[]> => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST),

  createWorkspace: (args: { name: string; repoPath: string }): Promise<Workspace> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, args),

  openWorkspace: (args: { id: string }): Promise<Workspace> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_OPEN, args),

  deleteWorkspace: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE, args),

  createProject: (args: {
    name: string
    parentFolder: string
    description: string
    attachments?: string[]
    grillDecisions?: GrillDecision[]
    trackScores?: GrillTrackScore[]
    tempGrillSessionId?: string
  }): Promise<Workspace> => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, args),

  createProjectShell: (args: {
    name: string
    parentFolder: string
    description?: string
    attachments?: string[]
    tempGrillSessionId?: string
  }): Promise<Workspace> => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE_SHELL, args),

  finalizeProjectBlueprint: (args: {
    workspaceId: string
    projectName: string
    description?: string
    grillDecisions?: GrillDecision[]
    trackScores?: GrillTrackScore[]
  }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.PROJECT_FINALIZE_BLUEPRINT, args),

  discardProjectShell: (args: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DISCARD_SHELL, args),

  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY),

  getWorkspaceSettings: (args: { workspaceId: string }): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_SETTINGS, args),

  updateWorkspaceSettings: (args: {
    workspaceId: string
    settings: Record<string, unknown>
  }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE_SETTINGS, args),

  updateAuthSettings: (args: {
    workspaceId: string
    authMode: string
    anthropicApiKey?: string
  }): Promise<{ success: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE_AUTH, args),

  saveClipboardImage: (args: { dataUrl: string; conversationId: string }): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE, args),

  readImageBase64: (args: { filePath: string }): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.READ_IMAGE_BASE64, args),

  // ── Chat ──
  sendMessage: (args: {
    conversationId: string
    text: string
    attachments?: string[]
  }): Promise<{ requestId: string }> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, args),

  getConversations: (args: { workspaceId: string }): Promise<Conversation[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_CONVERSATIONS, args),

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
  }): Promise<Conversation> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_CREATE_CONVERSATION, args),



  updateMcpOverrides: (args: {
    conversationId: string
    overrides: Record<string, boolean>
  }): Promise<Conversation> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_MCP_OVERRIDES, args),

  updateConversationTone: (args: {
    conversationId: string
    communicationTone: CommunicationTone | null
  }): Promise<Conversation> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_TONE, args),

  checkExternalMcp: (args: { command: string }): Promise<{ available: boolean; path?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CHECK_EXTERNAL_MCP, args),

  getMessages: (args: { conversationId: string }): Promise<Message[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_MESSAGES, args),

  deleteConversation: (args: { conversationId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_DELETE_CONVERSATION, args),

  updateConversationMode: (args: {
    conversationId: string
    mode: ConversationMode
  }): Promise<Conversation> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_MODE, args),

  updateEffort: (args: {
    conversationId: string
    effort: 'low' | 'medium' | 'high'
  }): Promise<{ effort: string }> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_EFFORT, args),

  renameConversation: (args: { conversationId: string; title: string }): Promise<Conversation> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_RENAME, args),

  stopGeneration: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_STOP),

  getStreamingState: (): Promise<{
    isStreaming: boolean
    conversationId: string | null
    state: string
    requestId: string | null
  }> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_STREAMING_STATE),

  compactConversation: (args?: { extractNuance?: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_COMPACT, args),



  // Chat commands
  completeConversation: (args: {
    conversationId: string
    branchName: string
    commitMessage: string
    description: string
  }): Promise<CompleteResult> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_COMPLETE, args),

  closeConversation: (args: { conversationId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_CLOSE, args),

  getFileChanges: (args: {
    conversationId: string
  }): Promise<
    Array<{ filePath: string; changeType: 'created' | 'modified' | 'deleted'; staged: boolean }>
  > => ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_FILE_CHANGES, args),

  generatePrDescription: (args: { conversationId: string }): Promise<{ description: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_GENERATE_PR_DESCRIPTION, args),

  // ── Agents ──
  getAgentStatuses: (): Promise<AgentStatus[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_STATUSES),

  stopAllAgents: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STOP_ALL),

  /** Strategy M: Cache efficiency metrics for dashboard */
  getCacheEfficiency: (): Promise<{
    hitRate: number
    savedTokens: number
    totalInput: number
    turns: number
  }> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_CACHE_EFFICIENCY),

  // ── Agent Lifecycle ──
  startAgent: (args: string | { workspacePath: string; workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_START, args),

  // ── Specialists ──
  listSpecialists: (): Promise<Specialist[]> => ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_LIST),

  getSpecialist: (args: { id: string }): Promise<Specialist> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_GET, args),

  createSpecialist: (args: {
    agentId: string
    displayName: string
    icon?: string
    color?: string
    prompt?: string
    priority?: number
  }): Promise<Specialist> => ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_CREATE, args),

  updateSpecialist: (args: {
    id: string
    displayName?: string
    icon?: string
    color?: string
    prompt?: string
    priority?: number
    isActive?: boolean
    alias?: string | null
    avatarUrl?: string | null
  }): Promise<Specialist> => ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_UPDATE, args),

  deleteSpecialist: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_DELETE, args),

  assignSkillToSpecialist: (args: { specialistId: string; skillId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_ASSIGN_SKILL, args),

  removeSkillFromSpecialist: (args: { specialistId: string; skillId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_REMOVE_SKILL, args),

  reorderSpecialists: (args: { orderedIds: string[] }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_REORDER, args),

  // ── Conversation Specialist Activation (skill gating) ──
  listConvSpecialists: (args: { conversationId: string }): Promise<ConversationSpecialist[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONV_SPECIALIST_LIST, args),

  upsertConvSpecialist: (args: {
    conversationId: string
    specialistId: string
    isActive?: boolean
  }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CONV_SPECIALIST_UPSERT, args),

  removeConvSpecialist: (args: { conversationId: string; specialistId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONV_SPECIALIST_REMOVE, args),

  resetConvSpecialists: (args: { conversationId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONV_SPECIALIST_RESET, args),

  estimateConvTokens: (args: { conversationId: string }): Promise<SpecialistTokenEstimate[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONV_SPECIALIST_ESTIMATE, args),

  // ── App Preferences ──
  getAppPreferences: (): Promise<AppPreferences> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_PREFERENCE_GET_ALL),

  setAppPreference: (args: { key: string; value: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_PREFERENCE_SET, args),

  // ── Project Specialist (per-workspace agent) ──
  getProjectSpecialist: (args: { workspaceId: string }): Promise<unknown | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SPECIALIST_GET, args),

  buildProjectSpecialist: (args: { workspaceId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SPECIALIST_BUILD, args),

  rebuildProjectSpecialistPrompt: (args: { specialistId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SPECIALIST_REBUILD_PROMPT, args),

  rebuildProjectSpecialistSkills: (args: { specialistId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SPECIALIST_REBUILD_SKILLS, args),

  updateProjectSpecialistPrompt: (args: {
    specialistId: string
    prompt: string
  }): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SPECIALIST_UPDATE_PROMPT, args),

  toggleProjectSpecialistSkill: (args: {
    specialistId: string
    skillId: string
    enabled: boolean
  }): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SPECIALIST_TOGGLE_SKILL, args),

  attachProjectSpecialistSkill: (args: {
    specialistId: string
    skillId: string
  }): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SPECIALIST_ATTACH_SKILL, args),

  detachProjectSpecialistSkill: (args: {
    specialistId: string
    skillId: string
  }): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SPECIALIST_DETACH_SKILL, args),

  getProjectSpecialistDrift: (args: { workspaceId: string }): Promise<unknown | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SPECIALIST_GET_DRIFT, args),

  refreshProjectSpecialistRecommendations: (args: {
    specialistId: string
  }): Promise<{ ok: true }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SPECIALIST_REFRESH_RECOMMENDATIONS, args),

  onProjectSpecialistBuildProgress: (
    callback: (data: { specialistId: string; phase: string; message: string; at: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { specialistId: string; phase: string; message: string; at: string }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.PROJECT_SPECIALIST_BUILD_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PROJECT_SPECIALIST_BUILD_PROGRESS, handler)
    }
  },

  // ── Skills ──
  listSkills: (): Promise<Skill[]> => ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST),

  getSkill: (args: { id: string }): Promise<Skill> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_GET, args),

  importSkill: (args: { filePath: string }): Promise<Skill> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_IMPORT, args),

  updateSkill: (args: { id: string; name?: string; description?: string }): Promise<Skill> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_UPDATE, args),

  deleteSkill: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_DELETE, args),

  activateSkill: (args: { id: string }): Promise<Skill> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_ACTIVATE, args),

  deactivateSkill: (args: { id: string }): Promise<Skill> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_DEACTIVATE, args),

  selectSkillFile: (): Promise<string | null> => ipcRenderer.invoke(IPC_CHANNELS.SKILL_SELECT_FILE),

  // ── Workspace Deploy ──
  scanWorkspaceClaude: (args: { workspacePath: string }): Promise<WorkspaceClaudeStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SCAN_CLAUDE, args),

  activateAgents: (args: { workspacePath: string }): Promise<ActivationResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ACTIVATE_AGENTS, args),

  readWorkspaceFile: (args: { filePath: string }): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_READ_FILE, args),

  writeWorkspaceFile: (args: { filePath: string; content: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_WRITE_FILE, args),

  scanWorkspaceSkills: (args: { workspacePath: string }): Promise<DiscoveredSkill[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SCAN_SKILLS, args),

  scanWorkspaceAgents: (args: { workspacePath: string }): Promise<DiscoveredAgent[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SCAN_AGENTS, args),

  confirmClaudeMd: (args: { workspacePath: string; content: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CONFIRM_CLAUDE_MD, args),

  cancelActivation: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CANCEL_ACTIVATION),

  cleanActivation: (args: { workspacePath: string; removeClaudeMd?: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CLEAN_ACTIVATION, args),

  deleteAgentFromWorkspace: (args: { workspacePath: string; filename: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_DELETE_FROM_WORKSPACE, args),

  syncAgentToWorkspace: (args: { workspacePath: string; filename: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SYNC_TO_WORKSPACE, args),

  deleteSkillFromWorkspace: (args: { workspacePath: string; skillName: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_DELETE_FROM_WORKSPACE, args),

  syncSkillToWorkspace: (args: { workspacePath: string; skillName: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_SYNC_TO_WORKSPACE, args),

  activateAgent: (args: { workspacePath: string; agentName: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_ACTIVATE, args),

  deactivateAgent: (args: { workspacePath: string; agentName: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_DEACTIVATE, args),

  deleteAllAgents: (args: { workspacePath: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_ALL_AGENTS, args),

  deleteAllSkills: (args: { workspacePath: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.DELETE_ALL_SKILLS, args),

  deployAll: (args: { workspacePath: string }): Promise<{ agents: number; skills: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DEPLOY_ALL, args),

  // ── Agent Sync ──
  computeSyncDiff: (args: { workspacePath: string }): Promise<SyncDiff> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYNC_COMPUTE_DIFF, args),

  applySync: (args: { workspacePath: string; skipRemoved?: boolean }): Promise<SyncResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYNC_APPLY, args),

  // ── Memory Engine (knowledge-aware facts) ──
  memoryFactsList: (args: { workspaceId: string; status?: MemoryFactStatus }): Promise<MemoryFact[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FACTS_LIST, args),

  memoryFactsSearch: (args: { workspaceId: string; query: string; category?: MemoryFactCategory }): Promise<MemoryFact[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FACTS_SEARCH, args),

  memoryFactsGet: (args: { id: string }): Promise<MemoryFact> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FACTS_GET, args),

  memoryFactsUpdate: (args: { id: string; title?: string; content?: string; tags?: string[]; scopePaths?: string[]; category?: MemoryFactCategory }): Promise<MemoryFact> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FACTS_UPDATE, args),

  memoryFactsArchive: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FACTS_ARCHIVE, args),

  memoryFactsConfirm: (args: { id: string }): Promise<MemoryFact> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FACTS_CONFIRM, args),

  memoryFactsPromote: (args: { id: string; tier: MemoryFactTier }): Promise<MemoryFact> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FACTS_PROMOTE, args),

  memoryFactsScopeToggle: (args: { id: string; global: boolean; workspaceId?: string }): Promise<MemoryFact> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FACTS_SCOPE_TOGGLE, args),

  memoryFactsDelete: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FACTS_DELETE, args),

  // Contradictions
  memoryContradictionsList: (args?: { status?: ContradictionStatus; limit?: number; offset?: number }): Promise<{ items: MemoryContradiction[]; total: number; pendingCount: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CONTRADICTIONS_LIST, args),

  memoryContradictionsResolve: (args: { id: string; resolution: string; keepFactId: string; archiveFactId?: string }): Promise<MemoryContradiction> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CONTRADICTIONS_RESOLVE, args),

  // Capture settings
  memoryCaptureSettingsGet: (args: { workspaceId: string }): Promise<MemoryCaptureSettings> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CAPTURE_SETTINGS_GET, args),

  memoryCaptureSettingsSet: (args: { workspaceId: string; settings: Partial<MemoryCaptureSettings> }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CAPTURE_SETTINGS_SET, args),

  // Embedding status
  memoryEmbeddingStatus: (args?: { workspaceId?: string }): Promise<MemoryEmbeddingStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_EMBEDDING_STATUS, args),

  memoryEmbeddingBackfill: (): Promise<{ backfilled: number; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_EMBEDDING_BACKFILL),

  onMemoryEmbeddingProgress: (
    callback: (data: { processed: number; total: number; done: boolean; error?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { processed: number; total: number; done: boolean; error?: string }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.MEMORY_EMBEDDING_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_EMBEDDING_PROGRESS, handler)
    }
  },

  // Dedup scan
  memoryDedupScan: (args: { workspaceId: string }): Promise<{ clustersFound: number; autoMerged: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DEDUP_SCAN, args),

  memoryDedupAutoresolve: (args: { workspaceId: string; minCosine?: number }): Promise<{ resolvedCount: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DEDUP_AUTORESOLVE, args),

  memoryConsolidate: (args: { workspaceId: string }): Promise<{ clustersFound: number; autoMerged: number; reviewItemsCreated: number; staleArchived: number; contradictionsPruned: number; reviewQueueCapped: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CONSOLIDATE, args),

  memoryReadClaudeMd: (args: { workspacePath: string }): Promise<{ content: string | null; path: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_READ_CLAUDE_MD, args),

  // Memory graph
  memoryGraphGet: (args: { workspaceId: string }): Promise<MemoryGraphData> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GRAPH_GET, args),

  memorySaveMessage: (args: { workspaceId: string; messageContent: string; workspacePath?: string }): Promise<{ created: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SAVE_MESSAGE, args),

  // ── Memory Document Ingestion ──
  memoryIngestSelectFiles: (): Promise<string[] | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_INGEST_SELECT_FILES),

  memoryIngestSelectFolder: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_INGEST_SELECT_FOLDER),

  memoryIngestDiscover: (args: { folderPath: string }): Promise<{ files: string[]; counts: Record<string, number>; truncated: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_INGEST_DISCOVER, args),

  memoryIngestDocuments: (args: { files: string[]; workspaceId: string; workspacePath: string }): Promise<{ jobId: string; factsCreated: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_INGEST_DOCUMENTS, args),

  memoryIngestCancel: (args: { jobId: string }): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_INGEST_CANCEL, args),

  onMemoryIngestProgress: (callback: (data: import('../shared/types').IngestionProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.MEMORY_INGEST_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_INGEST_PROGRESS, handler)
    }
  },

  // ── Memory Bootstrap ──
  memoryBootstrapStart: (
    args: { workspaceId: string; workspacePath: string; mode?: import('../shared/types').BootstrapMode }
  ): Promise<{ jobId: string; factsCreated: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_BOOTSTRAP_START, args),

  memoryBootstrapCancel: (args: { jobId: string }): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_BOOTSTRAP_CANCEL, args),

  onMemoryBootstrapProgress: (callback: (data: import('../shared/types').BootstrapProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: any): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.MEMORY_BOOTSTRAP_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_BOOTSTRAP_PROGRESS, handler)
    }
  },

  // ── Memory Feed (retained) ──
  memorySelectDocument: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SELECT_DOCUMENT),

  memoryFeedCancel: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEED_CANCEL),

  memoryRegenerateClaudeMd: (args: {
    workspacePath: string
    workspaceId: string
  }): Promise<{ success: boolean; content: string; existing: string | null; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REGENERATE_CLAUDE_MD, args),

  memoryFeedDocument: (args: {
    workspacePath: string
    filePath: string
  }): Promise<MemoryFeedResult> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEED_DOCUMENT, args),

  onMemoryFeedProgress: (callback: (data: MemoryFeedProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: MemoryFeedProgress): void =>
      callback(data)
    ipcRenderer.on(IPC_CHANNELS.MEMORY_FEED_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_FEED_PROGRESS, handler)
    }
  },

  // ── Tokens ──
  getWorkspaceTokenSummary: (args: { workspaceId: string }): Promise<TokenSummary> =>
    ipcRenderer.invoke(IPC_CHANNELS.TOKEN_GET_WORKSPACE_SUMMARY, args),

  getConversationTokenSummary: (args: { conversationId: string }): Promise<TokenSummary> =>
    ipcRenderer.invoke(IPC_CHANNELS.TOKEN_GET_CONVERSATION_SUMMARY, args),

  getRecentSessions: (args: {
    workspaceId: string
    limit?: number
  }): Promise<AgentSessionRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.TOKEN_GET_RECENT_SESSIONS, args),

  getWorkspaceUsageSummary: (args: { workspaceId: string }): Promise<WorkspaceUsageSummary> =>
    ipcRenderer.invoke(IPC_CHANNELS.TOKEN_GET_WORKSPACE_USAGE, args),

  getGlobalUsageSummary: (): Promise<WorkspaceUsageSummary> =>
    ipcRenderer.invoke(IPC_CHANNELS.TOKEN_GET_GLOBAL_USAGE),

  // ── Ideas ──
  listIdeas: (args: { workspaceId: string }): Promise<Idea[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.IDEA_LIST, args),

  createIdea: (args: { workspaceId: string; title: string; description: string }): Promise<Idea> =>
    ipcRenderer.invoke(IPC_CHANNELS.IDEA_CREATE, args),

  updateIdea: (args: { id: string; title?: string; description?: string }): Promise<Idea> =>
    ipcRenderer.invoke(IPC_CHANNELS.IDEA_UPDATE, args),

  deleteIdea: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.IDEA_DELETE, args),

  startIdeaGrill: (args: {
    ideaId: string
    workspaceId: string
  }): Promise<{ idea: Idea; conversation: Conversation }> =>
    ipcRenderer.invoke(IPC_CHANNELS.IDEA_START_GRILL, args),

  convertIdeaDirect: (args: {
    ideaId: string
    workspaceId: string
  }): Promise<{ idea: Idea; conversation: Conversation }> =>
    ipcRenderer.invoke(IPC_CHANNELS.IDEA_CONVERT_DIRECT, args),

  completeIdeaFromGrill: (args: {
    conversationId: string
    summary?: string
  }): Promise<Idea | null> => ipcRenderer.invoke(IPC_CHANNELS.IDEA_COMPLETE_FROM_GRILL, args),

  saveIdeaGrillDecisions: (args: { ideaId: string; decisions: string }): Promise<Idea> =>
    ipcRenderer.invoke(IPC_CHANNELS.IDEA_SAVE_GRILL_DECISIONS, args),

  // ── Auto-update ──
  checkForUpdate: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),

  downloadUpdate: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_DOWNLOAD),

  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL),

  getUpdateConfig: (): Promise<UpdateConfig> => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_GET_CONFIG),

  setUpdateConfig: (config: Partial<UpdateConfig>): Promise<UpdateConfig> =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SET_CONFIG, config),

  // ── Events (main → renderer) with cleanup ──
  onActivationProgress: (callback: (data: ActivationProgressEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ActivationProgressEvent): void =>
      callback(data)
    ipcRenderer.on(IPC_CHANNELS.WORKSPACE_ACTIVATION_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.WORKSPACE_ACTIVATION_PROGRESS, handler)
    }
  },
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
      turnLimit?: {
        continuable: boolean
        continuationsUsed: number
        continuationsMax: number
      }
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
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
        turnLimit?: {
          continuable: boolean
          continuationsUsed: number
          continuationsMax: number
        }
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, handler)
    }
  },

  onMessageComplete: (
    callback: (data: {
      conversationId: string
      messageId: string
      taskId?: string
      requestId?: string
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        conversationId: string
        messageId: string
        taskId?: string
        requestId?: string
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, handler)
    }
  },

  onAskQuestion: (
    callback: (data: {
      conversationId: string
      questions: GrillQuestion[]
      action?: string
      requestId?: string
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        conversationId: string
        questions: GrillQuestion[]
        action?: string
        requestId?: string
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_ASK_QUESTION, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_ASK_QUESTION, handler)
    }
  },

  respondToAskUser: (data: { requestId: string; response: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_ASK_USER_RESPOND, data),

  onTaskRetry: (
    callback: (data: {
      taskId: string
      specialist: string
      attempt: number
      maxRetries: number
      escalation?: { fromModel: string; toModel: string }
      reason: string
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        taskId: string
        specialist: string
        attempt: number
        maxRetries: number
        escalation?: { fromModel: string; toModel: string }
        reason: string
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.AGENT_TASK_RETRY, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TASK_RETRY, handler)
    }
  },

  onAgentReady: (callback: (data?: { workspaceId?: string }) => void): (() => void) => {
    const handler = (_event: unknown, data?: { workspaceId?: string }): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.AGENT_READY, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AGENT_READY, handler)
    }
  },

  onAgentTaskChunk: (
    callback: (data: { agentId: string; taskId: string; text: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { agentId: string; taskId: string; text: string }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.AGENT_TASK_CHUNK, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TASK_CHUNK, handler)
    }
  },

  onAgentStatusUpdate: (
    callback: (data: {
      agentId: string
      agentType: string
      status: string
      elapsedMs: number
      tokenUsage: number
      inputTokens?: number
      outputTokens?: number
      contextTokens?: number
      activeMcpTools?: string[]
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        agentId: string
        agentType: string
        status: string
        elapsedMs: number
        tokenUsage: number
        inputTokens?: number
        outputTokens?: number
        contextTokens?: number
        activeMcpTools?: string[]
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.AGENT_STATUS_UPDATE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STATUS_UPDATE, handler)
    }
  },

  // ── Auto-update events ──
  onUpdateAvailable: (
    callback: (info: { version: string; releaseDate?: string; releaseNotes?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      info: { version: string; releaseDate?: string; releaseNotes?: string }
    ): void => callback(info)
    ipcRenderer.on(IPC_CHANNELS.UPDATE_AVAILABLE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_AVAILABLE, handler)
    }
  },

  onUpdateNotAvailable: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC_CHANNELS.UPDATE_NOT_AVAILABLE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_NOT_AVAILABLE, handler)
    }
  },

  onUpdateDownloaded: (callback: (info: { version: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: { version: string }): void =>
      callback(info)
    ipcRenderer.on(IPC_CHANNELS.UPDATE_DOWNLOADED, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_DOWNLOADED, handler)
    }
  },

  onUpdateProgress: (
    callback: (progress: {
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }
    ): void => callback(progress)
    ipcRenderer.on(IPC_CHANNELS.UPDATE_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_PROGRESS, handler)
    }
  },

  onUpdateError: (callback: (message: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string): void => callback(message)
    ipcRenderer.on(IPC_CHANNELS.UPDATE_ERROR, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_ERROR, handler)
    }
  },

  // ── Documents ──
  listDocs: (args: { workspacePath: string }): Promise<DocFile[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOCS_LIST, args),

  readDocFile: (args: { filePath: string }): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOCS_READ_FILE, args),

  renderMermaid: (args: { definition: string; id?: string }): Promise<{ svg: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.DOCS_RENDER_MERMAID, args),

  // ── GitHub ──
  saveGitHubToken: (args: {
    workspaceId: string
    token: string
  }): Promise<{ login: string; tokenType: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GITHUB_SAVE_TOKEN, args),

  validateGitHubToken: (args: {
    token: string
  }): Promise<{ valid: boolean; login: string; scopes: string[]; tokenType: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GITHUB_VALIDATE_TOKEN, args),

  getGitHubStatus: (args: {
    workspaceId: string
  }): Promise<{ configured: boolean; login?: string; tokenType?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GITHUB_GET_STATUS, args),

  removeGitHubToken: (args: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.GITHUB_REMOVE_TOKEN, args),

  // ── Repository ──
  initRepo: (args: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.REPO_INIT, args),

  setRepoRemote: (args: { workspaceId: string; remoteUrl: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.REPO_SET_REMOTE, args),

  getRepoInfo: (args: { workspaceId: string }): Promise<RepoInfo> =>
    ipcRenderer.invoke(IPC_CHANNELS.REPO_GET_INFO, args),

  switchBranch: (args: {
    conversationId: string
  }): Promise<{ switched: boolean; branch: string | null }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_SWITCH_BRANCH, args),

  // ── Code Changes ──
  getFileDetails: (args: {
    conversationId: string
  }): Promise<
    Array<{ filePath: string; changeType: 'created' | 'modified' | 'deleted'; staged: boolean }>
  > => ipcRenderer.invoke(IPC_CHANNELS.REPO_GET_FILE_DETAILS, args),

  getFileDiff: (args: {
    conversationId: string
    filePath: string
  }): Promise<{ oldContent: string; newContent: string; language: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.REPO_GET_FILE_DIFF, args),

  commitFiles: (args: {
    conversationId: string
    filePaths: string[]
    message: string
  }): Promise<{ commitHash: string }> => ipcRenderer.invoke(IPC_CHANNELS.REPO_COMMIT_FILES, args),

  repoPush: (args: { conversationId: string }): Promise<{ branch: string; remote: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.REPO_PUSH, args),

  getPushStatus: (args: {
    conversationId: string
  }): Promise<{ branch: string; commitsAhead: number; hasRemote: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.REPO_GET_PUSH_STATUS, args),

  generateCommitMessage: (args: {
    conversationId: string
    filePaths: string[]
  }): Promise<{ message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.REPO_GENERATE_COMMIT_MESSAGE, args),

  createPr: (args: {
    conversationId: string
    title: string
    body: string
    base: string
    head: string
  }): Promise<{ url: string; number: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.REPO_CREATE_PR, args),

  // ── User Profile ──
  getUserProfile: (): Promise<UserProfile | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.USER_PROFILE_GET),

  upsertUserProfile: (args: { displayName: string; avatarKey: string }): Promise<UserProfile> =>
    ipcRenderer.invoke(IPC_CHANNELS.USER_PROFILE_UPSERT, args),

  // ── Core Agent Aliases ──
  listCoreAgentAliases: (): Promise<CoreAgentAlias[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_AGENT_LIST),

  upsertCoreAgentAlias: (args: {
    agentRole: 'specialist'
    alias: string | null
    avatarKey: string | null
  }): Promise<CoreAgentAlias> => ipcRenderer.invoke(IPC_CHANNELS.CORE_AGENT_UPSERT, args),

  // ── Core Agent Prompts ──
  listCoreAgentPrompts: (): Promise<CoreAgentPrompt[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_AGENT_PROMPT_LIST),

  getCoreAgentPrompt: (args: {
    agentRole: 'specialist'
    mode: 'plan' | 'build' | 'danger'
  }): Promise<CoreAgentPrompt | undefined> =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_AGENT_PROMPT_GET, args),

  upsertCoreAgentPrompt: (args: {
    agentRole: 'specialist'
    mode: 'plan' | 'build' | 'danger'
    promptText: string
  }): Promise<CoreAgentPrompt> => ipcRenderer.invoke(IPC_CHANNELS.CORE_AGENT_PROMPT_UPSERT, args),

  resetCoreAgentPrompt: (args: {
    agentRole: 'specialist'
    mode: 'plan' | 'build' | 'danger'
  }): Promise<CoreAgentPrompt> => ipcRenderer.invoke(IPC_CHANNELS.CORE_AGENT_PROMPT_RESET, args),

  // ── Renderer Logging Bridge ──
  log: (args: {
    level: 'error' | 'warn' | 'info' | 'debug'
    message: string
    data?: unknown[]
  }): void => {
    ipcRenderer.invoke(IPC_CHANNELS.LOG_FROM_RENDERER, args).catch(() => {
      /* non-fatal: IPC may not be ready during early startup — log forwarding is best-effort */
    })
  },

  // ── Zoom ──
  zoomIn: (): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.ZOOM_IN),
  zoomOut: (): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.ZOOM_OUT),
  zoomReset: (): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.ZOOM_RESET),
  zoomSet: (factor: number): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.ZOOM_SET, factor),
  zoomGet: (): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.ZOOM_GET),
  onZoomChanged: (callback: (factor: number) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, factor: number): void => callback(factor)
    ipcRenderer.on(IPC_CHANNELS.ZOOM_CHANGED, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ZOOM_CHANGED, handler)
    }
  },

  // ── Shell ──
  showItemInFolder: (filePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SHOW_ITEM_IN_FOLDER, filePath),

  // ── File Utilities ──
  /** Electron 32+ replacement for the removed File.path property */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ── Checkpoints ──
  listCheckpoints: (args: {
    conversationId: string
  }): Promise<
    { id: string; label: string; gitBranch?: string; gitCommitSha?: string; createdAt: string }[]
  > => ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_LIST, args),

  restoreCheckpoint: (args: {
    checkpointId: string
  }): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_RESTORE, args),

  rewindToCheckpoint: (args: {
    checkpointId: string
    conversationId: string
  }): Promise<{ success: boolean; message: string; messagesRemoved: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_REWIND, args),

  // ── Cost Tracking ──
  getCostSummary: (args: {
    workspaceId: string
  }): Promise<{
    totalCostCents: number
    totalTokens: number
    sessionCount: number
    cacheReadTokens: number
    cacheCreationTokens: number
    cacheHitRate: number
    byAgent: { agentType: string; costCents: number; tokens: number; sessions: number }[]
  }> => ipcRenderer.invoke(IPC_CHANNELS.COST_GET_WORKSPACE_SUMMARY, args),

  getConversationCost: (args: { conversationId: string }): Promise<number> =>
    ipcRenderer.invoke(IPC_CHANNELS.COST_GET_CONVERSATION, args),

  getWorkspaceConversationCosts: (args: {
    workspaceId: string
  }): Promise<{ conversationId: string; costCents: number; totalTokens: number }[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.COST_GET_WORKSPACE_CONVERSATIONS, args),

  checkBudget: (args: {
    workspaceId: string
  }): Promise<{
    currentCostCents: number
    dailyBudgetCents: number
    sessionBudgetCents: number
    dailyPercentUsed: number
    dailyWarning: boolean
    dailyExceeded: boolean
  }> => ipcRenderer.invoke(IPC_CHANNELS.COST_CHECK_BUDGET, args),

  onBudgetWarning: (
    callback: (data: {
      workspaceId: string
      currentCostCents: number
      budgetCents: number
      percentUsed: number
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        workspaceId: string
        currentCostCents: number
        budgetCents: number
        percentUsed: number
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.COST_BUDGET_WARNING, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.COST_BUDGET_WARNING, handler)
    }
  },

  onBudgetExceeded: (
    callback: (data: { workspaceId: string; currentCostCents: number; budgetCents: number }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { workspaceId: string; currentCostCents: number; budgetCents: number }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.COST_BUDGET_EXCEEDED, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.COST_BUDGET_EXCEEDED, handler)
    }
  },

  // ── Conversation Insights ──
  getConversationInsights: (args: {
    conversationId: string
  }): Promise<{
    messageCount: { user: number; assistant: number }
    tokenSummary: { inputTokens: number; outputTokens: number }
    costCents: number
    durationMs: number
  }> => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_INSIGHTS, args),

  // ── Events (audit log) ──
  getRecentEvents: (args?: {
    workspaceId?: string
    limit?: number
  }): Promise<
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
  > => ipcRenderer.invoke(IPC_CHANNELS.EVENTS_GET_RECENT, args),

  getConversationEvents: (args: {
    conversationId: string
    limit?: number
  }): Promise<
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
  > => ipcRenderer.invoke(IPC_CHANNELS.EVENTS_GET_BY_CONVERSATION, args),

  // ── Agent Events ──
  onAbandonmentDetected: (
    callback: (data: { taskId: string; specialist: string; pattern: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { taskId: string; specialist: string; pattern: string }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.AGENT_ABANDONMENT_DETECTED, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AGENT_ABANDONMENT_DETECTED, handler)
    }
  },

  // ── Checkpoint Approval ──
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
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
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
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHECKPOINT_APPROVAL_REQUEST, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHECKPOINT_APPROVAL_REQUEST, handler)
    }
  },

  respondCheckpointApproval: (checkpointId: string, approved: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_APPROVAL_RESPONSE, { checkpointId, approved }),

  // ── Hooks ──
  listHooks: (): Promise<
    Array<{
      event: string
      name: string
      command: string
      blocking: boolean
      condition?: { mode?: string; model?: string; agent?: string }
      timeout?: number
    }>
  > => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_LIST),

  reloadHooks: (args: {
    workspacePath: string
  }): Promise<
    Array<{
      event: string
      name: string
      command: string
      blocking: boolean
      condition?: { mode?: string; model?: string; agent?: string }
      timeout?: number
    }>
  > => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_RELOAD, args),

  // ── AI Subscriptions ──
  validateSubscriptions: (): Promise<SubscriptionCheckResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_VALIDATE_ALL),
  checkClaudeCli: (): Promise<{
    installed: boolean
    version: string | null
    error: string | null
  }> => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_CHECK_CLAUDE_CLI),
  autoConfigureClaude: (): Promise<AutoConfigureResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_AUTO_CONFIGURE),

  // ── Embedding Provider ──
  embeddingCheckStatus: (args?: { baseUrl?: string; apiKey?: string; workspaceId?: string }): Promise<EmbeddingModelStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.EMBEDDING_CHECK_STATUS, args),

  embeddingInitialize: (args?: { baseUrl?: string; apiKey?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.EMBEDDING_INITIALIZE, args),

  onEmbeddingModelReady: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC_CHANNELS.EMBEDDING_MODEL_READY, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EMBEDDING_MODEL_READY, handler)
    }
  },

  onEmbeddingModelError: (callback: (error: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string): void => callback(error)
    ipcRenderer.on(IPC_CHANNELS.EMBEDDING_MODEL_ERROR, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.EMBEDDING_MODEL_ERROR, handler)
    }
  },

  // ── Ollama — @deprecated for semantic search (still used by Local LLM chat) ──
  ollamaCheckStatus: (args?: { baseUrl?: string }): Promise<OllamaStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.OLLAMA_CHECK_STATUS, args),

  ollamaPullModel: (args: { model: string; baseUrl?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OLLAMA_PULL_MODEL, args),

  ollamaCancelPull: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.OLLAMA_CANCEL_PULL),

  ollamaRemoveModel: (args: { model: string; baseUrl?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OLLAMA_REMOVE_MODEL, args),

  ollamaStart: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.OLLAMA_START),

  // ── oMLX ──
  omlxCheckStatus: (args?: {
    baseUrl?: string
    apiKey?: string
  }): Promise<import('../shared/types').OmlxExtendedStatus> =>
    ipcRenderer.invoke(IPC_CHANNELS.OMLX_CHECK_STATUS, args),

  omlxStart: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.OMLX_START),

  omlxAdminUrl: (args?: { baseUrl?: string }): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.OMLX_ADMIN_URL, args),

  omlxLoadModel: (args: { modelId: string; baseUrl?: string; apiKey?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OMLX_LOAD_MODEL, args),

  omlxUnloadModel: (args: { modelId: string; baseUrl?: string; apiKey?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.OMLX_UNLOAD_MODEL, args),

  // ── Platform ──
  getPlatformInfo: (): Promise<import('../shared/types').PlatformInfo> =>
    ipcRenderer.invoke(IPC_CHANNELS.PLATFORM_INFO),

  onOllamaPullProgress: (callback: (data: PullProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: PullProgress): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.OLLAMA_PULL_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OLLAMA_PULL_PROGRESS, handler)
    }
  },

  onOllamaPullComplete: (callback: (model: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, model: string): void => callback(model)
    ipcRenderer.on(IPC_CHANNELS.OLLAMA_PULL_COMPLETE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OLLAMA_PULL_COMPLETE, handler)
    }
  },

  onOllamaPullError: (callback: (error: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string): void => callback(error)
    ipcRenderer.on(IPC_CHANNELS.OLLAMA_PULL_ERROR, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.OLLAMA_PULL_ERROR, handler)
    }
  },

  // ── Indexing (semantic search) ──
  indexingStart: (args: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.INDEXING_START, args),

  indexingPause: (args: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.INDEXING_PAUSE, args),

  indexingResume: (args: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.INDEXING_RESUME, args),

  indexingCancel: (args: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.INDEXING_CANCEL, args),

  indexingGetStatus: (args: { workspaceId: string }): Promise<IndexingState> =>
    ipcRenderer.invoke(IPC_CHANNELS.INDEXING_GET_STATUS, args),

  loadPersistedIndex: (args: {
    workspaceId: string
  }): Promise<{ loaded: boolean; status: string; symbolCount?: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.INDEXING_LOAD_PERSISTED, args),

  onIndexingProgress: (callback: (state: IndexingState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: IndexingState): void =>
      callback(state)
    ipcRenderer.on(IPC_CHANNELS.INDEXING_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.INDEXING_PROGRESS, handler)
    }
  },

  // ── Semantic Search query ──
  semanticSearchQuery: (args: {
    workspaceId: string
    query: string
    nResults?: number
  }): Promise<SemanticSearchResult[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SEMANTIC_SEARCH_QUERY, args),

  // ── Code Graph (persisted repomap) ──
  codeGraphIndexStart: (args: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CODE_GRAPH_INDEX_START, args),

  codeGraphGetStatus: (args: { workspaceId: string }): Promise<CodeGraphIndexingState> =>
    ipcRenderer.invoke(IPC_CHANNELS.CODE_GRAPH_GET_STATUS, args),

  codeGraphHasIndex: (args: { workspaceId: string }): Promise<boolean> =>
    ipcRenderer.invoke(IPC_CHANNELS.CODE_GRAPH_HAS_INDEX, args),

  onCodeGraphProgress: (callback: (state: CodeGraphIndexingState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: CodeGraphIndexingState): void =>
      callback(state)
    ipcRenderer.on(IPC_CHANNELS.CODE_GRAPH_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CODE_GRAPH_PROGRESS, handler)
    }
  },

  // ── Context Usage ──
  getContextUsage: (args: { conversationId: string }): Promise<ContextUsage> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_GET_CONTEXT_USAGE, args),

  // ── Conversation Reorder ──
  reorderConversations: (args: { orderedIds: string[] }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_REORDER, args),

  // ── SDK Events ──
  onRateLimitEvent: (
    callback: (data: {
      status: string
      utilization?: number
      resetsAt?: number
      rateLimitType?: string
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { status: string; utilization?: number; resetsAt?: number; rateLimitType?: string }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SDK_RATE_LIMIT, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SDK_RATE_LIMIT, handler)
    }
  },

  onPromptSuggestion: (
    callback: (data: { conversationId: string; suggestion: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { conversationId: string; suggestion: string }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SDK_PROMPT_SUGGESTION, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SDK_PROMPT_SUGGESTION, handler)
    }
  },

  onApiRetry: (
    callback: (data: {
      attempt: number
      maxRetries: number
      retryDelayMs: number
      errorStatus: number | null
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        attempt: number
        maxRetries: number
        retryDelayMs: number
        errorStatus: number | null
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SDK_API_RETRY, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SDK_API_RETRY, handler)
    }
  },

  onSessionState: (callback: (data: { state: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { state: string }): void =>
      callback(data)
    ipcRenderer.on(IPC_CHANNELS.SDK_SESSION_STATE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SDK_SESSION_STATE, handler)
    }
  },

  onSessionRecovery: (
    callback: (data: { conversationId: string; phase: string; message: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { conversationId: string; phase: string; message: string }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_SESSION_RECOVERY, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_SESSION_RECOVERY, handler)
    }
  },

  onAuthStatus: (
    callback: (data: { message: string; requestId?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { message: string; requestId?: string }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SDK_AUTH_STATUS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SDK_AUTH_STATUS, handler)
    }
  },

  onFilesPersisted: (
    callback: (data: { conversationId: string; files: string[]; requestId?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { conversationId: string; files: string[]; requestId?: string }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SDK_FILES_PERSISTED, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SDK_FILES_PERSISTED, handler)
    }
  },

  onHookLifecycle: (
    callback: (data: { hookName?: string; hookState?: string; requestId?: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { hookName?: string; hookState?: string; requestId?: string }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SDK_HOOK_LIFECYCLE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SDK_HOOK_LIFECYCLE, handler)
    }
  },

  // N3: LSP diagnostics from OpenCode's compiler/linter integration
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
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        conversationId: string
        diagnostics: Array<{
          file: string
          line: number
          severity: 'error' | 'warning' | 'info' | 'hint'
          message: string
          source?: string
        }>
        requestId?: string
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SDK_LSP_DIAGNOSTICS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SDK_LSP_DIAGNOSTICS, handler)
    }
  },

  onStateChange: (
    callback: (data: {
      conversationId: string | null
      from: string
      to: string
      event: string
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        conversationId: string | null
        from: string
        to: string
        event: string
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_STATE_CHANGE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_STATE_CHANGE, handler)
    }
  },

  // ── SDK Control — Query instance methods ──
  sdkStopTask: (args: { taskId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SDK_STOP_TASK, args),

  sdkSupportedModels: (): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.SDK_SUPPORTED_MODELS),

  // SDK Subagent inspection (0.2.96+)
  sdkListSubagents: (args: { sessionId: string }): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SDK_LIST_SUBAGENTS, args),

  sdkGetSubagentMessages: (args: { sessionId: string; subagentId: string }): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SDK_GET_SUBAGENT_MESSAGES, args),

  // SDK Elicitation (enriched — via elicitation.service)
  onSdkElicitationRequest: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_event: unknown, data: unknown): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.SDK_ELICITATION_REQUEST, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SDK_ELICITATION_REQUEST, handler)
  },

  sdkElicitationRespond: (args: {
    requestId: string
    action: string
    content?: Record<string, unknown>
  }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.SDK_ELICITATION_RESPONSE, args),

  // Session Management (SDK top-level functions)
  sessionList: (args?: { dir?: string; limit?: number; offset?: number }): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST, args),

  sessionGetInfo: (args: { sessionId: string; dir?: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_INFO, args),

  sessionGetMessages: (args: {
    sessionId: string
    dir?: string
    includeSystemMessages?: boolean
  }): Promise<unknown[]> => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET_MESSAGES, args),

  sessionRename: (args: { sessionId: string; title: string; dir?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_RENAME, args),

  sessionTag: (args: { sessionId: string; tag: string | null; dir?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_TAG, args),

  sessionFork: (args: {
    sessionId: string
    upToMessageId?: string
    title?: string
    dir?: string
  }): Promise<{ sessionId: string }> => ipcRenderer.invoke(IPC_CHANNELS.SESSION_FORK, args),

  // Session mutation — branch a conversation (legacy alias)
  sdkForkSession: (args: {
    sessionId: string
    upToMessageId?: string
  }): Promise<{ sessionId: string }> => ipcRenderer.invoke(IPC_CHANNELS.SDK_FORK_SESSION, args),

  // SDK Diagnostics (@alpha — 0.2.138+)
  resolveSettings: (): Promise<{
    success: boolean
    settings?: Record<string, unknown>
    error?: string
  }> => ipcRenderer.invoke(IPC_CHANNELS.SDK_RESOLVE_SETTINGS),

  // Stream Diagnostics — aggregated streaming health metrics
  getStreamMetrics: (): Promise<{
    completionRate: number
    ttftP50: number | null
    ttftP95: number | null
    ttftP99: number | null
    sampleSize: number
    outcomeCounts: Record<string, number>
  }> => ipcRenderer.invoke(IPC_CHANNELS.STREAM_METRICS_GET),

  // Persist plan card action on a message
  chatSetPlanAction: (args: { messageId: string; action: string }): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_SET_PLAN_ACTION, args),

  // Chat resume at checkpoint — undo to a specific message point
  chatResumeAt: (args: { conversationId: string; messageId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_RESUME_AT, args),

  // ── Bug Tracker ──
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
  }): Promise<{ isNew: boolean; bugId: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BUG_REPORT, input),

  getBugs: (filters?: {
    process?: 'main' | 'renderer' | 'preload'
    isResolved?: boolean
    workspaceId?: string
    sortBy?: 'last_seen_at' | 'occurrence_count' | 'severity'
    sortDir?: 'asc' | 'desc'
  }): Promise<unknown[]> => ipcRenderer.invoke(IPC_CHANNELS.BUG_LIST, filters),

  getBug: (args: { id: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.BUG_GET, args),

  resolveBug: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.BUG_RESOLVE, args),

  unresolveBug: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.BUG_UNRESOLVE, args),

  deleteBug: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.BUG_DELETE, args),

  updateBugNote: (args: { id: string; note: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.BUG_UPDATE_NOTE, args),

  getBugCount: (): Promise<number> => ipcRenderer.invoke(IPC_CHANNELS.BUG_COUNT),

  onNewBug: (callback: (bug: unknown) => void): (() => void) => {
    const handler = (_event: unknown, bug: unknown): void => callback(bug)
    ipcRenderer.on(IPC_CHANNELS.BUG_NEW, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BUG_NEW, handler)
  },

  // ── Audit (Workspace Health) ──
  auditStart: (args: {
    workspaceId: string
    mode: AuditMode
    tracks: AuditTrackId[]
    llmProvider?: LLMProvider
    selectedSkills?: AuditSelectedSkills
  }): Promise<AuditRun> => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_START, args),

  auditCancel: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_CANCEL),

  auditGetLatest: (args: { workspaceId: string }): Promise<AuditRun | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_GET_LATEST, args),

  auditConvertFindings: (args: {
    workspaceId: string
    findings: AuditFinding[]
  }): Promise<{ conversationId: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_CONVERT_FINDINGS, args),

  auditHandoffToChat: (args: {
    workspaceId: string
    auditRunId: string
    trackIds?: AuditTrackId[]
    mode: 'consolidated' | 'split'
  }): Promise<{ conversationIds: string[]; count: number }> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_HANDOFF_TO_CHAT, args),

  auditRerunTrack: (args: {
    workspaceId: string
    trackId: AuditTrackId
    mode: AuditMode
  }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_RERUN_TRACK, args),

  auditResume: (args: { workspaceId: string }): Promise<AuditRun | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_RESUME, args),

  auditExportMarkdown: (args: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_EXPORT_MARKDOWN, args),

  auditExportPlanMarkdown: (args: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_EXPORT_PLAN_MARKDOWN, args),

  auditGetHistory: (args: { workspaceId: string; limit?: number }): Promise<AuditRun[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_GET_HISTORY, args),

  auditDeleteRun: (args: { runId: string }): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_DELETE_RUN, args),

  auditGeneratePlan: (args: {
    workspaceId: string
    runId: string
    findings: AuditFinding[]
  }): Promise<AuditPlanRecord> => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_GENERATE_PLAN, args),

  auditGetPlans: (args: { runId: string }): Promise<AuditPlanRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.AUDIT_GET_PLANS, args),

  // ── Plan Hub (unified plan registry) ──
  planGetAll: (args: {
    workspaceId: string
    filters?: { status?: string | string[]; source?: string; search?: string }
  }): Promise<PlanRecord[]> => ipcRenderer.invoke(IPC_CHANNELS.PLAN_GET_ALL, args),

  planGetById: (args: { planId: string }): Promise<PlanRecord | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAN_GET_BY_ID, args),

  planUpdateStatus: (args: {
    planId: string
    status: string
    linkedConversationId?: string
    linkedMpaRunId?: string
    linkedCouncilSessionId?: string
  }): Promise<{ success: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.PLAN_UPDATE_STATUS, args),

  planDelete: (args: { planId: string }): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAN_DELETE, args),

  planImport: (args: {
    planId: string
    workspaceId: string
  }): Promise<{ conversationId: string; planId: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PLAN_IMPORT, args),



  onAuditProgress: (cb: (data: AuditProgressEvent) => void): (() => void) => {
    const handler = (_: unknown, data: AuditProgressEvent): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.AUDIT_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AUDIT_PROGRESS, handler)
  },

  onAuditResult: (cb: (data: AuditResult) => void): (() => void) => {
    const handler = (_: unknown, data: AuditResult): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.AUDIT_RESULT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AUDIT_RESULT, handler)
  },

  onAuditComplete: (cb: (data: AuditRun) => void): (() => void) => {
    const handler = (_: unknown, data: AuditRun): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.AUDIT_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AUDIT_COMPLETE, handler)
  },

  onAuditStreamChunk: (cb: (data: AuditStreamChunkEvent) => void): (() => void) => {
    const handler = (_: unknown, data: AuditStreamChunkEvent): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.AUDIT_STREAM_CHUNK, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AUDIT_STREAM_CHUNK, handler)
  },

  onAuditIntermediate: (cb: (data: AuditIntermediateEvent) => void): (() => void) => {
    const handler = (_: unknown, data: AuditIntermediateEvent): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.AUDIT_INTERMEDIATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AUDIT_INTERMEDIATE, handler)
  },

  // ── Grill (dedicated agent) ──
  grillEvaluate: (args: {
    workspaceId: string
    trackId: string
    ideaTitle: string
    ideaDescription: string
    iterationHistory?: string
    previousScore?: number
    ideaId?: string
    llmProvider?: LLMProvider
    greenfield?: boolean
    projectName?: string
  }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.GRILL_EVALUATE, args),

  grillCancel: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.GRILL_CANCEL),

  onGrillStreamChunk: (
    cb: (data: { type: string; content?: string; toolActivity?: Record<string, unknown> }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: { type: string; content?: string; toolActivity?: Record<string, unknown> }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.GRILL_STREAM_CHUNK, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.GRILL_STREAM_CHUNK, handler)
  },

  onGrillEvaluationResult: (
    cb: (data: {
      trackId?: string
      score: number
      scoreLabel: string
      feedback: string
      questions: GrillQuestion[]
      suggestedNextTrack?: { trackId: string; reason: string }
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        trackId?: string
        score: number
        scoreLabel: string
        feedback: string
        questions: GrillQuestion[]
        suggestedNextTrack?: { trackId: string; reason: string }
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.GRILL_EVALUATION_RESULT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.GRILL_EVALUATION_RESULT, handler)
  },

  onGrillStreamComplete: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on(IPC_CHANNELS.GRILL_STREAM_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.GRILL_STREAM_COMPLETE, handler)
  },

  grillCondenseRequirement: (args: { text: string; workspaceId?: string }): Promise<{ condensed: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GRILL_CONDENSE_REQUIREMENT, args),

  grillGeneratePlan: (args: {
    sessionId: string
    ideaId?: string
    workspaceId: string
  }): Promise<GrillStructuredPlan> => ipcRenderer.invoke(IPC_CHANNELS.GRILL_GENERATE_PLAN, args),

  grillGeneratePlanFromDecisions: (args: {
    projectName: string
    description: string
    grillDecisions: GrillDecision[]
    trackScores?: GrillTrackScore[]
    workspaceId: string
  }): Promise<GrillStructuredPlan> =>
    ipcRenderer.invoke(IPC_CHANNELS.GRILL_GENERATE_PLAN_FROM_DECISIONS, args),

  grillGetStatus: (args: {
    workspaceId: string
  }): Promise<{
    status: string
    ideaId: string
    trackId: string | null
    score: number | null
  } | null> => ipcRenderer.invoke(IPC_CHANNELS.GRILL_GET_STATUS, args),

  grillGetSession: (args: { ideaId: string }): Promise<unknown | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.GRILL_GET_SESSION, args),

  grillListPlannedIdeas: (args: { workspaceId: string }): Promise<string[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.GRILL_LIST_PLANNED_IDEAS, args),

  grillComplete: (args: { ideaId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.GRILL_COMPLETE, args),

  grillSeedPlanCard: (args: {
    conversationId: string
    plan: GrillStructuredPlan
  }): Promise<Message> => ipcRenderer.invoke(IPC_CHANNELS.GRILL_SEED_PLAN_CARD, args),

  grillDiscard: (args: { ideaId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.GRILL_DISCARD, args),

  grillSaveAnswers: (args: {
    sessionId: string
    questionStates: Record<string, unknown>
  }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.GRILL_SAVE_ANSWERS, args),

  onGrillStatusChanged: (
    cb: (data: {
      status: string
      ideaId: string
      trackId: string | null
      score: number | null
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: { status: string; ideaId: string; trackId: string | null; score: number | null }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.GRILL_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.GRILL_STATUS_CHANGED, handler)
  },

  // ── MPA (Multi-Phased Agent Pipeline) ──

  mpaCancel: (args?: { workspaceId?: string }): Promise<{ cancelled: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MPA_CANCEL, args),

  mpaGetStatus: (args: {
    workspaceId: string
  }): Promise<{
    status: string
    runId: string | null
    currentPhase: string | null
    phaseIndex: number
    totalPhases: number
    iteration: number
    awaitingApproval: boolean
  }> => ipcRenderer.invoke(IPC_CHANNELS.MPA_GET_STATUS, args),

  mpaGetRun: (args: { runId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.MPA_GET_RUN, args),

  mpaGetHistory: (args: { workspaceId: string; limit?: number }): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MPA_GET_HISTORY, args),

  mpaApprovalRespond: (args: {
    runId: string
    approved: boolean
    feedback?: string
  }): Promise<{ responded: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MPA_APPROVAL_RESPOND, args),

  mpaResume: (args: { runId: string; workspaceId: string }): Promise<{ resumed: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MPA_RESUME, args),

  onMpaPhaseStart: (
    cb: (data: {
      workspaceId: string
      runId: string
      phaseId: string
      phaseType: string
      iteration: number
      agentRole: string
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        workspaceId: string
        runId: string
        phaseId: string
        phaseType: string
        iteration: number
        agentRole: string
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.MPA_PHASE_START, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MPA_PHASE_START, handler)
  },

  onMpaPhaseProgress: (
    cb: (data: {
      workspaceId: string
      runId: string
      phaseId: string
      phaseType: string
      streamChunk: string
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        workspaceId: string
        runId: string
        phaseId: string
        phaseType: string
        streamChunk: string
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.MPA_PHASE_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MPA_PHASE_PROGRESS, handler)
  },

  onMpaPhaseComplete: (
    cb: (data: {
      workspaceId: string
      runId: string
      phaseId: string
      phaseType: string
      status: string
      tokensUsed: number
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        workspaceId: string
        runId: string
        phaseId: string
        phaseType: string
        status: string
        tokensUsed: number
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.MPA_PHASE_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MPA_PHASE_COMPLETE, handler)
  },

  onMpaFeedbackLoop: (
    cb: (data: {
      workspaceId: string
      runId: string
      fromPhase: string
      toPhase: string
      iteration: number
      reason: string
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        workspaceId: string
        runId: string
        fromPhase: string
        toPhase: string
        iteration: number
        reason: string
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.MPA_FEEDBACK_LOOP, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MPA_FEEDBACK_LOOP, handler)
  },

  onMpaApprovalNeeded: (
    cb: (data: {
      workspaceId: string
      runId: string
      phaseId: string
      artifactId: string
      artifact: unknown
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        workspaceId: string
        runId: string
        phaseId: string
        artifactId: string
        artifact: unknown
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.MPA_APPROVAL_NEEDED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MPA_APPROVAL_NEEDED, handler)
  },

  onMpaPipelineComplete: (
    cb: (data: { workspaceId: string; runId: string; status: string; totalTokens: number }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: { workspaceId: string; runId: string; status: string; totalTokens: number }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.MPA_PIPELINE_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MPA_PIPELINE_COMPLETE, handler)
  },

  // ── MPA Campaigns (sequential measurable-goal runs) ──

  mpaDecomposeGoals: (args: {
    workspaceId: string
    input: string
  }): Promise<{
    goals: Array<{
      id: string
      title: string
      outcome: string
      successCriteria: string[]
      goalType: string
      phases: string[]
    }>
  }> => ipcRenderer.invoke(IPC_CHANNELS.MPA_DECOMPOSE_GOALS, args),

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
  }): Promise<{ campaignId: string }> => ipcRenderer.invoke(IPC_CHANNELS.MPA_CAMPAIGN_START, args),

  mpaCampaignRespond: (args: {
    workspaceId: string
    action: 'retry' | 'skip' | 'stop'
  }): Promise<{ responded: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MPA_CAMPAIGN_RESPOND, args),

  mpaCampaignCancel: (args: { workspaceId: string }): Promise<{ cancelled: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MPA_CAMPAIGN_CANCEL, args),

  mpaCampaignGetHistory: (args: { workspaceId: string; limit?: number }): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MPA_CAMPAIGN_GET_HISTORY, args),

  mpaCampaignGetDetail: (args: { campaignId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.MPA_CAMPAIGN_GET_DETAIL, args),

  onMpaCampaignStarted: (
    cb: (data: {
      workspaceId: string
      campaignId: string
      title: string
      totalGoals: number
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: { workspaceId: string; campaignId: string; title: string; totalGoals: number }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.MPA_CAMPAIGN_STARTED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MPA_CAMPAIGN_STARTED, handler)
  },

  onMpaCampaignGoalStart: (
    cb: (data: {
      workspaceId: string
      campaignId: string
      orderIndex: number
      goalId: string
      title: string
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        workspaceId: string
        campaignId: string
        orderIndex: number
        goalId: string
        title: string
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.MPA_CAMPAIGN_GOAL_START, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MPA_CAMPAIGN_GOAL_START, handler)
  },

  onMpaCampaignGoalComplete: (
    cb: (data: {
      workspaceId: string
      campaignId: string
      orderIndex: number
      goalId: string
      status: string
      runId: string | null
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        workspaceId: string
        campaignId: string
        orderIndex: number
        goalId: string
        status: string
        runId: string | null
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.MPA_CAMPAIGN_GOAL_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MPA_CAMPAIGN_GOAL_COMPLETE, handler)
  },

  onMpaCampaignPaused: (
    cb: (data: {
      workspaceId: string
      campaignId: string
      orderIndex: number
      goalId: string
      runId: string | null
      reason: string
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        workspaceId: string
        campaignId: string
        orderIndex: number
        goalId: string
        runId: string | null
        reason: string
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.MPA_CAMPAIGN_PAUSED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MPA_CAMPAIGN_PAUSED, handler)
  },

  onMpaCampaignComplete: (
    cb: (data: {
      workspaceId: string
      campaignId: string
      status: string
      completedGoals: number
      totalGoals: number
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        workspaceId: string
        campaignId: string
        status: string
        completedGoals: number
        totalGoals: number
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.MPA_CAMPAIGN_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MPA_CAMPAIGN_COMPLETE, handler)
  },

  // ── Multi-Workspace Session Management ──

  /** Get statuses of all running workspace sessions. */
  getAllWorkspaceStatuses: (): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ALL_STATUSES),

  /**
   * Listen for status updates from ANY workspace (tagged with workspaceId).
   *
   * NOTE: This shares the AGENT_STATUS_UPDATE IPC channel with onAgentStatusUpdate.
   * Both listeners fire for every status event — by design:
   * - onAgentStatusUpdate feeds useAgentStore (active session UI)
   * - onWorkspaceStatusUpdate feeds useBackgroundSessionStore (sidebar indicators)
   * Each store serves a distinct purpose; the duplicate listener cost is negligible.
   */
  onWorkspaceStatusUpdate: (
    cb: (data: {
      workspaceId: string
      status: string
      agentId: string
      agentType: string
      elapsedMs: number
      tokenUsage: number
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        workspaceId: string
        status: string
        agentId: string
        agentType: string
        elapsedMs: number
        tokenUsage: number
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.AGENT_STATUS_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STATUS_UPDATE, handler)
  },

  /** Listen for permission requests from background workspaces. */
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
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        id: string
        workspaceId: string
        workspaceName: string
        type: string
        summary: string
        isSimple: boolean
        payload: unknown
        receivedAt: number
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.PERMISSION_REQUEST, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PERMISSION_REQUEST, handler)
  },

  /** Respond to a permission request. */
  respondToPermission: (args: {
    permissionId: string
    workspaceId: string
    type: string
    response: unknown
  }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_RESPONSE, args),

  /** Listen for OS notification click-to-navigate events. */
  onNotificationNavigate: (
    cb: (data: { workspaceId: string; targetPage: string; entityId?: string }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: { workspaceId: string; targetPage: string; entityId?: string }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_NAVIGATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION_NAVIGATE, handler)
  },

  /** Listen for completion/failure notifications from background workspaces. */
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
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        workspaceId: string
        workspaceName: string
        service: string
        status: string
        summary: string
        targetPage?: string
        entityId?: string
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.COMPLETION_NOTIFICATION, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COMPLETION_NOTIFICATION, handler)
  },

  // ── Blueprint Pipeline (Specify + Clarify) ──

  blueprintCreate: (args: {
    workspaceId: string
    title: string
    description?: string
    priority?: string
    settingsJson?: Record<string, unknown>
  }): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_CREATE, args),

  blueprintCreateFromIdea: (args: { ideaId: string; workspaceId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_CREATE_FROM_IDEA, args),

  blueprintStartSpecify: (args: {
    blueprintId: string
    workspaceId: string
  }): Promise<{ started: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_START_SPECIFY, args),

  blueprintStartClarify: (args: {
    blueprintId: string
    workspaceId: string
  }): Promise<{ started: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_START_CLARIFY, args),

  blueprintClarifyAnswer: (args: {
    blueprintId: string
    workspaceId: string
    message: string
  }): Promise<{ sent: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_CLARIFY_ANSWER, args),

  blueprintSkipClarify: (args: { blueprintId: string }): Promise<{ skipped: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_SKIP_CLARIFY, args),

  blueprintClarifyProceed: (args: {
    blueprintId: string
    workspaceId: string
  }): Promise<{ proceeded: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_CLARIFY_PROCEED, args),

  blueprintClarifyIterate: (args: {
    blueprintId: string
    workspaceId: string
  }): Promise<{ iterated: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_CLARIFY_ITERATE, args),

  blueprintStartPlan: (args: {
    blueprintId: string
    workspaceId: string
  }): Promise<{ started: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_START_PLAN, args),

  blueprintStartTasks: (args: {
    blueprintId: string
    workspaceId: string
  }): Promise<{ started: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_START_TASKS, args),

  blueprintStartReview: (args: {
    blueprintId: string
    workspaceId: string
  }): Promise<{ started: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_START_REVIEW, args),

  blueprintStartBuild: (args: {
    blueprintId: string
    workspaceId: string
  }): Promise<{ started: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_START_BUILD, args),

  blueprintStartVerify: (args: {
    blueprintId: string
    workspaceId: string
  }): Promise<{ started: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_START_VERIFY, args),

  blueprintGet: (args: { id: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_GET, args),

  blueprintGetDetails: (args: { id: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_GET_DETAILS, args),

  blueprintList: (args: { workspaceId: string; limit?: number }): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_LIST, args),

  blueprintCancel: (args: { workspaceId: string }): Promise<{ cancelled: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_CANCEL, args),

  blueprintDelete: (args: { id: string }): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_DELETE, args),

  blueprintGetConstitution: (args: {
    workspaceId: string
  }): Promise<{ constitutionMd: string | null; constitutionVersion: string } | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_GET_CONSTITUTION, args),

  blueprintSaveConstitution: (args: {
    workspaceId: string
    constitutionMd: string
    version?: string
  }): Promise<{ saved: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_SAVE_CONSTITUTION, args),

  blueprintGetPipelineStatus: (args: {
    workspaceId: string
  }): Promise<{ running: boolean; blueprintId: string | null; currentPhase: string | null }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_GET_PIPELINE_STATUS, args),

  blueprintRetryPhase: (args: {
    blueprintId: string
    workspaceId: string
  }): Promise<{ retrying: boolean; phase: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_RETRY_PHASE, args),

  // M3: Transcript retrieval
  blueprintGetTranscript: (args: {
    blueprintId: string
    afterSeq?: number
  }): Promise<Array<{
    id: string
    blueprintId: string
    seq: number
    type: string
    payload: Record<string, unknown>
    createdAt: string
  }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_GET_TRANSCRIPT, args),

  onBlueprintPhaseStart: (
    cb: (data: { blueprintId: string; workspaceId: string; phase: string }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: { blueprintId: string; workspaceId: string; phase: string }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_PHASE_START, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_PHASE_START, handler)
  },

  onBlueprintPhaseProgress: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      phase: string
      text: string
      kind?: 'text' | 'tool'
      toolActivity?: Record<string, unknown>
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        blueprintId: string
        workspaceId: string
        phase: string
        text: string
        kind?: 'text' | 'tool'
        toolActivity?: Record<string, unknown>
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_PHASE_PROGRESS, handler)
  },

  onBlueprintPhaseComplete: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      phase: string
      status: string
      completion?: unknown
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        blueprintId: string
        workspaceId: string
        phase: string
        status: string
        completion?: unknown
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_PHASE_COMPLETE, handler)
  },

  onBlueprintPhaseArtifact: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      phase: string
      artifact: { type: string; filePath?: string; contentMd?: string; contentJson?: Record<string, unknown> }
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        blueprintId: string
        workspaceId: string
        phase: string
        artifact: { type: string; filePath?: string; contentMd?: string; contentJson?: Record<string, unknown> }
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_PHASE_ARTIFACT, handler)
  },

  blueprintApprovalRespond: (args: {
    blueprintId: string
    approved: boolean
    feedback?: string
  }): Promise<{ responded: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_APPROVAL_RESPOND, args),

  onBlueprintClarifyAwaitingInput: (
    cb: (data: { blueprintId: string; workspaceId: string }) => void
  ): (() => void) => {
    const handler = (_: unknown, data: { blueprintId: string; workspaceId: string }): void =>
      cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_CLARIFY_AWAITING_INPUT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_CLARIFY_AWAITING_INPUT, handler)
  },

  onBlueprintClarifyFindings: (cb: (data: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_CLARIFY_FINDINGS, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_CLARIFY_FINDINGS, handler)
  },

  onBlueprintClarifyQuestions: (cb: (data: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_CLARIFY_QUESTIONS, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_CLARIFY_QUESTIONS, handler)
  },

  onBlueprintClarifyGate: (cb: (data: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_CLARIFY_GATE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_CLARIFY_GATE, handler)
  },

  onBlueprintApprovalNeeded: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      phase: string
      planSummary: string
      completion?: Record<string, unknown>
      reviewMarkdown?: string
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        blueprintId: string
        workspaceId: string
        phase: string
        planSummary: string
        completion?: Record<string, unknown>
        reviewMarkdown?: string
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_APPROVAL_NEEDED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_APPROVAL_NEEDED, handler)
  },

  onBlueprintWaveStart: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      wave: number
      taskCount: number
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        blueprintId: string
        workspaceId: string
        wave: number
        taskCount: number
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_WAVE_START, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_WAVE_START, handler)
  },

  onBlueprintWaveTaskStart: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      wave: number
      taskId: string
      description: string
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        blueprintId: string
        workspaceId: string
        wave: number
        taskId: string
        description: string
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_WAVE_TASK_START, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_WAVE_TASK_START, handler)
  },

  onBlueprintWaveTaskComplete: (
    cb: (data: {
      blueprintId: string
      workspaceId: string
      wave: number
      taskId: string
      status: string
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        blueprintId: string
        workspaceId: string
        wave: number
        taskId: string
        status: string
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_WAVE_TASK_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_WAVE_TASK_COMPLETE, handler)
  },

  onBlueprintWaveComplete: (
    cb: (data: { blueprintId: string; workspaceId: string; wave: number; status: string }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        blueprintId: string
        workspaceId: string
        wave: number
        status: string
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_WAVE_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_WAVE_COMPLETE, handler)
  },

  // ── Blueprint Snapshot Sync (M2) ──

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
      pendingApproval: { planSummary: string; completion?: Record<string, unknown>; reviewMarkdown?: string } | null
      wave: { wave: number; taskCount: number; tasks: Record<string, string> } | null
      lastError: string | null
    }) => void
  ): (() => void) => {
    const handler = (_: unknown, data: unknown): void => cb(data as Parameters<typeof cb>[0])
    ipcRenderer.on(IPC_CHANNELS.BLUEPRINT_STATE_SYNC, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BLUEPRINT_STATE_SYNC, handler)
  },

  // ── Blueprint Snapshot Pull (M7) ──

  blueprintGetSnapshot: (args: { workspaceId: string }): Promise<{
    seq: number
    workspaceId: string
    blueprintId: string | null
    running: boolean
    machineState: string
    currentPhase: string | null
    phaseStartedAt: number | null
    clarifyFindings: unknown
    clarifyQuestions: unknown
    pendingApproval: { planSummary: string; completion?: Record<string, unknown>; reviewMarkdown?: string } | null
    wave: { wave: number; taskCount: number; tasks: Record<string, string> } | null
    lastError: string | null
  }> => ipcRenderer.invoke(IPC_CHANNELS.BLUEPRINT_GET_SNAPSHOT, args),

  // ── Council (LLM Council — multi-advisor review) ──

  councilStart: (args: {
    workspaceId: string
    inputType: string
    planContent: string
    structuredPlan?: unknown
    originalUserRequest: string
    workspaceContext?: string
    filesInScope?: string[]
    conversationId?: string
    llmProvider?: LLMProvider
    grillSessionId?: string
  }): Promise<{ sessionId: string }> => ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_START, args),

  councilCancel: (args?: { workspaceId?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_CANCEL, args),

  councilGetSession: (args: { workspaceId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_GET_SESSION, args),

  onCouncilMemberStream: (
    cb: (data: {
      advisorRole: string
      type: string
      content?: string
      toolActivity?: Record<string, unknown>
    }) => void
  ): (() => void) => {
    const handler = (
      _: unknown,
      data: {
        advisorRole: string
        type: string
        content?: string
        toolActivity?: Record<string, unknown>
      }
    ): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.COUNCIL_MEMBER_STREAM, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COUNCIL_MEMBER_STREAM, handler)
  },

  onCouncilMemberComplete: (
    cb: (data: { advisorRole: string; review: unknown }) => void
  ): (() => void) => {
    const handler = (_: unknown, data: { advisorRole: string; review: unknown }): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.COUNCIL_MEMBER_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COUNCIL_MEMBER_COMPLETE, handler)
  },

  onCouncilPeerReviewComplete: (cb: (data: { peerReviews: unknown[] }) => void): (() => void) => {
    const handler = (_: unknown, data: { peerReviews: unknown[] }): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.COUNCIL_PEER_REVIEW_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COUNCIL_PEER_REVIEW_COMPLETE, handler)
  },

  onCouncilVerdict: (cb: (data: { verdict: unknown }) => void): (() => void) => {
    const handler = (_: unknown, data: { verdict: unknown }): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.COUNCIL_VERDICT, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COUNCIL_VERDICT, handler)
  },

  onCouncilPhaseChanged: (
    cb: (data: { workspaceId: string; phase: string }) => void
  ): (() => void) => {
    const handler = (_: unknown, data: { workspaceId: string; phase: string }): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.COUNCIL_PHASE_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COUNCIL_PHASE_CHANGED, handler)
  },

  onCouncilComplete: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on(IPC_CHANNELS.COUNCIL_COMPLETE, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COUNCIL_COMPLETE, handler)
  },

  councilResume: (args: {
    sessionId: string
    workspaceId: string
  }): Promise<{ resumed: boolean }> => ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_RESUME, args),

  councilGetHistory: (args: { workspaceId: string; limit?: number }): Promise<unknown[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_GET_HISTORY, args),

  councilDeleteSession: (args: { sessionId: string }): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_DELETE_SESSION, args),

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
  }): Promise<HandoffRecord> =>
    ipcRenderer.invoke(IPC_CHANNELS.HANDOFF_CREATE, args),

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
  }): Promise<{ record: HandoffRecord; action: unknown }> =>
    ipcRenderer.invoke(IPC_CHANNELS.HANDOFF_EXECUTE, args),

  handoffAccept: (args: {
    handoffId: string
    targetSessionId: string
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.HANDOFF_ACCEPT, args),

  handoffReject: (args: {
    handoffId: string
    reason: string
  }): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.HANDOFF_REJECT, args),

  handoffGetHistory: (args: {
    workspaceId: string
    limit?: number
  }): Promise<HandoffRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.HANDOFF_GET_HISTORY, args),

  handoffGetChain: (args: {
    handoffId: string
  }): Promise<HandoffRecord[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.HANDOFF_GET_CHAIN, args),

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
  }): Promise<{ envelope: unknown; markdown: string; action: unknown }> =>
    ipcRenderer.invoke(IPC_CHANNELS.HANDOFF_PREVIEW, args),

  // ── E2E Testing ──

  testingListScenarios: (): Promise<E2EScenarioSummary[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.TESTING_LIST_SCENARIOS),

  testingPreflight: (args?: { workspaceId?: string }): Promise<E2EPreflightResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.TESTING_PREFLIGHT, args),

  testingRun: (args?: {
    scenarioIds?: string[]
    category?: string
    workspaceId?: string
    forceTools?: boolean
  }): Promise<{ runId: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TESTING_RUN, args),

  testingRequeueFailed: (args: { runId: string; workspaceId?: string }): Promise<{ runId: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TESTING_REQUEUE_FAILED, args),

  testingResumeRun: (args: { runId: string; workspaceId?: string }): Promise<{ runId: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.TESTING_RESUME_RUN, args),

  testingCancel: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.TESTING_CANCEL),

  testingGetRuns: (args?: { workspaceId?: string }): Promise<E2ERunSummary[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.TESTING_GET_RUNS, args),

  testingGetRunResults: (args: { runId: string }): Promise<E2EResultSummary[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.TESTING_GET_RUN_RESULTS, args),

  testingGetResultDetail: (args: { resultId: string }): Promise<E2EResultDetail | undefined> =>
    ipcRenderer.invoke(IPC_CHANNELS.TESTING_GET_RESULT_DETAIL, args),

  onTestingProgress: (
    cb: (data: E2EProgressEvent) => void
  ): (() => void) => {
    const handler = (_: unknown, data: E2EProgressEvent): void => cb(data)
    ipcRenderer.on(IPC_CHANNELS.TESTING_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TESTING_PROGRESS, handler)
  }
} as const

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  throw new Error(
    'Context isolation must be enabled. Code Atelier requires contextIsolation: true for security.'
  )
}
