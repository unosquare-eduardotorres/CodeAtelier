import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'
import type {
  Workspace,
  Conversation,
  ConversationMode,
  Message,
  AgentStatus,
  Specialist,
  Skill,
  WorkspaceClaudeStatus,
  ActivationResult,
  ActivationProgressEvent,
  DiscoveredSkill,
  DiscoveredAgent,
  DecomposedTask,
  ExecutionStrategy,
  TaskPlan,
  TaskExecutionProgress,
  FileChange,
  CompleteResult,
  AgentWorktree,
  MergeAllResult,
  SyncDiff,
  SyncResult,
  Memory,
  MemoryType,
  MemoryFeedProgress,
  MemoryFeedResult,
  WorkspaceFeedTimestamps,
  DreamRun,
  DreamProgress,
  TokenSummary,
  AgentSessionRecord,
  GrillQuestion,
  Idea,
  DocFile,
  RepoInfo,
  UserProfile,
  CoreAgentAlias,
  MarketplaceSpecialist
} from '../shared/types'

const api = {
  // ── Workspace ──
  listWorkspaces: (): Promise<Workspace[]> => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST),

  createWorkspace: (args: { name: string; repoPath: string }): Promise<Workspace> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, args),

  openWorkspace: (args: { id: string }): Promise<Workspace> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_OPEN, args),

  deleteWorkspace: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE, args),

  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY),

  getWorkspaceSettings: (args: { workspaceId: string }): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_SETTINGS, args),

  updateWorkspaceSettings: (args: {
    workspaceId: string
    settings: Record<string, unknown>
  }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE_SETTINGS, args),

  saveClipboardImage: (args: { dataUrl: string }): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE, args),

  // ── Chat ──
  sendMessage: (args: {
    conversationId: string
    text: string
    attachments?: string[]
  }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, args),

  getConversations: (args: { workspaceId: string }): Promise<Conversation[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_CONVERSATIONS, args),

  createConversation: (args: {
    workspaceId: string
    title?: string
    mode?: ConversationMode
  }): Promise<Conversation> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_CREATE_CONVERSATION, args),

  getMessages: (args: { conversationId: string }): Promise<Message[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_MESSAGES, args),

  deleteConversation: (args: { conversationId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_DELETE_CONVERSATION, args),

  updateConversationMode: (args: {
    conversationId: string
    mode: ConversationMode
  }): Promise<Conversation> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_MODE, args),

  renameConversation: (args: { conversationId: string; title: string }): Promise<Conversation> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_RENAME, args),

  stopGeneration: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_STOP),

  compactConversation: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_COMPACT),

  executePlan: (args: {
    conversationId: string
    strategy: ExecutionStrategy
    tasks: DecomposedTask[]
  }): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_EXECUTE_PLAN, args),

  // Chat commands
  completeConversation: (args: {
    conversationId: string
    branchName: string
    commitMessage: string
    description: string
  }): Promise<CompleteResult> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_COMPLETE, args),

  closeConversation: (args: { conversationId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_CLOSE, args),

  getFileChanges: (args: { conversationId: string }): Promise<FileChange[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_FILE_CHANGES, args),

  generatePrDescription: (args: { conversationId: string }): Promise<{ description: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_GENERATE_PR_DESCRIPTION, args),

  // ── Agents ──
  getAgentStatuses: (): Promise<AgentStatus[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_STATUSES),

  stopAllAgents: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STOP_ALL),

  // ── Orchestrator ──
  startOrchestrator: (workspacePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATOR_START, workspacePath),

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

  // ── Specialist Marketplace ──
  deploySpecialist: (args: { workspacePath: string; specialistId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_DEPLOY, args),

  undeploySpecialist: (args: { workspacePath: string; specialistId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_UNDEPLOY, args),

  updateSpecialistConfig: (args: {
    id: string
    displayName?: string
    icon?: string
    color?: string
    alias?: string | null
    avatarUrl?: string | null
    priority?: number
  }): Promise<Specialist> => ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_UPDATE_CONFIG, args),

  getMarketplace: (args: { workspacePath: string }): Promise<MarketplaceSpecialist[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_GET_MARKETPLACE, args),

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

  // ── Worktrees ──
  listWorktrees: (args: { conversationId: string }): Promise<AgentWorktree[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_LIST, args),

  getWorktreeDiff: (args: { worktreeId: string }): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_GET_DIFF, args),

  mergeWorktree: (args: {
    worktreeId: string
  }): Promise<{ success: boolean; conflictedFiles?: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_MERGE, args),

  mergeAllWorktrees: (args: { conversationId: string }): Promise<MergeAllResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_MERGE_ALL, args),

  abandonWorktree: (args: { worktreeId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_ABANDON, args),

  // ── Pixel Office ──
  popoutPixelOffice: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.PIXEL_OFFICE_POPOUT),

  // ── Agent Sync ──
  computeSyncDiff: (args: { workspacePath: string }): Promise<SyncDiff> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYNC_COMPUTE_DIFF, args),

  applySync: (args: { workspacePath: string; skipRemoved?: boolean }): Promise<SyncResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYNC_APPLY, args),

  // ── Memory (auto memory system) ──
  listMemories: (args: { workspaceId: string }): Promise<Memory[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LIST, args),

  searchMemories: (args: { workspaceId: string; query: string }): Promise<Memory[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SEARCH, args),

  createMemory: (args: {
    workspaceId: string | null
    type: MemoryType
    title: string
    content: string
    tags?: string[]
    importance?: number
  }): Promise<Memory> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CREATE, args),

  updateMemory: (args: {
    id: string
    title?: string
    content?: string
    tags?: string[]
    importance?: number
  }): Promise<Memory> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_UPDATE, args),

  deleteMemory: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE, args),

  memoryUpdateSetting: (args: { workspaceId: string; memoryEnabled: boolean }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_UPDATE_SETTING, args),

  // ── Memory Feed ──
  memorySelectDocument: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SELECT_DOCUMENT),

  memoryFeedCancel: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEED_CANCEL),

  memoryGetFeedTimestamps: (args: { workspaceId: string }): Promise<WorkspaceFeedTimestamps> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_FEED_TIMESTAMPS, args),

  memoryFeedClaudeMd: (args: { workspacePath: string }): Promise<MemoryFeedResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEED_CLAUDE_MD, args),

  memoryRegenerateClaudeMd: (args: {
    workspacePath: string
  }): Promise<{ success: boolean; content: string; existing: string | null; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REGENERATE_CLAUDE_MD, args),

  memoryFeedCodebase: (args: { workspacePath: string }): Promise<MemoryFeedResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEED_CODEBASE, args),

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

  // ── Dream (auto consolidation) ──
  triggerDream: (args: { workspaceId: string }): Promise<DreamRun> =>
    ipcRenderer.invoke(IPC_CHANNELS.DREAM_TRIGGER, args),

  cancelDream: (args: { workspaceId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.DREAM_CANCEL, args),

  getDreamStatus: (args: { workspaceId: string }): Promise<DreamRun | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DREAM_GET_STATUS, args),

  getDreamHistory: (args: { workspaceId: string; limit?: number }): Promise<DreamRun[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.DREAM_GET_HISTORY, args),

  onDreamProgress: (callback: (data: DreamProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: DreamProgress): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.DREAM_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.DREAM_PROGRESS, handler)
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
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        conversationId: string
        chunk: string
        role: string
        toolActivity?: {
          id: string
          toolName: string
          status: 'running' | 'completed' | 'error'
          startedAt?: number
          completedAt?: number
        }
        compactNeeded?: {
          level: string
          inputTokens: number
        }
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, handler)
    }
  },

  onMessageComplete: (
    callback: (data: { conversationId: string; messageId: string }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { conversationId: string; messageId: string }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_MESSAGE_COMPLETE, handler)
    }
  },

  onHandoff: (
    callback: (data: {
      conversationId: string
      summary: string
      specialists: string[]
      mode: string
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        conversationId: string
        summary: string
        specialists: string[]
        mode: string
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_HANDOFF, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_HANDOFF, handler)
    }
  },

  onGrillComplete: (
    callback: (data: {
      conversationId: string
      summary: string
      proposedTasks: Array<{ title: string; description: string }>
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        conversationId: string
        summary: string
        proposedTasks: Array<{ title: string; description: string }>
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_GRILL_COMPLETE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_GRILL_COMPLETE, handler)
    }
  },

  onGrillQuestion: (
    callback: (data: { conversationId: string; questions: GrillQuestion[] }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { conversationId: string; questions: GrillQuestion[] }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_GRILL_QUESTION, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_GRILL_QUESTION, handler)
    }
  },

  onGrillEvaluation: (
    callback: (data: {
      conversationId: string
      score: number
      scoreLabel: string
      feedback: string
      questions: GrillQuestion[]
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        conversationId: string
        score: number
        scoreLabel: string
        feedback: string
        questions: GrillQuestion[]
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_GRILL_EVALUATION, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_GRILL_EVALUATION, handler)
    }
  },

  onTaskPlan: (callback: (data: TaskPlan) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: TaskPlan): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_TASK_PLAN, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_TASK_PLAN, handler)
    }
  },

  onTaskProgress: (callback: (data: TaskExecutionProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: TaskExecutionProgress): void =>
      callback(data)
    ipcRenderer.on(IPC_CHANNELS.CHAT_TASK_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.CHAT_TASK_PROGRESS, handler)
    }
  },

  onOrchestratorReady: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC_CHANNELS.ORCHESTRATOR_READY, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ORCHESTRATOR_READY, handler)
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
  saveGitHubToken: (args: { workspaceId: string; token: string }): Promise<{ login: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GITHUB_SAVE_TOKEN, args),

  validateGitHubToken: (args: {
    token: string
  }): Promise<{ valid: boolean; login: string; scopes: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.GITHUB_VALIDATE_TOKEN, args),

  getGitHubStatus: (args: {
    workspaceId: string
  }): Promise<{ configured: boolean; login?: string }> =>
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

  hasUnsavedChanges: (args: {
    conversationId: string
  }): Promise<{ hasChanges: boolean; fileCount: number; files: string[] }> =>
    ipcRenderer.invoke(IPC_CHANNELS.REPO_HAS_UNSAVED_CHANGES, args),

  // ── User Profile ──
  getUserProfile: (): Promise<UserProfile | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.USER_PROFILE_GET),

  upsertUserProfile: (args: { displayName: string; avatarKey: string }): Promise<UserProfile> =>
    ipcRenderer.invoke(IPC_CHANNELS.USER_PROFILE_UPSERT, args),

  // ── Core Agent Aliases ──
  listCoreAgentAliases: (): Promise<CoreAgentAlias[]> =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_AGENT_LIST),

  upsertCoreAgentAlias: (args: {
    agentRole: 'generalist' | 'coordinator'
    alias: string | null
    avatarKey: string | null
  }): Promise<CoreAgentAlias> => ipcRenderer.invoke(IPC_CHANNELS.CORE_AGENT_UPSERT, args),

  // ── Renderer Logging Bridge ──
  log: (args: {
    level: 'error' | 'warn' | 'info' | 'debug'
    message: string
    data?: unknown[]
  }): void => {
    ipcRenderer.invoke(IPC_CHANNELS.LOG_FROM_RENDERER, args).catch(() => {
      // Fallback silently — IPC may not be ready during early startup
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

  // ── Checkpoints ──
  listCheckpoints: (args: { conversationId: string }): Promise<
    { id: string; label: string; gitBranch?: string; gitCommitSha?: string; createdAt: string }[]
  > => ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_LIST, args),

  restoreCheckpoint: (args: {
    checkpointId: string
  }): Promise<{ success: boolean; message: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECKPOINT_RESTORE, args),

  // ── Cost Tracking ──
  getCostSummary: (args: { workspaceId: string }): Promise<{
    totalCostCents: number
    totalTokens: number
    sessionCount: number
    byAgent: { agentType: string; costCents: number; tokens: number; sessions: number }[]
  }> => ipcRenderer.invoke(IPC_CHANNELS.COST_GET_WORKSPACE_SUMMARY, args),

  checkBudget: (args: { workspaceId: string }): Promise<{
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
    callback: (data: {
      workspaceId: string
      currentCostCents: number
      budgetCents: number
    }) => void
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

  // ── Events (audit log) ──
  getRecentEvents: (args?: { limit?: number }): Promise<
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

  // ── Gate Results ──
  getGateResults: (args: { conversationId: string }): Promise<
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
  > => ipcRenderer.invoke(IPC_CHANNELS.GATE_RESULTS_GET, args),

  // ── Agent Events (from specialist pool) ──
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

  onGateFailure: (
    callback: (data: {
      taskId: string
      specialist: string
      gate: { type: string; passed: boolean; summary: string }
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        taskId: string
        specialist: string
        gate: { type: string; passed: boolean; summary: string }
      }
    ): void => callback(data)
    ipcRenderer.on(IPC_CHANNELS.AGENT_GATE_FAILURE, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.AGENT_GATE_FAILURE, handler)
    }
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
