import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type {
  MpaStatus,
  MpaRun,
  MpaPhase,
  MpaArtifact,
  MpaPlanArtifact,
  MpaClassifyResult,
  MpaPreloadedGoal,
  MpaGoalType,
  MpaPhaseType
} from '../../../shared/mpa-types'

// ── Store Interface ──

interface MpaState {
  // Pipeline status
  status: MpaStatus
  isRunning: boolean

  // Active run data
  currentRun: MpaRun | null
  phases: MpaPhase[]
  configuredPhases: MpaPhaseType[]
  artifacts: MpaArtifact[]

  // Phase streaming
  phaseStreamText: Record<string, string> // phaseId → accumulated text

  // Approval gate
  pendingApproval: {
    runId: string
    phaseId: string
    artifactId: string
    artifact: MpaPlanArtifact
  } | null

  // Pre-flight classification
  classifyResult: MpaClassifyResult | null

  // Pre-loaded goal (from Grill → Goals flow)
  preloadedGoal: MpaPreloadedGoal | null

  // Run history
  history: MpaRun[]

  // ── Actions ──

  startGoal: (params: {
    workspaceId: string
    goal: string
    title: string
    goalType: MpaGoalType
    phases: MpaPhaseType[]
    grillSessionId?: string
    grillDecisions?: Array<{ header: string; selectedOption: string; reason: string }>
  }) => Promise<void>

  cancelGoal: () => Promise<void>

  classifyGoal: (goal: string) => Promise<MpaClassifyResult>

  respondToApproval: (approved: boolean, feedback?: string) => Promise<void>

  loadStatus: (workspaceId: string) => Promise<void>

  loadRun: (runId: string) => Promise<void>

  loadHistory: (workspaceId: string) => Promise<void>

  setPreloadedGoal: (goal: MpaPreloadedGoal | null) => void

  // IPC event handlers
  registerListeners: () => () => void

  reset: () => void
}

const INITIAL_STATUS: MpaStatus = {
  status: 'idle',
  runId: null,
  currentPhase: null,
  phaseIndex: 0,
  totalPhases: 0,
  iteration: 0,
  awaitingApproval: false
}

export const useMpaStore = create<MpaState>((set, get) => ({
  status: { ...INITIAL_STATUS },
  isRunning: false,
  currentRun: null,
  phases: [],
  configuredPhases: [],
  artifacts: [],
  phaseStreamText: {},
  pendingApproval: null,
  classifyResult: null,
  preloadedGoal: null,
  history: [],

  // ── Actions ──

  startGoal: async (params) => {
    try {
      set({
        isRunning: true,
        phaseStreamText: {},
        pendingApproval: null,
        configuredPhases: params.phases
      })
      await window.api.mpaStart(params)
    } catch (error) {
      rendererLog.error('Failed to start MPA goal:', error)
      set({ isRunning: false })
      throw error
    }
  },

  cancelGoal: async () => {
    try {
      await window.api.mpaCancel()
      set({ isRunning: false, pendingApproval: null })
    } catch (error) {
      rendererLog.error('Failed to cancel MPA goal:', error)
    }
  },

  classifyGoal: async (goal: string) => {
    try {
      const result = (await window.api.mpaClassifyGoal({ goal })) as MpaClassifyResult
      set({ classifyResult: result })
      return result
    } catch (error) {
      rendererLog.error('Failed to classify goal:', error)
      throw error
    }
  },

  respondToApproval: async (approved: boolean, feedback?: string) => {
    const { pendingApproval } = get()
    if (!pendingApproval) return

    try {
      await window.api.mpaApprovalRespond({
        runId: pendingApproval.runId,
        approved,
        feedback
      })
      set({ pendingApproval: null })
    } catch (error) {
      rendererLog.error('Failed to respond to approval:', error)
    }
  },

  loadStatus: async (workspaceId: string) => {
    try {
      const status = (await window.api.mpaGetStatus({ workspaceId })) as MpaStatus
      set({
        status,
        isRunning: status.status === 'running' || status.status === 'paused'
      })
    } catch (error) {
      rendererLog.error('Failed to load MPA status:', error)
    }
  },

  loadRun: async (runId: string) => {
    try {
      const data = (await window.api.mpaGetRun({ runId })) as {
        run: MpaRun
        phases: MpaPhase[]
        artifacts: MpaArtifact[]
      } | null
      if (data) {
        set({
          currentRun: data.run,
          phases: data.phases,
          artifacts: data.artifacts
        })
      }
    } catch (error) {
      rendererLog.error('Failed to load MPA run:', error)
    }
  },

  loadHistory: async (workspaceId: string) => {
    try {
      const history = (await window.api.mpaGetHistory({ workspaceId })) as MpaRun[]
      set({ history })
    } catch (error) {
      rendererLog.error('Failed to load MPA history:', error)
    }
  },

  setPreloadedGoal: (goal) => set({ preloadedGoal: goal }),

  registerListeners: () => {
    const cleanups: Array<() => void> = []

    // Streaming buffer — accumulates chunks between RAF flushes to reduce
    // store updates from 100s/sec to ~60/sec (one spread per flush).
    let streamBuffer: Record<string, string> = {}
    let flushScheduled = false
    let rafId: number | null = null

    cleanups.push(
      window.api.onMpaPhaseStart((data) => {
        rendererLog.info(`[mpa] Phase started: ${data.phaseType} (iteration ${data.iteration})`)
        set((state) => ({
          status: {
            ...state.status,
            status: 'running',
            runId: data.runId,
            currentPhase: data.phaseType as MpaPhaseType,
            iteration: data.iteration,
            awaitingApproval: false
          }
        }))
      })
    )

    cleanups.push(
      window.api.onMpaPhaseProgress((data) => {
        streamBuffer[data.phaseId] = (streamBuffer[data.phaseId] ?? '') + data.streamChunk

        if (!flushScheduled) {
          flushScheduled = true
          rafId = requestAnimationFrame(() => {
            const buffered = streamBuffer
            streamBuffer = {}
            flushScheduled = false
            rafId = null
            set((state) => {
              const updated = { ...state.phaseStreamText }
              for (const [phaseId, chunk] of Object.entries(buffered)) {
                updated[phaseId] = (updated[phaseId] ?? '') + chunk
              }
              return { phaseStreamText: updated }
            })
          })
        }
      })
    )

    cleanups.push(
      window.api.onMpaPhaseComplete((data) => {
        rendererLog.info(`[mpa] Phase complete: ${data.phaseType} — ${data.status}`)
      })
    )

    cleanups.push(
      window.api.onMpaFeedbackLoop((data) => {
        rendererLog.info(
          `[mpa] Feedback loop: ${data.fromPhase} → ${data.toPhase} (iteration ${data.iteration})`
        )
      })
    )

    cleanups.push(
      window.api.onMpaApprovalNeeded((data) => {
        rendererLog.info(`[mpa] Approval needed for run ${data.runId}`)
        set({
          pendingApproval: {
            runId: data.runId,
            phaseId: data.phaseId,
            artifactId: data.artifactId,
            artifact: data.artifact as MpaPlanArtifact
          },
          status: {
            ...get().status,
            status: 'paused',
            awaitingApproval: true
          }
        })
      })
    )

    cleanups.push(
      window.api.onMpaPipelineComplete((data) => {
        rendererLog.info(`[mpa] Pipeline complete: ${data.status}`)
        set({
          isRunning: false,
          status: {
            ...INITIAL_STATUS,
            status: data.status as MpaStatus['status']
          },
          pendingApproval: null
        })
      })
    )

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      cleanups.forEach((fn) => fn())
    }
  },

  reset: () =>
    set({
      status: { ...INITIAL_STATUS },
      isRunning: false,
      currentRun: null,
      phases: [],
      configuredPhases: [],
      artifacts: [],
      phaseStreamText: {},
      pendingApproval: null,
      classifyResult: null,
      preloadedGoal: null
    })
}))
