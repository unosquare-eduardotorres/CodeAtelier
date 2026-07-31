/**
 * plan-execution.store — Zustand store for live plan execution phase tracking.
 *
 * Tracks which phase of a structured plan is currently in progress,
 * enabling the TaskSummaryBadge and ChatExecutionPanel live progress tracking.
 *
 * Primary signal: emit_phase_progress MCP tool (agent-driven)
 * Fallback signal: file-based inference from tool activity
 */

import { create } from 'zustand'

export type TaskStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'

export interface TaskProgress {
  taskId: string
  title: string
  status: TaskStatus
  startedAt?: number
  completedAt?: number
  /** Files this task operates on (from plan's phase.files) */
  files?: string[]
}

export interface PhaseStatus {
  phaseId: number
  phaseTitle: string
  status: 'pending' | 'started' | 'in_progress' | 'completed' | 'failed' | 'skipped'
  startedAt?: number
  completedAt?: number
  message?: string
  /** Files the agent has touched within this phase (populated via tool activity inference) */
  touchedFiles: string[]
  /** Tasks within this phase — populated from StructuredPlan phases or agent task-level events */
  tasks: TaskProgress[]
}

export interface PlanExecution {
  planId: string | null
  planTitle: string
  planGoal?: string
  totalPhases: number
  phases: PhaseStatus[]
  /** File-to-phase mappings for fallback inference */
  phaseFiles?: Record<number, string[]>
  conversationId: string
  startedAt: number
  /** Set when all phases finish — signals read-only mode in ChatExecutionPanel */
  completedAt?: number
}

interface PlanExecutionState {
  /** Active execution per conversation */
  executions: Record<string, PlanExecution>

  /** Latest structured plan content per conversation (for panel Plan tab) */
  latestPlanContent: Record<string, string>
  setLatestPlanContent: (conversationId: string, content: string) => void

  /** Initialize an execution when "Build Now" is clicked */
  startExecution: (
    conversationId: string,
    plan: {
      planId: string | null
      title: string
      planGoal?: string
      phases: Array<{
        id: number
        title: string
        tasks?: Array<{ taskId: string; title: string; files?: string[] }>
      }>
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

  /** Update a task within a phase */
  updateTask: (
    conversationId: string,
    update: {
      phaseId: number
      taskId: string
      title: string
      status: TaskStatus
    }
  ) => void

  /** Mark execution as completed (read-only mode) without removing it */
  completeExecution: (conversationId: string) => void

  /** Dismiss a completed execution (user-initiated or conversation delete) */
  dismissExecution: (conversationId: string) => void

  /** Clear execution state (full removal — backward compat) */
  clearExecution: (conversationId: string) => void
}

// Preserve Zustand state across HMR (dev only)
const previousState = import.meta.hot?.data?.planExecStoreState as
  | Partial<PlanExecutionState>
  | undefined

export const usePlanExecutionStore = create<PlanExecutionState>((set) => ({
  executions: previousState?.executions ?? {},
  latestPlanContent: previousState?.latestPlanContent ?? {},

  setLatestPlanContent: (conversationId, content) => {
    set((state) => ({
      latestPlanContent: { ...state.latestPlanContent, [conversationId]: content }
    }))
  },

  startExecution: (conversationId, plan) => {
    set((state) => ({
      executions: {
        ...state.executions,
        [conversationId]: {
          planId: plan.planId,
          planTitle: plan.title,
          planGoal: plan.planGoal,
          totalPhases: plan.phases.length,
          phases: plan.phases.map((p) => ({
            phaseId: p.id,
            phaseTitle: p.title,
            status: 'pending' as const,
            touchedFiles: [],
            tasks: (p.tasks ?? []).map((t) => ({
              taskId: t.taskId,
              title: t.title,
              status: 'pending' as const,
              files: t.files
            }))
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
        // When phase completes, auto-complete any pending/running tasks within it
        const tasks = update.status === 'completed'
          ? p.tasks.map(t =>
              t.status === 'pending' || t.status === 'running'
                ? { ...t, status: 'complete' as const, completedAt: Date.now() }
                : t
            )
          // When phase starts/progresses, auto-mark the first pending task as running
          // (only if no task is already running — prevents overwriting agent-driven updates)
          : (update.status === 'started' || update.status === 'in_progress')
              && p.tasks.length > 0
              && !p.tasks.some(t => t.status === 'running')
            ? p.tasks.map((t, i, arr) => {
                const firstPendingIdx = arr.findIndex(x => x.status === 'pending')
                return i === firstPendingIdx
                  ? { ...t, status: 'running' as const, startedAt: Date.now() }
                  : t
              })
            : p.tasks
        return {
          ...p,
          status: update.status,
          message: update.message,
          startedAt: update.status === 'started' ? Date.now() : p.startedAt,
          completedAt:
            update.status === 'completed' || update.status === 'failed'
              ? Date.now()
              : p.completedAt,
          touchedFiles,
          tasks
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
            touchedFiles: [],
            tasks: []
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

        // Infer task-level progress: mark matching task as running (if pending)
        let tasks = p.tasks
        const matchedTaskIdx = tasks.findIndex(
          (t) =>
            t.status === 'pending' &&
            t.files?.some((tf) => {
              const normalizedTf = tf.replace(/\\/g, '/')
              return normalizedPath.endsWith(normalizedTf) ||
                normalizedPath.includes('/' + normalizedTf)
            })
        )
        if (matchedTaskIdx >= 0) {
          tasks = tasks.map((t, i) =>
            i === matchedTaskIdx
              ? { ...t, status: 'running' as const, startedAt: t.startedAt ?? Date.now() }
              : t
          )
        }

        return { ...p, status, startedAt, touchedFiles, tasks }
      })
      return { executions: { ...state.executions, [conversationId]: { ...exec, phases } } }
    })
  },

  updateTask: (conversationId, update) => {
    set((state) => {
      const exec = state.executions[conversationId]
      if (!exec) return state

      const phases = exec.phases.map((p) => {
        if (p.phaseId !== update.phaseId) return p

        let tasks = [...p.tasks]
        const idx = tasks.findIndex((t) => t.taskId === update.taskId)

        if (idx >= 0) {
          // Update existing task (exact ID match)
          tasks = tasks.map((t) =>
            t.taskId === update.taskId
              ? {
                  ...t,
                  title: update.title,
                  status: update.status,
                  startedAt: update.status === 'running' ? (t.startedAt ?? Date.now()) : t.startedAt,
                  completedAt:
                    update.status === 'complete' || update.status === 'failed'
                      ? Date.now()
                      : t.completedAt
                }
              : t
          )
        } else if (tasks.length > 0) {
          // Fuzzy match: update the first pending/running task in this phase
          // (agent task IDs rarely match the synthetic p.id-i format)
          const fuzzyIdx = tasks.findIndex(t => t.status === 'pending' || t.status === 'running')
          if (fuzzyIdx >= 0) {
            tasks = tasks.map((t, i) =>
              i === fuzzyIdx
                ? {
                    ...t,
                    taskId: update.taskId,  // adopt agent's ID going forward
                    title: update.title,
                    status: update.status,
                    startedAt: update.status === 'running' ? (t.startedAt ?? Date.now()) : t.startedAt,
                    completedAt:
                      update.status === 'complete' || update.status === 'failed'
                        ? Date.now()
                        : t.completedAt
                  }
                : t
            )
          } else {
            // All tasks done — append as genuinely new task
            tasks = [
              ...tasks,
              {
                taskId: update.taskId,
                title: update.title,
                status: update.status,
                startedAt: update.status === 'running' ? Date.now() : undefined,
                completedAt:
                  update.status === 'complete' || update.status === 'failed'
                    ? Date.now()
                    : undefined
              }
            ]
          }
        } else {
          // No pre-created tasks — append new
          tasks = [
            ...tasks,
            {
              taskId: update.taskId,
              title: update.title,
              status: update.status,
              startedAt: update.status === 'running' ? Date.now() : undefined,
              completedAt:
                update.status === 'complete' || update.status === 'failed'
                  ? Date.now()
                  : undefined
            }
          ]
        }

        // Auto-advance: when a task completes, mark the next pending task as running
        if (update.status === 'complete' || update.status === 'skipped') {
          const nextPendingIdx = tasks.findIndex(t => t.status === 'pending')
          if (nextPendingIdx >= 0) {
            tasks = tasks.map((t, i) =>
              i === nextPendingIdx
                ? { ...t, status: 'running' as const, startedAt: Date.now() }
                : t
            )
          }
        }

        return { ...p, tasks }
      })

      return {
        executions: {
          ...state.executions,
          [conversationId]: { ...exec, phases }
        }
      }
    })
  },

  markFileTouched: (conversationId, filePath) => {
    set((state) => {
      const exec = state.executions[conversationId]
      if (!exec?.phaseFiles) return state

      const normalizedPath = filePath.replace(/\\/g, '/')

      // Find which phase this file belongs to
      const matchedPhaseIdx = exec.phases.findIndex((p) => {
        const files = exec.phaseFiles?.[p.phaseId]
        if (!files) return false
        return files.some((f) => {
          const normalizedF = f.replace(/\\/g, '/')
          return normalizedPath.endsWith(normalizedF) ||
            normalizedPath.includes('/' + normalizedF)
        })
      })

      if (matchedPhaseIdx < 0) return state
      const matchedPhase = exec.phases[matchedPhaseIdx]

      const alreadyTouched = matchedPhase.touchedFiles.some(
        (f) => f.replace(/\\/g, '/') === normalizedPath
      )

      const phases = exec.phases.map((p) => {
        if (p.phaseId !== matchedPhase.phaseId) return p

        // Update touchedFiles (existing behavior)
        const touchedFiles = alreadyTouched
          ? p.touchedFiles
          : [...p.touchedFiles, normalizedPath]

        // Infer task completion from file write/edit
        let tasks = p.tasks
        const matchedTaskIdx = tasks.findIndex(
          (t) =>
            (t.status === 'pending' || t.status === 'running') &&
            t.files?.some((tf) => {
              const normalizedTf = tf.replace(/\\/g, '/')
              return normalizedPath.endsWith(normalizedTf) ||
                normalizedPath.includes('/' + normalizedTf)
            })
        )

        if (matchedTaskIdx >= 0) {
          tasks = tasks.map((t, i) =>
            i === matchedTaskIdx
              ? { ...t, status: 'complete' as const, completedAt: Date.now() }
              : t
          )
          // Auto-advance: mark next pending task as running
          const nextPendingIdx = tasks.findIndex((t) => t.status === 'pending')
          if (nextPendingIdx >= 0) {
            tasks = tasks.map((t, i) =>
              i === nextPendingIdx
                ? { ...t, status: 'running' as const, startedAt: t.startedAt ?? Date.now() }
                : t
            )
          }
        }

        return { ...p, touchedFiles, tasks }
      })

      return { executions: { ...state.executions, [conversationId]: { ...exec, phases } } }
    })
  },

  completeExecution: (conversationId) => {
    set((state) => {
      const exec = state.executions[conversationId]
      if (!exec) return state
      return {
        executions: {
          ...state.executions,
          [conversationId]: { ...exec, completedAt: Date.now() }
        }
      }
    })
  },

  dismissExecution: (conversationId) => {
    set((state) => {
      const { [conversationId]: _, ...rest } = state.executions
      return { executions: rest }
    })
  },

  clearExecution: (conversationId) => {
    set((state) => {
      const { [conversationId]: _, ...rest } = state.executions
      const { [conversationId]: _plan, ...restPlans } = state.latestPlanContent
      return { executions: rest, latestPlanContent: restPlans }
    })
  }
}))

// Expose store for E2E test injection (dev only)
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__PLAN_EXEC_STORE = usePlanExecutionStore
}

// HMR state preservation
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    ;(import.meta.hot as { data: Record<string, unknown> }).data.planExecStoreState =
      usePlanExecutionStore.getState()
  })
}
