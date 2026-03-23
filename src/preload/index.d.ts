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
  FileChange,
  CompleteResult,
  AgentWorktree,
  MergeAllResult,
  GrillProposedTask,
  BrainEntry,
  BrainFileInfo,
  BrainStatus,
  BrainFeedProgress,
  BrainFeedResult,
  TokenSummary,
  AgentSessionRecord,
  Idea
} from '../shared/types'

interface Api {
  // Workspace
  listWorkspaces: () => Promise<Workspace[]>
  createWorkspace: (args: { name: string; repoPath: string }) => Promise<Workspace>
  openWorkspace: (args: { id: string }) => Promise<Workspace>
  deleteWorkspace: (args: { id: string }) => Promise<void>
  selectDirectory: () => Promise<string | null>
  saveClipboardImage: (args: { dataUrl: string }) => Promise<string>

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

  // Chat commands
  completeConversation: (args: {
    conversationId: string
    commitMessage: string
    description: string
  }) => Promise<CompleteResult>
  closeConversation: (args: { conversationId: string }) => Promise<void>
  getFileChanges: (args: { conversationId: string }) => Promise<FileChange[]>

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

  // Brain (project memory)
  brainGetContext: (args: { workspacePath: string }) => Promise<string>
  brainGetState: (args: { workspacePath: string }) => Promise<string>
  brainLogDecision: (args: { workspacePath: string; entry: BrainEntry }) => Promise<void>
  brainGetFilesInfo: (args: { workspacePath: string }) => Promise<BrainStatus>
  brainCompactFile: (args: { workspacePath: string; fileName: string }) => Promise<BrainFileInfo>
  brainCompactAll: (args: { workspacePath: string }) => Promise<BrainStatus>
  brainUpdateSetting: (args: { workspaceId: string; brainEnabled: boolean }) => Promise<void>

  // Brain Feed
  brainSelectDocument: () => Promise<string | null>
  brainFeedClaudeMd: (args: { workspacePath: string }) => Promise<BrainFeedResult>
  brainFeedCodebase: (args: { workspacePath: string }) => Promise<BrainFeedResult>
  brainFeedDocument: (args: { workspacePath: string; filePath: string }) => Promise<BrainFeedResult>
  onBrainFeedProgress: (callback: (data: BrainFeedProgress) => void) => () => void

  computeSyncDiff: (args: { workspacePath: string }) => Promise<SyncDiff>
  applySync: (args: { workspacePath: string; skipRemoved?: boolean }) => Promise<SyncResult>

  // Tokens
  getWorkspaceTokenSummary: (args: { workspaceId: string }) => Promise<TokenSummary>
  getConversationTokenSummary: (args: { conversationId: string }) => Promise<TokenSummary>
  getRecentSessions: (args: { workspaceId: string; limit?: number }) => Promise<AgentSessionRecord[]>

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
    callback: (data: { conversationId: string; messageId: string }) => void
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
  onTaskPlan: (callback: (data: TaskPlan) => void) => () => void
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
}

declare global {
  interface Window {
    api: Api
  }
}
