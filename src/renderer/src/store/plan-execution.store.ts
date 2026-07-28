/**
 * plan-execution.store — Zustand store for live plan execution phase tracking.
 *
 * Tracks which phase of a structured plan is currently in progress,
 * enabling the PlanProgressBar and TaskPlanCard live badges.
 *
 * Primary signal: emit_phase_progress MCP tool (agent-driven)
 * Fallback signal: file-based inference from tool activity
 */

import { create } from 'zustand'

export interface PhaseStatus {
  phaseId: number
  phaseTitle: string
  status: 'pending' | 'started' | 'in_progress' | 'completed' | 'failed' | 'skipped'
  startedAt?: number
  completedAt?: number
  message?: string
  /** Files the agent has touched within this phase (populated via tool activity inference) */
  touchedFiles: string[]
}

export interface PlanExecution {
  planId: string | null
  planTitle: string
  totalPhases: number
  phases: PhaseStatus[]
  /** File-to-phase mappings for fallback inference */
  phaseFiles?: Record<number, string[]>
  conversationId: string
  startedAt: number
}

interface PlanExecutionState {
  /** Active execution per conversation */
  executions: Record<string, PlanExecution>

  /** Initialize an execution when "Build Now" is clicked */
  startExecution: (
    conversationId: string,
    plan: {
      planId: string | null
      title: string
      phases: Array<{ id: number; title: string }>
      phaseFiles?: Record<number, string[]>
    }
  ) => void

  /** Update a phase status (from phaseProgress stream chunk) */
  updatePhase: (
    conversationId: string,
    update: {
      phaseId: number
      phaseTitle: string
      status: PhaseStatus['status']
      totalPhases: number
      message?: string
    }
  ) => void

  /** Infer phase progress from file activity (fallback) */
  inferPhaseFromFile: (conversationId: string, filePath: string) => void

  /** Mark a specific file as touched within its phase (from write/edit tool activity) */
  markFileTouched: (conversationId: string, filePath: string) => void

  /** Clear execution state */
  clearExecution: (conversationId: string) => void
}

// Preserve Zustand state across HMR (dev only)
const previousState = import.meta.hot?.data?.planExecStoreState as
  | Partial<PlanExecutionState>
  | undefined

export const usePlanExecutionStore = create<PlanExecutionState>((set) => ({
  executions: previousState?.executions ?? {},

  startExecution: (conversationId, plan) => {
    set((state) => ({
      executions: {
        ...state.executions,
        [conversationId]: {
          planId: plan.planId,
          planTitle: plan.title,
          totalPhases: plan.phases.length,
          phases: plan.phases.map((p) => ({
            phaseId: p.id,
            phaseTitle: p.title,
            status: 'pending' as const,
            touchedFiles: []
          })),
          phaseFiles: plan.phaseFiles,
          conversationId,
          startedAt: Date.now()
        }
      }
    }))
  },

  updatePhase: (conversationId, update) => {
    set((state) => {
      const exec = state.executions[conversationId]
      if (!exec) return state

      let phases = exec.phases.map((p) => {
        if (p.phaseId !== update.phaseId) return p
        const allPhaseFiles = exec.phaseFiles?.[p.phaseId] ?? []
        // When completing, auto-fill touchedFiles with all known files for this phase
        const touchedFiles =
          update.status === 'completed' && allPhaseFiles.length > 0
            ? allPhaseFiles
            : p.touchedFiles
        return {
          ...p,
          status: update.status,
          message: update.message,
          startedAt: update.status === 'started' ? Date.now() : p.startedAt,
          completedAt:
            update.status === 'completed' || update.status === 'failed'
              ? Date.now()
              : p.completedAt,
          touchedFiles
        }
      })

      // If phaseId not in existing list (agent added dynamically), append it
      if (!phases.find((p) => p.phaseId === update.phaseId)) {
        phases = [
          ...phases,
          {
            phaseId: update.phaseId,
            phaseTitle: update.phaseTitle,
            status: update.status,
            startedAt: Date.now(),
            touchedFiles: []
          }
        ]
      }

      return {
        executions: {
          ...state.executions,
          [conversationId]: { ...exec, phases, totalPhases: update.totalPhases }
        }
      }
    })
  },

  inferPhaseFromFile: (conversationId, filePath) => {
    set((state) => {
      const exec = state.executions[conversationId]
      if (!exec?.phaseFiles) return state

      // Normalize to forward slashes for comparison
      const normalizedPath = filePath.replace(/\\/g, '/')

      const matchedPhase = exec.phases.find((p) => {
        const files = exec.phaseFiles?.[p.phaseId]
        if (!files) return false
        return files.some((f) => {
          const normalizedF = f.replace(/\\/g, '/')
          // Match full path segments, not just suffixes
          return normalizedPath.endsWith(normalizedF) ||
            normalizedPath.includes('/' + normalizedF)
        })
      })

      if (!matchedPhase) return state

      // Append the matched file to touchedFiles (deduped)
      const normalizedFile = filePath.replace(/\\/g, '/')
      const phases = exec.phases.map((p) => {
        if (p.phaseId !== matchedPhase.phaseId) return p
        const alreadyTouched = p.touchedFiles.some(
          (f) => f.replace(/\\/g, '/') === normalizedFile
        )
        const touchedFiles = alreadyTouched
          ? p.touchedFiles
          : [...p.touchedFiles, normalizedFile]
        // Transition pending → in_progress, but leave other statuses unchanged
        const status = p.status === 'pending' ? ('in_progress' as const) : p.status
        const startedAt = p.status === 'pending' ? Date.now() : p.startedAt
        return { ...p, status, startedAt, touchedFiles }
      })
      return { executions: { ...state.executions, [conversationId]: { ...exec, phases } } }
    })
  },

  markFileTouched: (conversationId, filePath) => {
    set((state) => {
      const exec = state.executions[conversationId]
      if (!exec?.phaseFiles) return state

      const normalizedPath = filePath.replace(/\\/g, '/')

      // Find which phase this file belongs to
      const matchedPhase = exec.phases.find((p) => {
        const files = exec.phaseFiles?.[p.phaseId]
        if (!files) return false
        return files.some((f) => {
          const normalizedF = f.replace(/\\/g, '/')
          return normalizedPath.endsWith(normalizedF) ||
            normalizedPath.includes('/' + normalizedF)
        })
      })

      if (!matchedPhase) return state

      const alreadyTouched = matchedPhase.touchedFiles.some(
        (f) => f.replace(/\\/g, '/') === normalizedPath
      )
      if (alreadyTouched) return state

      const phases = exec.phases.map((p) =>
        p.phaseId === matchedPhase.phaseId
          ? { ...p, touchedFiles: [...p.touchedFiles, normalizedPath] }
          : p
      )
      return { executions: { ...state.executions, [conversationId]: { ...exec, phases } } }
    })
  },

  clearExecution: (conversationId) => {
    set((state) => {
      const { [conversationId]: _, ...rest } = state.executions
      return { executions: rest }
    })
  }
}))

// HMR state preservation
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    ;(import.meta.hot as { data: Record<string, unknown> }).data.planExecStoreState =
      usePlanExecutionStore.getState()
  })
}
