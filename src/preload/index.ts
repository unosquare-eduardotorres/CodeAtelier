import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/constants'

const api = {
  // ── Workspace ──
  listWorkspaces: (): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST),

  createWorkspace: (args: { name: string; repoPath: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, args),

  openWorkspace: (args: { id: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_OPEN, args),

  deleteWorkspace: (args: { id: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE, args),

  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY),

  saveClipboardImage: (args: { dataUrl: string }): Promise<string> =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE, args),

  // ── Chat ──
  sendMessage: (args: {
    conversationId: string
    text: string
    attachments?: string[]
  }): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, args),

  getConversations: (args: { workspaceId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_CONVERSATIONS, args),

  createConversation: (args: { workspaceId: string; title?: string; mode?: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_CREATE_CONVERSATION, args),

  getMessages: (args: { conversationId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_GET_MESSAGES, args),

  deleteConversation: (args: { conversationId: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_DELETE_CONVERSATION, args),

  updateConversationMode: (args: { conversationId: string; mode: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_UPDATE_MODE, args),

  renameConversation: (args: { conversationId: string; title: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHAT_RENAME, args),

  stopGeneration: (): Promise<void> => ipcRenderer.invoke(IPC_CHANNELS.CHAT_STOP),

  // ── Agents ──
  getAgentStatuses: (): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_STATUSES),

  stopAllAgents: (): Promise<string[]> => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STOP_ALL),

  // ── Orchestrator ──
  startOrchestrator: (workspacePath: string): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.ORCHESTRATOR_START, workspacePath),

  // ── Specialists ──
  listSpecialists: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_LIST),

  getSpecialist: (args: { id: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_GET, args),

  createSpecialist: (args: {
    agentId: string
    displayName: string
    icon?: string
    color?: string
    prompt?: string
    priority?: number
  }): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_CREATE, args),

  updateSpecialist: (args: {
    id: string
    displayName?: string
    icon?: string
    color?: string
    prompt?: string
    priority?: number
    isActive?: boolean
  }): Promise<unknown> => ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_UPDATE, args),

  deleteSpecialist: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_DELETE, args),

  assignSkillToSpecialist: (args: { specialistId: string; skillId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_ASSIGN_SKILL, args),

  removeSkillFromSpecialist: (args: { specialistId: string; skillId: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_REMOVE_SKILL, args),

  // ── Skills ──
  listSkills: (): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST),

  importSkill: (args: { filePath: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_IMPORT, args),

  updateSkill: (args: { id: string; name?: string; description?: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_UPDATE, args),

  deleteSkill: (args: { id: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_DELETE, args),

  activateSkill: (args: { id: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_ACTIVATE, args),

  deactivateSkill: (args: { id: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_DEACTIVATE, args),

  selectSkillFile: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_SELECT_FILE),

  // ── Workspace Deploy ──
  scanWorkspaceClaude: (args: { workspacePath: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SCAN_CLAUDE, args),

  activateAgents: (args: { workspacePath: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ACTIVATE_AGENTS, args),

  readWorkspaceFile: (args: { filePath: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_READ_FILE, args),

  writeWorkspaceFile: (args: { filePath: string; content: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_WRITE_FILE, args),

  scanWorkspaceSkills: (args: { workspacePath: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SCAN_SKILLS, args),

  scanWorkspaceAgents: (args: { workspacePath: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SCAN_AGENTS, args),

  confirmClaudeMd: (args: { workspacePath: string; content: string }): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CONFIRM_CLAUDE_MD, args),

  cancelActivation: (): Promise<void> =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CANCEL_ACTIVATION),

  // ── Agent Sync ──
  computeSyncDiff: (args: { workspacePath: string }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYNC_COMPUTE_DIFF, args),

  applySync: (args: { workspacePath: string; skipRemoved?: boolean }): Promise<unknown> =>
    ipcRenderer.invoke(IPC_CHANNELS.SYNC_APPLY, args),

  // ── Events (main → renderer) with cleanup ──
  onActivationProgress: (
    callback: (data: {
      type: 'status' | 'stderr' | 'error'
      message: string
      timestamp: number
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        type: 'status' | 'stderr' | 'error'
        message: string
        timestamp: number
      }
    ): void => callback(data)
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
        startedAt?: number
        completedAt?: number
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

  onOrchestratorReady: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC_CHANNELS.ORCHESTRATOR_READY, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ORCHESTRATOR_READY, handler)
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
  }
} as const

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
