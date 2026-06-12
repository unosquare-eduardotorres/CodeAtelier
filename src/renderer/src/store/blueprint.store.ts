import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type {
  Blueprint,
  BlueprintWithDetails,
  BlueprintPhaseType,
  BlueprintTaskStatus
} from '../../../shared/blueprint-types'

// ── Store Interface ──

interface BlueprintState {
  // Pipeline
  isRunning: boolean
  activeWorkspaceId: string | null
  currentBlueprint: BlueprintWithDetails | null
  currentPhase: BlueprintPhaseType | null

  // Streaming — RAF-buffered (same pattern as MPA)
  phaseStreamText: Record<string, string> // phase type → accumulated text

  // Approval gate (review → build transition)
  pendingApproval: { blueprintId: string; planSummary: string } | null

  // Build wave tracking
  currentWave: { wave: number; taskCount: number } | null
  waveTasks: Record<string, 'pending' | 'running' | 'complete' | 'failed'>

  // History
  history: Blueprint[]

  // ── Actions ──

  loadHistory: (workspaceId: string) => Promise<void>
  loadBlueprint: (blueprintId: string) => Promise<void>
  startBlueprint: (params: {
    workspaceId: string
    title: string
    description?: string
    priority?: string
  }) => Promise<void>
  cancelBlueprint: (workspaceId: string) => Promise<void>
  respondToApproval: (blueprintId: string, approved: boolean, feedback?: string) => Promise<void>
  loadPipelineStatus: (workspaceId: string) => Promise<void>

  // IPC event handlers
  registerListeners: () => () => void

  reset: () => void
}

export const useBlueprintStore = create<BlueprintState>((set, get) => ({
  isRunning: false,
  activeWorkspaceId: null,
  currentBlueprint: null,
  currentPhase: null,
  phaseStreamText: {},
  pendingApproval: null,
  currentWave: null,
  waveTasks: {},
  history: [],

  // ── Actions ──

  loadHistory: async (workspaceId: string) => {
    try {
      const history = (await window.api.blueprintList({
        workspaceId,
        limit: 50
      })) as Blueprint[]
      set({ history })
    } catch (error) {
      rendererLog.error('Failed to load blueprint history:', error)
    }
  },

  loadBlueprint: async (blueprintId: string) => {
    try {
      const data = (await window.api.blueprintGetDetails({
        id: blueprintId
      })) as BlueprintWithDetails | null
      if (data) {
        set({ currentBlueprint: data })
      }
    } catch (error) {
      rendererLog.error('Failed to load blueprint details:', error)
    }
  },

  startBlueprint: async (params) => {
    try {
      const result = (await window.api.blueprintCreate({
        workspaceId: params.workspaceId,
        title: params.title,
        description: params.description,
        priority: params.priority
      })) as { id: string }

      set({
        isRunning: true,
        activeWorkspaceId: params.workspaceId,
        phaseStreamText: {},
        pendingApproval: null,
        currentWave: null,
        waveTasks: {}
      })

      // Auto-start the specify phase
      await window.api.blueprintStartSpecify({
        blueprintId: result.id,
        workspaceId: params.workspaceId
      })
    } catch (error) {
      rendererLog.error('Failed to start blueprint:', error)
      set({ isRunning: false, activeWorkspaceId: null })
      throw error
    }
  },

  cancelBlueprint: async (workspaceId: string) => {
    try {
      await window.api.blueprintCancel({ workspaceId })
      set({
        isRunning: false,
        activeWorkspaceId: null,
        pendingApproval: null,
        currentWave: null,
        waveTasks: {}
      })
      void get().loadHistory(workspaceId)
    } catch (error) {
      rendererLog.error('Failed to cancel blueprint:', error)
    }
  },

  respondToApproval: async (blueprintId: string, approved: boolean, feedback?: string) => {
    try {
      await window.api.blueprintApprovalRespond({
        blueprintId,
        approved,
        feedback
      })
      set({ pendingApproval: null })
    } catch (error) {
      rendererLog.error('Failed to respond to blueprint approval:', error)
    }
  },

  loadPipelineStatus: async (workspaceId: string) => {
    try {
      const status = await window.api.blueprintGetPipelineStatus({ workspaceId })
      set({
        isRunning: status.running,
        activeWorkspaceId: status.running ? workspaceId : get().activeWorkspaceId,
        currentPhase: (status.currentPhase as BlueprintPhaseType) ?? null
      })

      // If a pipeline is running, load its blueprint details
      if (status.running && status.blueprintId) {
        await get().loadBlueprint(status.blueprintId)
      }
    } catch (error) {
      rendererLog.error('Failed to load blueprint pipeline status:', error)
    }
  },

  registerListeners: () => {
    const cleanups: Array<() => void> = []

    // Guard every IPC subscription: a missing preload binding (version skew)
    // must NOT throw during store init and white-screen the renderer. Logs a
    // warning and disables live updates for that one event instead.
    const safeSubscribe = <A extends unknown[]>(
      fn: ((...args: A) => () => void) | undefined,
      label: string,
      ...args: A
    ): void => {
      if (typeof fn !== 'function') {
        rendererLog.warn(
          `[blueprint] window.api.${label} unavailable — live updates disabled for it`
        )
        return
      }
      cleanups.push(fn(...args))
    }

    // Streaming buffer — accumulates chunks between RAF flushes to reduce
    // store updates from 100s/sec to ~60/sec (one spread per flush).
    // Cross-workspace guard: ignore events from a different workspace so a
    // blueprint in workspace A never mutates the active view of workspace B.
    const isForActiveWorkspace = (workspaceId: string): boolean =>
      get().activeWorkspaceId === workspaceId

    let streamBuffer: Record<string, string> = {}
    let flushScheduled = false
    let rafId: number | null = null

    safeSubscribe(window.api.onBlueprintPhaseStart, 'onBlueprintPhaseStart', (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      rendererLog.info(`[blueprint] Phase started: ${data.phase}`)
      set((state) => ({
        currentPhase: data.phase as BlueprintPhaseType,
        isRunning: true,
        // Clear old text for this phase so rewinds (reject → re-plan) start fresh
        phaseStreamText: { ...state.phaseStreamText, [data.phase]: '' }
      }))
    })

    safeSubscribe(window.api.onBlueprintPhaseProgress, 'onBlueprintPhaseProgress', (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      const key = data.phase
      streamBuffer[key] = (streamBuffer[key] ?? '') + data.text

      if (!flushScheduled) {
        flushScheduled = true
        rafId = requestAnimationFrame(() => {
          const buffered = streamBuffer
          streamBuffer = {}
          flushScheduled = false
          rafId = null
          set((state) => {
            const updated = { ...state.phaseStreamText }
            for (const [phase, chunk] of Object.entries(buffered)) {
              updated[phase] = (updated[phase] ?? '') + chunk
            }
            return { phaseStreamText: updated }
          })
        })
      }
    })

    safeSubscribe(window.api.onBlueprintPhaseComplete, 'onBlueprintPhaseComplete', (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      rendererLog.info(`[blueprint] Phase complete: ${data.phase} — ${data.status}`)
      // If the pipeline-level status is 'complete' or 'failed', mark as not running
      if (data.status === 'complete' && data.phase === 'verify') {
        const wsId = get().activeWorkspaceId
        set({ isRunning: false, activeWorkspaceId: null })
        if (wsId) void get().loadHistory(wsId)
      }
      if (data.status === 'failed') {
        const wsId = get().activeWorkspaceId
        set({ isRunning: false, activeWorkspaceId: null })
        if (wsId) void get().loadHistory(wsId)
      }
    })

    safeSubscribe(window.api.onBlueprintPhaseArtifact, 'onBlueprintPhaseArtifact', (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      rendererLog.info(`[blueprint] Phase artifact: ${data.phase} — ${data.artifact.type}`)
    })

    safeSubscribe(window.api.onBlueprintApprovalNeeded, 'onBlueprintApprovalNeeded', (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      rendererLog.info(`[blueprint] Approval needed for ${data.blueprintId}`)
      set({
        pendingApproval: {
          blueprintId: data.blueprintId,
          planSummary: data.planSummary
        }
      })
    })

    safeSubscribe(window.api.onBlueprintWaveStart, 'onBlueprintWaveStart', (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      rendererLog.info(`[blueprint] Wave ${data.wave} started (${data.taskCount} tasks)`)
      set({
        currentWave: { wave: data.wave, taskCount: data.taskCount },
        waveTasks: {}
      })
    })

    safeSubscribe(window.api.onBlueprintWaveTaskStart, 'onBlueprintWaveTaskStart', (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      rendererLog.info(`[blueprint] Wave ${data.wave} task ${data.taskId} started`)
      set((state) => ({
        waveTasks: { ...state.waveTasks, [data.taskId]: 'running' as const }
      }))
    })

    safeSubscribe(window.api.onBlueprintWaveTaskComplete, 'onBlueprintWaveTaskComplete', (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      rendererLog.info(`[blueprint] Wave ${data.wave} task ${data.taskId} ${data.status}`)
      set((state) => ({
        waveTasks: {
          ...state.waveTasks,
          [data.taskId]: data.status as BlueprintTaskStatus
        }
      }))
    })

    safeSubscribe(window.api.onBlueprintWaveComplete, 'onBlueprintWaveComplete', (data) => {
      if (!isForActiveWorkspace(data.workspaceId)) return
      rendererLog.info(`[blueprint] Wave ${data.wave} complete — ${data.status}`)
      if (data.status === 'failed') {
        const wsId = get().activeWorkspaceId
        set({ isRunning: false, activeWorkspaceId: null })
        if (wsId) void get().loadHistory(wsId)
      }
    })

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      cleanups.forEach((fn) => fn())
    }
  },

  reset: () =>
    set({
      isRunning: false,
      activeWorkspaceId: null,
      currentBlueprint: null,
      currentPhase: null,
      phaseStreamText: {},
      pendingApproval: null,
      currentWave: null,
      waveTasks: {},
      history: []
    })
}))
