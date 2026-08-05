/**
 * project-specialist.store — renderer state for the per-workspace Project
 * Specialist (Phase 2 of the refactor).
 */
import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'

export interface SpecialistSkillSummary {
  id: string
  name: string
  description: string | null
  filename: string
  isEnabled: boolean
}

export interface SkillRecommendation {
  skillId: string
  relevance: number
  rationale: string
}

/** Which build path produced the persisted prompt (specialists.build_method). */
export type SpecialistBuildMethod = 'agentic' | 'oneshot' | 'skeleton'

/** Live knowledge-bootstrap state for the workspace. */
export interface SpecialistIngestionState {
  /** True when the latest run completed AND produced facts. */
  satisfied: boolean
  status: string | null
  factsCreated: number
  finishedAt: string | null
}

export interface ProjectSpecialist {
  id: string
  workspaceId: string
  agentId: string
  displayName: string
  icon: string
  color: string
  prompt: string
  buildStatus: 'pending' | 'building' | 'ready' | 'failed'
  stackFingerprint: string | null
  detectedTechs: string[]
  lastBuiltAt: string | null
  /**
   * How the prompt was produced. `null` on rows built before provenance was
   * recorded; `'skeleton'` means tailoring degraded to the generic template.
   */
  buildMethod: SpecialistBuildMethod | null
  /** The bootstrap run that informed the last build, if any. */
  ingestionRunId: string | null
  /** Live ingestion state — null when it could not be read. */
  ingestion: SpecialistIngestionState | null
  createdAt: string
  updatedAt: string
  /** Skills attached to this specialist (with per-specialist is_enabled state). */
  skills?: SpecialistSkillSummary[]
  /** Haiku-generated skill recommendations for this project. */
  skillRecommendations: SkillRecommendation[] | null
}

export interface BuildProgressEvent {
  specialistId: string
  phase: string
  message: string
  at: string
}

export interface DriftReport {
  specialistId: string
  workspaceId: string
  oldFingerprint: string | null
  newFingerprint: string
  added: string[]
  removed: string[]
  drifted: boolean
}

interface ProjectSpecialistState {
  /** Workspace ID → Project Specialist cache. */
  byWorkspace: Record<string, ProjectSpecialist | null>
  /** Workspace ID → drift report. */
  driftByWorkspace: Record<string, DriftReport | null>
  /** Most recent build progress event per specialist. */
  buildProgress: Record<string, BuildProgressEvent | null>
  isLoading: boolean
  error: string | null

  loadForWorkspace: (workspaceId: string) => Promise<void>
  build: (workspaceId: string) => Promise<void>
  rebuildPrompt: (specialistId: string) => Promise<void>
  rebuildSkills: (specialistId: string) => Promise<void>
  updatePrompt: (specialistId: string, prompt: string) => Promise<void>
  toggleSkill: (specialistId: string, skillId: string, enabled: boolean) => Promise<void>
  attachSkill: (specialistId: string, skillId: string) => Promise<void>
  detachSkill: (specialistId: string, skillId: string) => Promise<void>
  checkDrift: (workspaceId: string) => Promise<void>
  refreshRecommendations: (specialistId: string) => Promise<void>
  clearError: () => void
}

export const useProjectSpecialistStore = create<ProjectSpecialistState>((set, get) => ({
  byWorkspace: {},
  driftByWorkspace: {},
  buildProgress: {},
  isLoading: false,
  error: null,

  loadForWorkspace: async (workspaceId) => {
    set({ isLoading: true, error: null })
    try {
      const raw = (await window.api.getProjectSpecialist({
        workspaceId
      })) as ProjectSpecialist | null
      set((state) => ({
        byWorkspace: { ...state.byWorkspace, [workspaceId]: raw },
        isLoading: false
      }))
    } catch (error) {
      rendererLog.error('Failed to load Project Specialist:', error)
      set({ isLoading: false, error: (error as Error).message })
    }
  },

  build: async (workspaceId) => {
    const previous = get().byWorkspace[workspaceId]
    // Optimistic: flip to 'building' so any UI keyed on buildStatus
    // (modal, WorkspaceCard chip) reacts the instant the user clicks.
    if (previous) {
      set((state) => ({
        byWorkspace: {
          ...state.byWorkspace,
          [workspaceId]: { ...previous, buildStatus: 'building' }
        },
        isLoading: true,
        error: null
      }))
    } else {
      set({ isLoading: true, error: null })
    }
    try {
      await window.api.buildProjectSpecialist({ workspaceId })
      await get().loadForWorkspace(workspaceId)
      set({ isLoading: false })
    } catch (error) {
      rendererLog.error('Project Specialist build failed:', error)
      // Revert the optimistic update by reloading authoritative state.
      await get()
        .loadForWorkspace(workspaceId)
        .catch((err) => console.warn('[ProjectSpecialist] Non-fatal: revert reload failed:', err))
      set({ isLoading: false, error: (error as Error).message })
      throw error
    }
  },

  rebuildPrompt: async (specialistId) => {
    set({ error: null })
    try {
      await window.api.rebuildProjectSpecialistPrompt({ specialistId })
      // Reload every cached workspace row touching this specialist id.
      const entries = Object.entries(get().byWorkspace)
      for (const [wsId, row] of entries) {
        if (row?.id === specialistId) await get().loadForWorkspace(wsId)
      }
    } catch (error) {
      rendererLog.error('Rebuild prompt failed:', error)
      set({ error: (error as Error).message })
      throw error
    }
  },

  rebuildSkills: async (specialistId) => {
    set({ error: null })
    try {
      await window.api.rebuildProjectSpecialistSkills({ specialistId })
      const entries = Object.entries(get().byWorkspace)
      for (const [wsId, row] of entries) {
        if (row?.id === specialistId) await get().loadForWorkspace(wsId)
      }
    } catch (error) {
      rendererLog.error('Rebuild skills failed:', error)
      set({ error: (error as Error).message })
      throw error
    }
  },

  updatePrompt: async (specialistId, prompt) => {
    set({ error: null })
    try {
      await window.api.updateProjectSpecialistPrompt({ specialistId, prompt })
      const entries = Object.entries(get().byWorkspace)
      for (const [wsId, row] of entries) {
        if (row?.id === specialistId) {
          set((state) => ({
            byWorkspace: {
              ...state.byWorkspace,
              [wsId]: row ? { ...row, prompt } : row
            }
          }))
        }
      }
    } catch (error) {
      rendererLog.error('Update prompt failed:', error)
      set({ error: (error as Error).message })
      throw error
    }
  },

  toggleSkill: async (specialistId, skillId, enabled) => {
    try {
      await window.api.toggleProjectSpecialistSkill({ specialistId, skillId, enabled })
    } catch (error) {
      rendererLog.error('Toggle skill failed:', error)
      throw error
    }
  },

  attachSkill: async (specialistId, skillId) => {
    try {
      await window.api.attachProjectSpecialistSkill({ specialistId, skillId })
    } catch (error) {
      rendererLog.error('Attach skill failed:', error)
      throw error
    }
  },

  detachSkill: async (specialistId, skillId) => {
    try {
      await window.api.detachProjectSpecialistSkill({ specialistId, skillId })
    } catch (error) {
      rendererLog.error('Detach skill failed:', error)
      throw error
    }
  },

  checkDrift: async (workspaceId) => {
    try {
      const report = (await window.api.getProjectSpecialistDrift({
        workspaceId
      })) as DriftReport | null
      set((state) => ({
        driftByWorkspace: { ...state.driftByWorkspace, [workspaceId]: report }
      }))
    } catch (error) {
      rendererLog.error('Drift check failed:', error)
    }
  },

  refreshRecommendations: async (specialistId) => {
    set({ error: null })
    try {
      await window.api.refreshProjectSpecialistRecommendations({ specialistId })
      // Reload to pick up updated recommendations
      const entries = Object.entries(get().byWorkspace)
      for (const [wsId, row] of entries) {
        if (row?.id === specialistId) await get().loadForWorkspace(wsId)
      }
    } catch (error) {
      rendererLog.error('Refresh recommendations failed:', error)
      set({ error: (error as Error).message })
      throw error
    }
  },

  clearError: () => set({ error: null })
}))

// Wire build-progress events into the store.
if (typeof window !== 'undefined' && window.api?.onProjectSpecialistBuildProgress) {
  window.api.onProjectSpecialistBuildProgress((event) => {
    useProjectSpecialistStore.setState((state) => ({
      buildProgress: {
        ...state.buildProgress,
        [event.specialistId]: event
      }
    }))
  })
}
