import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type {
  MpaStatus,
  MpaRun,
  MpaPhase,
  MpaArtifact,
  MpaPlanArtifact,
  MpaPreloadedGoal,
  MpaPhaseType,
  MeasurableGoal,
  MpaCampaign,
  MpaCampaignStatus,
  MpaCampaignGoalStatus,
  MpaCampaignPauseAction
} from '../../../shared/mpa-types'

// ── Campaign (renderer-side runtime) ──

/** Transient draft built in the 3-step campaign panel before launch. */
export interface CampaignDraft {
  originalPlanText: string
  goals: MeasurableGoal[]
}

/** Per-goal runtime status tracked while a campaign runs. */
export interface CampaignGoalRuntime {
  goalId: string
  title: string
  orderIndex: number
  status: MpaCampaignGoalStatus
  successCriteria: string[]
}

export interface ActiveCampaign {
  id: string
  /** Workspace this campaign belongs to — used to ignore cross-workspace events. */
  workspaceId: string
  title: string
  totalGoals: number
  currentIndex: number
  status: MpaCampaignStatus
  goals: CampaignGoalRuntime[]
  paused: { orderIndex: number; goalId: string; reason: string } | null
}

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

  // Pre-loaded goal (from Grill → Goals flow)
  preloadedGoal: MpaPreloadedGoal | null

  // Campaign draft (3-step panel) + active campaign runtime
  campaignDraft: CampaignDraft | null
  activeCampaign: ActiveCampaign | null

  // Persisted campaign history (grouped goal runs)
  campaignHistory: MpaCampaign[]

  // Run history
  history: MpaRun[]

  // ── Actions ──

  cancelGoal: () => Promise<void>

  respondToApproval: (approved: boolean, feedback?: string) => Promise<void>

  loadStatus: (workspaceId: string) => Promise<void>

  loadRun: (runId: string) => Promise<void>

  loadHistory: (workspaceId: string) => Promise<void>

  setPreloadedGoal: (goal: MpaPreloadedGoal | null) => void

  // ── Campaign actions ──
  setCampaignDraft: (draft: CampaignDraft | null) => void
  decomposeGoals: (workspaceId: string, input: string) => Promise<MeasurableGoal[]>
  startCampaign: (params: {
    workspaceId: string
    title: string
    originalPlanMd: string
    goals: MeasurableGoal[]
  }) => Promise<void>
  respondToCampaign: (workspaceId: string, action: MpaCampaignPauseAction) => Promise<void>
  cancelCampaign: (workspaceId: string) => Promise<void>
  loadCampaignHistory: (workspaceId: string) => Promise<void>

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
  preloadedGoal: null,
  campaignDraft: null,
  activeCampaign: null,
  campaignHistory: [],
  history: [],

  // ── Actions ──

  cancelGoal: async () => {
    try {
      await window.api.mpaCancel()
      set({ isRunning: false, pendingApproval: null })
    } catch (error) {
      rendererLog.error('Failed to cancel MPA goal:', error)
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

  // ── Campaign actions ──

  setCampaignDraft: (draft) => set({ campaignDraft: draft }),

  decomposeGoals: async (workspaceId, input) => {
    const result = await window.api.mpaDecomposeGoals({ workspaceId, input })
    return result.goals as MeasurableGoal[]
  },

  startCampaign: async (params) => {
    try {
      // Seed runtime state from the draft goals so the UI can render the rail
      // before the first campaign event arrives.
      set({
        isRunning: true,
        phaseStreamText: {},
        pendingApproval: null,
        campaignDraft: null,
        activeCampaign: {
          id: '',
          workspaceId: params.workspaceId,
          title: params.title,
          totalGoals: params.goals.length,
          currentIndex: 0,
          status: 'running',
          goals: params.goals.map((g, orderIndex) => ({
            goalId: g.id,
            title: g.title,
            orderIndex,
            status: 'pending',
            successCriteria: g.successCriteria
          })),
          paused: null
        }
      })
      await window.api.mpaCampaignStart(params)
    } catch (error) {
      rendererLog.error('Failed to start campaign:', error)
      set({ isRunning: false, activeCampaign: null })
      throw error
    }
  },

  respondToCampaign: async (workspaceId, action) => {
    try {
      await window.api.mpaCampaignRespond({ workspaceId, action })
      set((state) =>
        state.activeCampaign
          ? { activeCampaign: { ...state.activeCampaign, status: 'running', paused: null } }
          : {}
      )
    } catch (error) {
      rendererLog.error('Failed to respond to campaign:', error)
    }
  },

  cancelCampaign: async (workspaceId) => {
    try {
      await window.api.mpaCampaignCancel({ workspaceId })
    } catch (error) {
      rendererLog.error('Failed to cancel campaign:', error)
    }
  },

  loadCampaignHistory: async (workspaceId) => {
    try {
      const campaigns = (await window.api.mpaCampaignGetHistory({ workspaceId })) as MpaCampaign[]
      set({ campaignHistory: campaigns })
    } catch (error) {
      rendererLog.error('Failed to load campaign history:', error)
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
        rendererLog.warn(`[mpa] window.api.${label} unavailable — live updates disabled for it`)
        return
      }
      cleanups.push(fn(...args))
    }

    // Streaming buffer — accumulates chunks between RAF flushes to reduce
    // store updates from 100s/sec to ~60/sec (one spread per flush).
    let streamBuffer: Record<string, string> = {}
    let flushScheduled = false
    let rafId: number | null = null

    safeSubscribe(window.api.onMpaPhaseStart, 'onMpaPhaseStart', (data) => {
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

    safeSubscribe(window.api.onMpaPhaseProgress, 'onMpaPhaseProgress', (data) => {
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

    safeSubscribe(window.api.onMpaPhaseComplete, 'onMpaPhaseComplete', (data) => {
      rendererLog.info(`[mpa] Phase complete: ${data.phaseType} — ${data.status}`)
    })

    safeSubscribe(window.api.onMpaFeedbackLoop, 'onMpaFeedbackLoop', (data) => {
      rendererLog.info(
        `[mpa] Feedback loop: ${data.fromPhase} → ${data.toPhase} (iteration ${data.iteration})`
      )
    })

    safeSubscribe(window.api.onMpaApprovalNeeded, 'onMpaApprovalNeeded', (data) => {
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

    safeSubscribe(window.api.onMpaPipelineComplete, 'onMpaPipelineComplete', (data) => {
      rendererLog.info(`[mpa] Pipeline complete: ${data.status}`)
      const { activeCampaign } = get()
      // Mid-campaign: a single goal finished but the campaign continues — keep
      // isRunning true so the active view stays mounted for the next goal.
      if (activeCampaign && activeCampaign.status === 'running') {
        set({
          phaseStreamText: {},
          pendingApproval: null,
          status: { ...INITIAL_STATUS, status: 'running' }
        })
        return
      }
      set({
        isRunning: false,
        status: {
          ...INITIAL_STATUS,
          status: data.status as MpaStatus['status']
        },
        pendingApproval: null
      })
    })

    // ── Campaign events ──
    // Every campaign listener ignores events from a different workspace so a
    // campaign in workspace A never mutates the active view of workspace B.
    const isForActiveCampaign = (workspaceId: string): boolean =>
      get().activeCampaign?.workspaceId === workspaceId

    safeSubscribe(window.api.onMpaCampaignStarted, 'onMpaCampaignStarted', (data) => {
      if (!isForActiveCampaign(data.workspaceId)) return
      rendererLog.info(`[campaign] started: ${data.title} (${data.totalGoals} goals)`)
      set((state) =>
        state.activeCampaign
          ? { activeCampaign: { ...state.activeCampaign, id: data.campaignId } }
          : {}
      )
    })

    safeSubscribe(window.api.onMpaCampaignGoalStart, 'onMpaCampaignGoalStart', (data) => {
      if (!isForActiveCampaign(data.workspaceId)) return
      rendererLog.info(`[campaign] goalStart: #${data.orderIndex} ${data.title}`)
      set((state) => {
        if (!state.activeCampaign) return {}
        const goals = state.activeCampaign.goals.map((g) =>
          g.orderIndex === data.orderIndex ? { ...g, status: 'running' as const } : g
        )
        return {
          isRunning: true,
          phaseStreamText: {},
          activeCampaign: { ...state.activeCampaign, currentIndex: data.orderIndex, goals }
        }
      })
    })

    safeSubscribe(window.api.onMpaCampaignGoalComplete, 'onMpaCampaignGoalComplete', (data) => {
      if (!isForActiveCampaign(data.workspaceId)) return
      rendererLog.info(`[campaign] goalComplete: #${data.orderIndex} ${data.status}`)
      set((state) => {
        if (!state.activeCampaign) return {}
        const goals = state.activeCampaign.goals.map((g) =>
          g.orderIndex === data.orderIndex
            ? { ...g, status: data.status as MpaCampaignGoalStatus }
            : g
        )
        return { activeCampaign: { ...state.activeCampaign, goals } }
      })
    })

    safeSubscribe(window.api.onMpaCampaignPaused, 'onMpaCampaignPaused', (data) => {
      if (!isForActiveCampaign(data.workspaceId)) return
      rendererLog.info(`[campaign] paused: #${data.orderIndex} ${data.reason}`)
      set((state) =>
        state.activeCampaign
          ? {
              activeCampaign: {
                ...state.activeCampaign,
                status: 'paused',
                paused: {
                  orderIndex: data.orderIndex,
                  goalId: data.goalId,
                  reason: data.reason
                }
              }
            }
          : {}
      )
    })

    safeSubscribe(window.api.onMpaCampaignComplete, 'onMpaCampaignComplete', (data) => {
      // Cross-workspace guard: don't overwrite another workspace's history if the
      // user switched workspaces mid-campaign.
      if (!isForActiveCampaign(data.workspaceId)) return
      rendererLog.info(`[campaign] complete: ${data.status}`)
      set((state) => ({
        isRunning: false,
        status: { ...INITIAL_STATUS },
        pendingApproval: null,
        activeCampaign: state.activeCampaign
          ? {
              ...state.activeCampaign,
              status: data.status as MpaCampaignStatus,
              paused: null
            }
          : null
      }))
      // Refresh persisted history + grouped campaigns now that it's done.
      void get().loadCampaignHistory(data.workspaceId)
      void get().loadHistory(data.workspaceId)
    })

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
      preloadedGoal: null,
      campaignDraft: null,
      activeCampaign: null,
      campaignHistory: []
    })
}))
