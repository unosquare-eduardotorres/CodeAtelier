import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type {
  DiscoveredAgent,
  DiscoveredSkill,
  WorkspaceClaudeStatus,
  ActivationResult,
  SyncDiff,
  SyncResult
} from '../../../shared/types'

interface SettingsState {
  // Workspace deployment status
  claudeStatus: WorkspaceClaudeStatus | null
  isScanning: boolean
  isActivating: boolean
  activationError: string | null
  activationResult: ActivationResult | null
  activationLog: string[]

  // CLAUDE.md preview
  pendingClaudeMd: {
    existing: string | null
    proposed: string
  } | null
  isConfirmingClaudeMd: boolean

  // Discovered agents (from workspace's .claude/agents/)
  agents: DiscoveredAgent[]
  selectedAgent: DiscoveredAgent | null

  // Discovered skills (from workspace's .claude/skills/)
  skills: DiscoveredSkill[]
  selectedSkill: DiscoveredSkill | null

  // YAML ↔ DB Sync
  syncDiff: SyncDiff | null
  isSyncing: boolean
  syncError: string | null
  lastSyncResult: SyncResult | null

  // File content for viewer/editor
  activeFileContent: string | null
  activeFilePath: string | null
  isFileLoading: boolean
  isFileSaving: boolean

  // Actions
  scanWorkspace: (workspacePath: string) => Promise<void>
  activateWorkspace: (workspacePath: string) => Promise<ActivationResult>
  cancelActivation: () => Promise<void>
  confirmClaudeMd: (workspacePath: string, content: string) => Promise<void>
  dismissClaudeMdPreview: () => void
  loadAgents: (workspacePath: string) => Promise<void>
  loadSkills: (workspacePath: string) => Promise<void>
  selectAgent: (agent: DiscoveredAgent | null) => void
  selectSkill: (skill: DiscoveredSkill | null) => void
  readFile: (filePath: string) => Promise<void>
  saveFile: (filePath: string, content: string) => Promise<void>
  computeSyncDiff: (workspacePath: string) => Promise<void>
  applySync: (
    workspacePath: string,
    options?: { skipRemoved?: boolean }
  ) => Promise<SyncResult | null>
  cleanAndReactivate: (workspacePath: string) => Promise<void>
  deployAll: (workspacePath: string) => Promise<{ agents: number; skills: number } | null>
  deleteAllAgents: (workspacePath: string) => Promise<void>
  deleteAllSkills: (workspacePath: string) => Promise<void>
  dismissSync: () => void
  reset: () => void
}

const initialState = {
  claudeStatus: null,
  isScanning: false,
  isActivating: false,
  activationError: null,
  activationResult: null,
  activationLog: [],
  pendingClaudeMd: null,
  isConfirmingClaudeMd: false,
  agents: [],
  selectedAgent: null,
  skills: [],
  selectedSkill: null,
  syncDiff: null,
  isSyncing: false,
  syncError: null,
  lastSyncResult: null,
  activeFileContent: null,
  activeFilePath: null,
  isFileLoading: false,
  isFileSaving: false
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...initialState,

  scanWorkspace: async (workspacePath: string) => {
    set({ isScanning: true })
    try {
      const status = await window.api.scanWorkspaceClaude({
        workspacePath
      })
      set({ claudeStatus: status, isScanning: false })
    } catch (error) {
      rendererLog.error('Failed to scan workspace:', error)
      set({ isScanning: false })
    }
  },

  activateWorkspace: async (workspacePath: string) => {
    set({ isActivating: true, activationError: null, activationLog: [] })

    // Subscribe to progress events from main process
    const unsub = window.api.onActivationProgress((event) => {
      set((state) => ({
        activationLog: [...state.activationLog, `[${event.type}] ${event.message}`]
      }))
    })

    try {
      const result = await window.api.activateAgents({
        workspacePath
      })

      if (!result.success) {
        set({
          isActivating: false,
          activationError: result.error ?? 'Activation failed'
        })
        return result
      }

      set({ isActivating: false, activationResult: result })

      // Store pending CLAUDE.md for user review
      if (result.proposedClaudeMd) {
        set({
          pendingClaudeMd: {
            existing: result.existingClaudeMd ?? null,
            proposed: result.proposedClaudeMd
          }
        })
      }

      // Refresh scan and lists after activation
      const status = await window.api.scanWorkspaceClaude({
        workspacePath
      })
      const agents = await window.api.scanWorkspaceAgents({
        workspacePath
      })
      const skills = await window.api.scanWorkspaceSkills({
        workspacePath
      })

      set({ claudeStatus: status, agents, skills })
      return result
    } catch (error) {
      const message = (error as Error).message
      set({ isActivating: false, activationError: message })
      return {
        success: false,
        selectedAgents: [],
        selectedSkills: [],
        error: message,
        existingClaudeMd: null,
        proposedClaudeMd: null,
        claudeMdWritten: false
      }
    } finally {
      unsub()
    }
  },

  cancelActivation: async () => {
    await window.api.cancelActivation()
    set({ isActivating: false, activationError: 'Cancelled by user', activationLog: [] })
  },

  confirmClaudeMd: async (workspacePath: string, content: string) => {
    set({ isConfirmingClaudeMd: true })
    try {
      await window.api.confirmClaudeMd({ workspacePath, content })
      set({ pendingClaudeMd: null, isConfirmingClaudeMd: false })
      // Refresh scan to reflect the new CLAUDE.md
      const status = await window.api.scanWorkspaceClaude({
        workspacePath
      })
      set({ claudeStatus: status })
    } catch (error) {
      rendererLog.error('Failed to confirm CLAUDE.md:', error)
      set({ isConfirmingClaudeMd: false })
    }
  },

  dismissClaudeMdPreview: () => {
    set({ pendingClaudeMd: null })
  },

  loadAgents: async (workspacePath: string) => {
    try {
      const agents = await window.api.scanWorkspaceAgents({
        workspacePath
      })
      set({ agents })
    } catch (error) {
      rendererLog.error('Failed to load agents:', error)
    }
  },

  loadSkills: async (workspacePath: string) => {
    try {
      const skills = await window.api.scanWorkspaceSkills({
        workspacePath
      })
      set({ skills })
    } catch (error) {
      rendererLog.error('Failed to load skills:', error)
    }
  },

  selectAgent: (agent: DiscoveredAgent | null) => {
    set({ selectedAgent: agent })
  },

  selectSkill: (skill: DiscoveredSkill | null) => {
    set({ selectedSkill: skill })
  },

  readFile: async (filePath: string) => {
    set({ isFileLoading: true, activeFilePath: filePath })
    try {
      const content = await window.api.readWorkspaceFile({ filePath })
      set({ activeFileContent: content, isFileLoading: false })
    } catch (error) {
      rendererLog.error('Failed to read file:', error)
      set({
        activeFileContent: null,
        isFileLoading: false
      })
    }
  },

  saveFile: async (filePath: string, content: string) => {
    set({ isFileSaving: true })
    try {
      await window.api.writeWorkspaceFile({ filePath, content })
      set({ activeFileContent: content, isFileSaving: false })
    } catch (error) {
      rendererLog.error('Failed to save file:', error)
      set({ isFileSaving: false })
      throw error
    }
  },

  computeSyncDiff: async (workspacePath: string) => {
    try {
      const diff = await window.api.computeSyncDiff({ workspacePath })
      set({ syncDiff: diff, syncError: null })
    } catch (error) {
      rendererLog.error('Failed to compute sync diff:', error)
      set({ syncError: (error as Error).message })
    }
  },

  applySync: async (workspacePath: string, options?: { skipRemoved?: boolean }) => {
    set({ isSyncing: true, syncError: null })
    try {
      const result = await window.api.applySync({
        workspacePath,
        skipRemoved: options?.skipRemoved
      })
      set({ isSyncing: false, lastSyncResult: result, syncDiff: null })

      // Re-compute diff to reflect new state
      const diff = await window.api.computeSyncDiff({ workspacePath })
      set({ syncDiff: diff })

      return result
    } catch (error) {
      rendererLog.error('Failed to apply sync:', error)
      set({ isSyncing: false, syncError: (error as Error).message })
      return null
    }
  },

  cleanAndReactivate: async (workspacePath: string) => {
    // Step 1: Clean existing deployment
    await window.api.cleanActivation({ workspacePath })

    // Step 2: Refresh scan (will now show needsActivation = true)
    const status = await window.api.scanWorkspaceClaude({
      workspacePath
    })
    set({
      claudeStatus: status,
      agents: [],
      skills: [],
      activationResult: null,
      activationError: null,
      activationLog: [],
      pendingClaudeMd: null
    })

    // Step 3: Immediately trigger re-activation
    const { activateWorkspace } = useSettingsStore.getState()
    await activateWorkspace(workspacePath)
  },

  deployAll: async (workspacePath: string) => {
    set({ isActivating: true, activationError: null })
    try {
      const result = await window.api.deployAll({ workspacePath })

      // Refresh scan and lists after deploy
      const status = await window.api.scanWorkspaceClaude({ workspacePath })
      const agents = await window.api.scanWorkspaceAgents({ workspacePath })
      const skills = await window.api.scanWorkspaceSkills({ workspacePath })

      set({ claudeStatus: status, agents, skills, isActivating: false })
      return result
    } catch (error) {
      const message = (error as Error).message
      set({ isActivating: false, activationError: message })
      return null
    }
  },

  deleteAllAgents: async (workspacePath: string) => {
    try {
      await window.api.deleteAllAgents({ workspacePath })
      // Refresh
      const status = await window.api.scanWorkspaceClaude({ workspacePath })
      const agents = await window.api.scanWorkspaceAgents({ workspacePath })
      set({ claudeStatus: status, agents })
    } catch (error) {
      rendererLog.error('Failed to delete all agents:', error)
    }
  },

  deleteAllSkills: async (workspacePath: string) => {
    try {
      await window.api.deleteAllSkills({ workspacePath })
      // Refresh
      const status = await window.api.scanWorkspaceClaude({ workspacePath })
      const skills = await window.api.scanWorkspaceSkills({ workspacePath })
      set({ claudeStatus: status, skills })
    } catch (error) {
      rendererLog.error('Failed to delete all skills:', error)
    }
  },

  dismissSync: () => {
    set({ syncDiff: null, syncError: null, lastSyncResult: null })
  },

  reset: () => {
    set(initialState)
  }
}))
