import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import { useWorkspaceStore } from './workspace.store'
import {
  useBlueprintStreamStore,
  getFlatContent,
  getFlatToolActivities
} from './blueprint-stream.store'
import { stripBlueprintBlocks } from '../../../shared/blueprint-clarify-parsers'
import type {
  ClarifyFindingsBlock,
  ClarifyQuestionsBlock,
  ClarifyQuestion,
  QuestionAnswerState
} from '../../../shared/blueprint-clarify-parsers'
import { parseBlueprintPlan, parseBlueprintTasks } from '../../../shared/blueprint-artifact-parsers'
import type {
  Blueprint,
  BlueprintWithDetails,
  BlueprintPhaseType,
  BlueprintTaskStatus
} from '../../../shared/blueprint-types'
import type { ToolActivity } from '../../../shared/types'
import type { BlueprintMachineState } from '../../../shared/blueprint-snapshot-types'

// ── Blueprint Chat Message types (unified — all phases stream into this) ──

export type BlueprintChatMessage =
  | { type: 'agent'; content: string; toolActivities: ToolActivity[]; timestamp: number }
  | { type: 'user'; content: string; timestamp: number }
  | { type: 'system'; content: string; timestamp: number }
  | { type: 'findings'; findings: ClarifyFindingsBlock; round: number; timestamp: number }
  | { type: 'qa'; questions: ClarifyQuestion[]; answers: Record<string, QuestionAnswerState>; timestamp: number }
  | { type: 'plan'; plan: Record<string, unknown>; timestamp: number }
  | { type: 'tasks'; tasks: Record<string, unknown>; timestamp: number }

// ── Stream event types ──

export interface StreamEvent {
  kind: 'text' | 'tool'
  content: string
}

/** Module-level counter for unique tool IDs (fixes Date.now() same-ms collisions). */
let toolSeq = 0

/** Format milliseconds into human-friendly elapsed string (e.g. "1m 18s") */
export function formatPhaseDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

// ── Cancelled-event guard ──

/**
 * Recently cancelled blueprint IDs. After cancel, late IPC events (in-flight
 * chunks that arrive before abort takes effect) would otherwise hit the adopt
 * path and resurrect isRunning=true. This set lets event handlers drop those
 * stale events until the next startBlueprint/retryPhase clears the entry.
 */
const recentlyCancelledIds = new Set<string>()

/**
 * Returns true if the given blueprintId was recently cancelled and should be
 * dropped by IPC event handlers. Pure function for unit testing.
 */
export function shouldDropCancelledEvent(
  cancelledIds: ReadonlySet<string>,
  blueprintId: string
): boolean {
  return cancelledIds.has(blueprintId)
}

// ── Pure guard for workspace event adoption ──

/**
 * Decide whether to process or drop a blueprint IPC event based on workspace IDs.
 * Returns 'process' if the event matches the active workspace, 'adopt' if the store
 * has no activeWorkspaceId but the event matches the currently viewed workspace
 * (self-healing after race conditions), or 'drop' otherwise.
 *
 * Extracted as a pure function for unit testing.
 */
export function resolveBlueprintEventAction(
  activeWorkspaceId: string | null,
  viewedWorkspaceId: string | null,
  eventWorkspaceId: string
): 'process' | 'adopt' | 'drop' {
  if (activeWorkspaceId === eventWorkspaceId) return 'process'
  if (!activeWorkspaceId && viewedWorkspaceId === eventWorkspaceId) return 'adopt'
  return 'drop'
}

// ── Store Interface ──

interface BlueprintState {
  // Pipeline
  isRunning: boolean
  activeWorkspaceId: string | null
  currentBlueprint: BlueprintWithDetails | null
  currentPhase: BlueprintPhaseType | null

  // Chat transcript (unified — all phases stream into this)
  chatMessages: BlueprintChatMessage[]

  /** Clarify round counter for findings messages */
  clarifyRound: number

  // Activity tracking — used by UI for elapsed time / stale detection
  phaseStartedAt: number | null // Date.now() when current phase started
  lastChunkAt: number | null // Date.now() of last stream chunk received

  // Streaming — RAF-buffered (same pattern as MPA)
  phaseStreamText: Record<string, string> // phase type → accumulated text
  phaseStreamEvents: Record<string, StreamEvent[]> // phase type → structured events

  // Phase durations — captured on phaseComplete from phaseStartedAt timestamps
  phaseDurations: Partial<Record<BlueprintPhaseType, number>>
  /** Per-phase start timestamps for duration calculation */
  phaseStartTimestamps: Partial<Record<BlueprintPhaseType, number>>

  // Clarify Q&A (specify → clarify interactive)
  clarifyAwaitingInput: boolean
  /** Parsed findings from clarify phase (updated each round) */
  clarifyFindings: ClarifyFindingsBlock | null
  /** Pending question cards from clarify phase */
  clarifyQuestions: ClarifyQuestionsBlock | null
  /** Gate ready: completion arrived, user decides proceed vs iterate */
  clarifyGateReady: boolean
  /** B3-FIX: In-flight flag to block double-click on gate/iterate/answer actions */
  clarifyInFlight: boolean
  /** Blueprint ID that owns the current clarify questions (fallback when currentBlueprint is null) */
  clarifyBlueprintId: string | null

  // Approval gate (review → build transition)
  pendingApproval: { blueprintId: string; planSummary: string; completion?: Record<string, unknown>; reviewMarkdown?: string } | null

  // Goal tracking — current phase/task goal condition for UI display
  currentGoal: string | null
  /** Per-task goals keyed by taskId */
  taskGoals: Record<string, string>
  /** Currently executing task (shown as chip in header) */
  currentTask: { taskId: string; description: string } | null
  /** Phase completion metrics (from phaseComplete event) */
  phaseCompletions: Partial<Record<BlueprintPhaseType, Record<string, unknown>>>
  /** Total task count across all waves (for progress bar) */
  totalTaskCount: number
  /** Total wave count (for progress indicator) */
  totalWaves: number

  // Build wave tracking
  currentWave: { wave: number; taskCount: number } | null
  waveTasks: Record<string, BlueprintTaskStatus>

  // History
  history: Blueprint[]

  // Error tracking for failed phases
  lastError: { blueprintId: string; message: string } | null

  // Orphan detection — crash-recovery resume banner
  orphanedBlueprint: {
    blueprintId: string
    title: string
    currentPhase: string
    tasksCompleted: number
    totalTasks: number
  } | null

  // Pending onboard — handoff from CreateProjectDialog → BlueprintPage
  pendingOnboard: {
    workspaceId: string
    title: string
    description: string
    referenceDocuments: Array<{ type: string; path: string; name: string }>
  } | null

  // ── Actions ──

  setPendingOnboard: (payload: {
    workspaceId: string
    title: string
    description: string
    referenceDocuments: Array<{ type: string; path: string; name: string }>
  }) => void
  clearPendingOnboard: () => void
  loadHistory: (workspaceId: string) => Promise<void>
  loadBlueprint: (blueprintId: string) => Promise<void>
  startBlueprint: (params: {
    workspaceId: string
    title: string
    description?: string
    priority?: string
    settingsJson?: Record<string, unknown>
  }) => Promise<void>
  cancelBlueprint: (workspaceId: string) => Promise<string | null>
  respondToApproval: (blueprintId: string, approved: boolean, feedback?: string) => Promise<void>
  sendClarifyAnswer: (blueprintId: string, workspaceId: string, message: string, answers?: Record<string, QuestionAnswerState>) => Promise<void>
  skipClarify: (blueprintId: string) => Promise<void>
  proceedClarifyGate: (blueprintId: string, workspaceId: string) => Promise<void>
  iterateClarify: (blueprintId: string, workspaceId: string) => Promise<void>
  deleteBlueprint: (blueprintId: string, workspaceId: string) => Promise<void>
  retryPhase: (blueprintId: string, workspaceId: string) => Promise<void>
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
  chatMessages: [],
  clarifyRound: 0,
  phaseStartedAt: null,
  lastChunkAt: null,
  phaseStreamText: {},
  phaseStreamEvents: {},
  phaseDurations: {},
  phaseStartTimestamps: {},
  clarifyAwaitingInput: false,
  clarifyFindings: null,
  clarifyQuestions: null,
  clarifyGateReady: false,
  clarifyInFlight: false,
  clarifyBlueprintId: null,
  currentGoal: null,
  taskGoals: {},
  currentTask: null,
  phaseCompletions: {},
  totalTaskCount: 0,
  totalWaves: 0,
  pendingApproval: null,
  currentWave: null,
  waveTasks: {},
  history: [],
  lastError: null,
  orphanedBlueprint: null,
  pendingOnboard: null,

  // ── Actions ──

  setPendingOnboard: (payload) => set({ pendingOnboard: payload }),
  clearPendingOnboard: () => set({ pendingOnboard: null }),

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
        priority: params.priority,
        settingsJson: params.settingsJson
      })) as { id: string }

      // Clear cancelled guard — this blueprint should receive events
      recentlyCancelledIds.delete(result.id)

      useBlueprintStreamStore.getState().reset()
      set({
        isRunning: true,
        activeWorkspaceId: params.workspaceId,
        chatMessages: [],
        clarifyRound: 0,
        phaseStreamText: {},
        phaseStreamEvents: {},
        phaseDurations: {},
        phaseStartTimestamps: {},
        phaseStartedAt: null,
        lastChunkAt: null,
        clarifyAwaitingInput: false,
        clarifyFindings: null,
        clarifyQuestions: null,
        clarifyGateReady: false,
        clarifyBlueprintId: null,
        currentGoal: null,
        taskGoals: {},
        currentTask: null,
        phaseCompletions: {},
        totalTaskCount: 0,
        totalWaves: 0,
        pendingApproval: null,
        currentWave: null,
        waveTasks: {},
        orphanedBlueprint: null
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
    // Capture the blueprint id BEFORE the IPC call so we can guard against
    // late events that arrive after the cancel completes.
    const cancelledBlueprintId = get().currentBlueprint?.id ?? null
    try {
      await window.api.blueprintCancel({ workspaceId })
      // Register cancelled id so event handlers drop late in-flight chunks
      if (cancelledBlueprintId) {
        recentlyCancelledIds.add(cancelledBlueprintId)
      }
      useBlueprintStreamStore.getState().reset()
      set({
        isRunning: false,
        activeWorkspaceId: null,
        currentPhase: null,
        chatMessages: [],
        clarifyRound: 0,
        clarifyAwaitingInput: false,
        clarifyFindings: null,
        clarifyQuestions: null,
        clarifyGateReady: false,
        clarifyBlueprintId: null,
        currentGoal: null,
        taskGoals: {},
        currentTask: null,
        phaseCompletions: {},
        totalTaskCount: 0,
        totalWaves: 0,
        pendingApproval: null,
        currentWave: null,
        waveTasks: {},
        orphanedBlueprint: null
      })
      // Reload blueprint details so status badge shows "Stopped" immediately
      if (cancelledBlueprintId) {
        void get().loadBlueprint(cancelledBlueprintId)
      }
      void get().loadHistory(workspaceId)
      return cancelledBlueprintId
    } catch (error) {
      rendererLog.error('Failed to cancel blueprint:', error)
      return null
    }
  },

  deleteBlueprint: async (blueprintId: string, workspaceId: string) => {
    try {
      // If the pipeline is actively running for this blueprint, cancel first
      const state = get()
      if (state.isRunning && state.currentBlueprint?.id === blueprintId) {
        await get().cancelBlueprint(workspaceId)
      }
      await window.api.blueprintDelete({ id: blueprintId })
      set((s) => ({ history: s.history.filter((b) => b.id !== blueprintId) }))
    } catch (error) {
      rendererLog.error('Failed to delete blueprint:', error)
      set({ lastError: { blueprintId, message: error instanceof Error ? error.message : String(error) } })
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

  sendClarifyAnswer: async (blueprintId: string, workspaceId: string, message: string, answers?: Record<string, QuestionAnswerState>) => {
    if (get().clarifyInFlight) return // B3-FIX: block double-click
    // B3-FIX: Capture prior state for rollback
    const prior = {
      clarifyAwaitingInput: get().clarifyAwaitingInput,
      clarifyQuestions: get().clarifyQuestions
    }
    // Append to chat transcript: structured QA card when answer states are
    // available (option-based answers), plain user bubble for free-text.
    const currentQuestions = get().clarifyQuestions?.questions
    set((state) => {
      const msgs = [...state.chatMessages]
      if (answers && currentQuestions) {
        msgs.push({ type: 'qa' as const, questions: currentQuestions, answers, timestamp: Date.now() })
      } else {
        msgs.push({ type: 'user' as const, content: message, timestamp: Date.now() })
      }
      return {
        chatMessages: msgs,
        clarifyAwaitingInput: false,
        clarifyQuestions: null,
        clarifyInFlight: true
      }
    })
    try {
      await window.api.blueprintClarifyAnswer({ blueprintId, workspaceId, message })
    } catch (error) {
      rendererLog.error('Failed to send clarify answer:', error)
      // B3-FIX: Restore prior state on failure
      set({
        ...prior,
        lastError: { blueprintId, message: error instanceof Error ? error.message : String(error) }
      })
    } finally {
      set({ clarifyInFlight: false })
    }
  },

  skipClarify: async (blueprintId: string) => {
    set({ clarifyAwaitingInput: false, clarifyQuestions: null, clarifyFindings: null, clarifyGateReady: false, clarifyBlueprintId: null })
    try {
      await window.api.blueprintSkipClarify({ blueprintId })
    } catch (error) {
      rendererLog.error('Failed to skip clarify:', error)
    }
  },

  proceedClarifyGate: async (blueprintId: string, workspaceId: string) => {
    if (get().clarifyInFlight) return // B3-FIX: block double-click
    // B3-FIX: Capture prior state for rollback
    const prior = {
      clarifyGateReady: get().clarifyGateReady,
      clarifyQuestions: get().clarifyQuestions,
      clarifyFindings: get().clarifyFindings
    }
    set((state) => ({
      clarifyGateReady: false,
      clarifyQuestions: null,
      clarifyInFlight: true,
      // Audit trail: system message
      chatMessages: [...state.chatMessages, { type: 'system' as const, content: 'Continuing to Plan phase', timestamp: Date.now() }]
    }))
    try {
      await window.api.blueprintClarifyProceed({ blueprintId, workspaceId })
    } catch (error) {
      rendererLog.error('Failed to proceed clarify gate:', error)
      // B3-FIX: Restore prior state on failure
      set({
        ...prior,
        lastError: { blueprintId, message: error instanceof Error ? error.message : String(error) }
      })
    } finally {
      set({ clarifyInFlight: false })
    }
  },

  iterateClarify: async (blueprintId: string, workspaceId: string) => {
    if (get().clarifyInFlight) return // B3-FIX: block double-click
    // B3-FIX: Capture prior state for rollback
    const prior = {
      clarifyGateReady: get().clarifyGateReady,
      clarifyQuestions: get().clarifyQuestions,
      clarifyFindings: get().clarifyFindings
    }
    set((state) => ({
      clarifyGateReady: false,
      clarifyQuestions: null,
      clarifyInFlight: true,
      // Audit trail: system message
      chatMessages: [...state.chatMessages, { type: 'system' as const, content: 'Requested more clarification rounds', timestamp: Date.now() }]
    }))
    try {
      await window.api.blueprintClarifyIterate({ blueprintId, workspaceId })
    } catch (error) {
      rendererLog.error('Failed to iterate clarify:', error)
      // B3-FIX: Restore prior state on failure
      set({
        ...prior,
        lastError: { blueprintId, message: error instanceof Error ? error.message : String(error) }
      })
    } finally {
      set({ clarifyInFlight: false })
    }
  },

  retryPhase: async (blueprintId: string, workspaceId: string) => {
    // Clear cancelled guard — resume must receive events again
    recentlyCancelledIds.delete(blueprintId)
    // Set running state BEFORE await — main emits phaseStart ~22ms into the call;
    // if activeWorkspaceId isn't set, the workspace guard drops the event.
    useBlueprintStreamStore.getState().reset()
    set({
      isRunning: true,
      activeWorkspaceId: workspaceId,
      lastError: null,
      orphanedBlueprint: null,
      chatMessages: [],
      clarifyRound: 0,
      phaseStreamText: {},
      phaseStreamEvents: {},
      phaseDurations: {},
      phaseStartTimestamps: {},
      phaseStartedAt: null,
      lastChunkAt: null,
      clarifyAwaitingInput: false,
      clarifyFindings: null,
      clarifyQuestions: null,
      clarifyGateReady: false,
      clarifyBlueprintId: null,
      currentGoal: null,
      taskGoals: {},
      currentTask: null,
      phaseCompletions: {},
      totalTaskCount: 0,
      totalWaves: 0,
      pendingApproval: null,
      currentWave: null,
      waveTasks: {}
    })
    try {
      await window.api.blueprintRetryPhase({ blueprintId, workspaceId })
    } catch (error) {
      rendererLog.error('Failed to retry blueprint phase:', error)
      // Roll back on error
      set({ isRunning: false, activeWorkspaceId: null })
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

      // B2-FIX: Hydrate clarify UI state on reload when pipeline is at clarify phase
      const clarifyState = (status as Record<string, unknown>).clarifyState as {
        awaitingGate: boolean
        latestFindings: BlueprintState['clarifyFindings']
        pendingQuestions: BlueprintState['clarifyQuestions']
        awaitingInput: boolean
      } | undefined
      if (clarifyState) {
        set({
          clarifyGateReady: clarifyState.awaitingGate,
          clarifyFindings: clarifyState.latestFindings ?? get().clarifyFindings,
          clarifyQuestions: clarifyState.pendingQuestions,
          clarifyAwaitingInput: clarifyState.awaitingInput
        })
      }

      // BP-RESUME-02: Populate orphaned blueprint from enriched pipeline status.
      // Shows a resume banner on startup when a blueprint was interrupted by crash.
      const orphan = (status as Record<string, unknown>).orphanedBlueprint as
        BlueprintState['orphanedBlueprint'] | undefined
      set({ orphanedBlueprint: orphan ?? null })

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
    // Cross-workspace guard + self-healing: ignore events from a different
    // workspace, but adopt if activeWorkspaceId is null and the event
    // matches the currently viewed workspace (race-condition recovery).
    const resolveAction = (eventWorkspaceId: string) => {
      const viewedWsId = useWorkspaceStore.getState().activeWorkspace?.id ?? null
      return resolveBlueprintEventAction(get().activeWorkspaceId, viewedWsId, eventWorkspaceId)
    }

    let streamBuffer: Record<string, string> = {}
    let eventBuffer: Record<string, StreamEvent[]> = {}
    let flushScheduled = false
    let rafId: number | null = null

    // Part E: Throttled blueprint refetch so currentBlueprint.tasks stays fresh
    // across waves without hammering the IPC channel.
    let refetchTimer: ReturnType<typeof setTimeout> | null = null
    const throttledRefetch = (): void => {
      if (refetchTimer) return // trailing throttle already scheduled
      refetchTimer = setTimeout(() => {
        refetchTimer = null
        const bpId = get().currentBlueprint?.id
        if (bpId) void get().loadBlueprint(bpId)
      }, 2000)
    }

    // ── Progressive segment commit (chat-style complete bubbles) ──
    // Same pattern as Grill: when the accumulator finalizes a segment at a
    // heading/tool boundary, commit it as a complete agent chat message so
    // bubbles materialize fully-formed (no growing stream bubble).
    // Raw phase text is accumulated separately for plan/tasks parsing at
    // phase-end (since committed segments get cleared from the stream store).
    let accumulatedPhaseRawText = ''

    const bss = useBlueprintStreamStore.getState()
    bss.setOnSegmentCommit((segment) => {
      const cleanContent = stripBlueprintBlocks(segment.content)
      // Accumulate raw text for plan/tasks parsing at phase boundaries
      accumulatedPhaseRawText += segment.content
      if (cleanContent.trim() || segment.toolActivities.length > 0) {
        set((state) => ({
          chatMessages: [
            ...state.chatMessages,
            {
              type: 'agent' as const,
              content: cleanContent,
              toolActivities: segment.toolActivities,
              timestamp: Date.now()
            }
          ]
        }))
      }
      bss.clearCommittedSegments()
    })

    /** Flush the blueprint stream store and commit accumulated content as an agent chat message. */
    const commitStreamAsAgentMessage = (): void => {
      const bssState = useBlueprintStreamStore.getState()
      bssState.flush()
      const rawContent = getFlatContent(bssState)
      const content = stripBlueprintBlocks(rawContent)
      const toolActivities = getFlatToolActivities(bssState)

      // Accumulate remaining raw text for plan/tasks parsing
      accumulatedPhaseRawText += rawContent

      // Try to parse plan/tasks blocks from the full accumulated phase text
      const parsedPlan = parseBlueprintPlan(accumulatedPhaseRawText)
      const parsedTasks = parseBlueprintTasks(accumulatedPhaseRawText)

      if (content.trim() || toolActivities.length > 0) {
        set((state) => {
          const now = Date.now()
          const msgs = [...state.chatMessages, { type: 'agent' as const, content, toolActivities, timestamp: now }]
          if (parsedPlan) msgs.push({ type: 'plan' as const, plan: parsedPlan, timestamp: now })
          if (parsedTasks) msgs.push({ type: 'tasks' as const, tasks: parsedTasks, timestamp: now })
          return { chatMessages: msgs }
        })
      } else if (parsedPlan || parsedTasks) {
        set((state) => {
          const now = Date.now()
          const msgs = [...state.chatMessages]
          if (parsedPlan) msgs.push({ type: 'plan' as const, plan: parsedPlan, timestamp: now })
          if (parsedTasks) msgs.push({ type: 'tasks' as const, tasks: parsedTasks, timestamp: now })
          return { chatMessages: msgs }
        })
      }
      bssState.reset()
    }

    // ── Phase lifecycle events ──

    safeSubscribe(window.api.onBlueprintPhaseStart, 'onBlueprintPhaseStart', (data) => {
      if (shouldDropCancelledEvent(recentlyCancelledIds, data.blueprintId)) return
      const action = resolveAction(data.workspaceId)
      if (action === 'drop') return
      rendererLog.info(`[blueprint] Phase started: ${data.phase} (action=${action})`)
      const now = Date.now()
      // Reset stream store + accumulated raw text for fresh phase
      accumulatedPhaseRawText = ''
      useBlueprintStreamStore.getState().reset()
      // Part B: Extract totalTasks/totalWaves from build phaseStart payload
      const payloadData = data as Record<string, unknown>
      const phaseTotalTasks = payloadData.totalTasks as number | undefined
      const phaseTotalWaves = payloadData.totalWaves as number | undefined

      set((state) => {
        // System message for EVERY phase start (unified transcript)
        const phaseLabel = data.phase.charAt(0).toUpperCase() + data.phase.slice(1)
        const msgs = [...state.chatMessages, { type: 'system' as const, content: `${phaseLabel} phase started`, timestamp: now }]
        return {
          currentPhase: data.phase as BlueprintPhaseType,
          isRunning: true,
          phaseStartedAt: now,
          lastChunkAt: null,
          chatMessages: msgs,
          // Store phase goal for UI display
          currentGoal: payloadData.goal as string | null ?? null,
          // Part A: Clear current task on phase start
          currentTask: null,
          // Self-heal: adopt the workspace if it wasn't set
          activeWorkspaceId: state.activeWorkspaceId ?? data.workspaceId,
          // Clear old text for this phase so rewinds (reject → re-plan) start fresh
          phaseStreamText: { ...state.phaseStreamText, [data.phase]: '' },
          phaseStreamEvents: { ...state.phaseStreamEvents, [data.phase]: [] },
          // Record per-phase start timestamp for duration calculation
          phaseStartTimestamps: { ...state.phaseStartTimestamps, [data.phase]: now },
          // Part B: Set totals from build phaseStart (authoritative source)
          totalTaskCount: phaseTotalTasks ?? state.totalTaskCount,
          totalWaves: phaseTotalWaves ?? state.totalWaves
        }
      })
    })

    // ── Phase progress (streaming) — ALL phases now feed the stream store ──

    safeSubscribe(window.api.onBlueprintPhaseProgress, 'onBlueprintPhaseProgress', (data) => {
      if (shouldDropCancelledEvent(recentlyCancelledIds, data.blueprintId)) return
      const action = resolveAction(data.workspaceId)
      if (action === 'drop') return
      const key = data.phase
      const kind: StreamEvent['kind'] = (data as Record<string, unknown>).kind === 'tool' ? 'tool' : 'text'

      // Feed the blueprint stream store for chat bubble rendering (ALL phases)
      const bss = useBlueprintStreamStore.getState()
      if (kind === 'tool') {
        // Use real toolActivity from the forwarder when available; fall back
        // to a name-only stub for backward compatibility with old payloads.
        const rawTA = (data as Record<string, unknown>).toolActivity as
          | Record<string, unknown>
          | undefined
        bss.handleStreamChunk({
          type: 'tool_activity',
          toolActivity: rawTA
            ? {
                id: (rawTA.id as string) ?? `tool-${++toolSeq}`,
                toolName: (rawTA.toolName as string) ?? data.text,
                status: (rawTA.status as 'running' | 'completed' | 'error') ?? 'completed',
                input: rawTA.input as string | undefined,
                result: rawTA.result as string | undefined,
                resultDetail: rawTA.resultDetail as string | undefined,
                startedAt: (rawTA.startedAt as number) ?? Date.now(),
                completedAt: rawTA.completedAt as number | undefined,
                elapsedSeconds: rawTA.elapsedSeconds as number | undefined,
                filePath: rawTA.filePath as string | undefined,
                lineRange: rawTA.lineRange as string | undefined,
                operationType: rawTA.operationType as ToolActivity['operationType']
              }
            : {
                id: `tool-${++toolSeq}`,
                toolName: data.text,
                status: 'completed' as const,
                startedAt: Date.now()
              }
        })
      } else {
        bss.handleStreamChunk({ type: 'text', content: data.text })
      }

      if (kind === 'tool') {
        // Tool events append as discrete items
        if (!eventBuffer[key]) eventBuffer[key] = []
        eventBuffer[key].push({ kind: 'tool', content: data.text })
      } else {
        // Text events merge
        streamBuffer[key] = (streamBuffer[key] ?? '') + data.text
        if (!eventBuffer[key]) eventBuffer[key] = []
        // Merge text into last text event or create new one
        const events = eventBuffer[key]
        if (events.length > 0 && events[events.length - 1].kind === 'text') {
          events[events.length - 1].content += data.text
        } else {
          events.push({ kind: 'text', content: data.text })
        }
      }

      // Progress fallback: if currentPhase is null, set it from the event
      // so stream text never accumulates invisibly.
      if (action === 'adopt' || !get().currentPhase) {
        set({
          currentPhase: data.phase as BlueprintPhaseType,
          isRunning: true,
          activeWorkspaceId: get().activeWorkspaceId ?? data.workspaceId
        })
      }

      // Update activity timestamp for stale detection
      set({ lastChunkAt: Date.now() })

      if (!flushScheduled) {
        flushScheduled = true
        rafId = requestAnimationFrame(() => {
          const buffered = streamBuffer
          const bufferedEvents = eventBuffer
          streamBuffer = {}
          eventBuffer = {}
          flushScheduled = false
          rafId = null
          set((state) => {
            const updatedText = { ...state.phaseStreamText }
            const updatedEvents = { ...state.phaseStreamEvents }
            for (const [phase, chunk] of Object.entries(buffered)) {
              updatedText[phase] = (updatedText[phase] ?? '') + chunk
            }
            for (const [phase, events] of Object.entries(bufferedEvents)) {
              updatedEvents[phase] = [...(updatedEvents[phase] ?? []), ...events]
            }
            return { phaseStreamText: updatedText, phaseStreamEvents: updatedEvents }
          })
        })
      }
    })

    // ── Phase complete — commit stream + system message for ALL phases ──

    safeSubscribe(window.api.onBlueprintPhaseComplete, 'onBlueprintPhaseComplete', (data) => {
      if (shouldDropCancelledEvent(recentlyCancelledIds, data.blueprintId)) return
      if (resolveAction(data.workspaceId) === 'drop') return
      rendererLog.info(`[blueprint] Phase complete: ${data.phase} — ${data.status}`)

      // Commit any remaining streamed content as agent bubble (ALL phases)
      commitStreamAsAgentMessage()

      // Record phase duration from start timestamp
      const phaseKey = data.phase as BlueprintPhaseType
      const startTs = get().phaseStartTimestamps[phaseKey]
      const duration = startTs ? Date.now() - startTs : null

      // Store completion metrics if provided
      const completionMetrics = (data as Record<string, unknown>).completionMetrics as Record<string, unknown> | undefined
      const completionData = (data as Record<string, unknown>).completion as Record<string, unknown> | undefined

      // System message with duration
      const phaseLabel = data.phase.charAt(0).toUpperCase() + data.phase.slice(1)
      const durationStr = duration ? ` · ${formatPhaseDuration(duration)}` : ''
      const statusStr = data.status === 'complete' ? 'complete' : data.status
      const systemMsg = `${phaseLabel} phase ${statusStr}${durationStr}`

      set((state) => ({
        phaseDurations: duration
          ? { ...state.phaseDurations, [phaseKey]: duration }
          : state.phaseDurations,
        phaseCompletions: (completionMetrics || completionData)
          ? { ...state.phaseCompletions, [phaseKey]: completionMetrics ?? completionData ?? {} }
          : state.phaseCompletions,
        chatMessages: [...state.chatMessages, { type: 'system' as const, content: systemMsg, timestamp: Date.now() }]
      }))

      // If the pipeline-level status is 'complete' or 'failed', mark as not running
      if (data.status === 'complete' && data.phase === 'verify') {
        const wsId = get().activeWorkspaceId
        // BP-SNAPSHOT-RESURRECTION-GUARD: Record terminal completion timestamp
        // so applySnapshot can reject stale phase-running snapshots.
        if (wsId) terminalPhaseSeenAt.set(wsId, Date.now())
        set({ isRunning: false, activeWorkspaceId: null })
        if (wsId) void get().loadHistory(wsId)
      }
      if (data.status === 'failed') {
        const wsId = get().activeWorkspaceId
        // BP-SNAPSHOT-RESURRECTION-GUARD: Also record terminal timestamp on failure
        // so stale phase-running snapshots don't resurrect the UI.
        if (wsId && data.phase === 'verify') terminalPhaseSeenAt.set(wsId, Date.now())
        const errorMsg = (data as Record<string, unknown>).error
          ? String((data as Record<string, unknown>).error)
          : null
        set({
          isRunning: false,
          activeWorkspaceId: null,
          lastError: errorMsg
            ? { blueprintId: data.blueprintId, message: errorMsg }
            : null
        })
        if (wsId) void get().loadHistory(wsId)
      }
    })

    safeSubscribe(window.api.onBlueprintPhaseArtifact, 'onBlueprintPhaseArtifact', (data) => {
      if (shouldDropCancelledEvent(recentlyCancelledIds, data.blueprintId)) return
      if (resolveAction(data.workspaceId) === 'drop') return
      rendererLog.info(`[blueprint] Phase artifact: ${data.phase} — ${data.artifact.type}`)
    })

    // ── Clarify-specific events ──

    safeSubscribe(window.api.onBlueprintClarifyAwaitingInput, 'onBlueprintClarifyAwaitingInput', (data) => {
      if (shouldDropCancelledEvent(recentlyCancelledIds, data.blueprintId)) return
      if (resolveAction(data.workspaceId) === 'drop') return
      rendererLog.info(`[blueprint] Clarify awaiting input for ${data.blueprintId}`)
      // Commit streamed content as agent bubble
      commitStreamAsAgentMessage()
      // Only set awaitingInput if no questions are already pending (questions win)
      if (!get().clarifyQuestions) {
        set({ clarifyAwaitingInput: true, clarifyBlueprintId: data.blueprintId })
      }
    })

    safeSubscribe(
      window.api.onBlueprintClarifyFindings as ((cb: (data: unknown) => void) => () => void) | undefined,
      'onBlueprintClarifyFindings',
      (data: unknown) => {
        const payload = data as { blueprintId: string; workspaceId: string; findings: unknown }
        if (shouldDropCancelledEvent(recentlyCancelledIds, payload.blueprintId)) return
        if (resolveAction(payload.workspaceId) === 'drop') return
        rendererLog.info(`[blueprint] Clarify findings for ${payload.blueprintId}`)
        const findings = payload.findings as ClarifyFindingsBlock
        // Commit streamed intro text as agent bubble BEFORE the findings card
        // so transcript order is: agent intro → findings (same as questions handler)
        commitStreamAsAgentMessage()
        // Append findings as a transcript message (each round stays visible)
        set((state) => ({
          clarifyFindings: findings,
          clarifyRound: state.clarifyRound + 1,
          clarifyBlueprintId: payload.blueprintId,
          chatMessages: [
            ...state.chatMessages,
            { type: 'findings' as const, findings, round: state.clarifyRound + 1, timestamp: Date.now() }
          ]
        }))
      }
    )

    safeSubscribe(
      window.api.onBlueprintClarifyQuestions as ((cb: (data: unknown) => void) => () => void) | undefined,
      'onBlueprintClarifyQuestions',
      (data: unknown) => {
        const payload = data as { blueprintId: string; workspaceId: string; questions: unknown }
        if (shouldDropCancelledEvent(recentlyCancelledIds, payload.blueprintId)) return
        if (resolveAction(payload.workspaceId) === 'drop') return
        rendererLog.info(`[blueprint] Clarify questions for ${payload.blueprintId}`)
        // Commit streamed content as agent bubble
        commitStreamAsAgentMessage()
        // Questions beat awaitingInput (per plan item 5)
        set({
          clarifyQuestions: payload.questions as ClarifyQuestionsBlock,
          clarifyAwaitingInput: false,
          clarifyBlueprintId: payload.blueprintId
        })
      }
    )

    safeSubscribe(
      window.api.onBlueprintClarifyGate as ((cb: (data: unknown) => void) => () => void) | undefined,
      'onBlueprintClarifyGate',
      (data: unknown) => {
        const payload = data as { blueprintId: string; workspaceId: string; findings: unknown }
        if (shouldDropCancelledEvent(recentlyCancelledIds, payload.blueprintId)) return
        if (resolveAction(payload.workspaceId) === 'drop') return
        rendererLog.info(`[blueprint] Clarify gate ready for ${payload.blueprintId}`)
        // Commit streamed content as agent bubble
        commitStreamAsAgentMessage()
        // B1-FIX: Don't wipe findings with null — keep prior-round findings
        const incomingFindings = payload.findings as BlueprintState['clarifyFindings']
        set({
          clarifyGateReady: true,
          clarifyQuestions: null,
          clarifyAwaitingInput: false,
          clarifyFindings: incomingFindings ?? get().clarifyFindings,
          clarifyBlueprintId: payload.blueprintId
        })
      }
    )

    // ── Approval ──

    safeSubscribe(window.api.onBlueprintApprovalNeeded, 'onBlueprintApprovalNeeded', (data) => {
      if (shouldDropCancelledEvent(recentlyCancelledIds, data.blueprintId)) return
      if (resolveAction(data.workspaceId) === 'drop') return
      rendererLog.info(`[blueprint] Approval needed for ${data.blueprintId}`)
      // Commit stream before the gate so transcript is finalized
      commitStreamAsAgentMessage()
      set((state) => ({
        pendingApproval: {
          blueprintId: data.blueprintId,
          planSummary: data.planSummary,
          completion: data.completion ? (data.completion as Record<string, unknown>) : undefined,
          reviewMarkdown: data.reviewMarkdown
        },
        chatMessages: [
          ...state.chatMessages,
          { type: 'system' as const, content: 'Awaiting approval — review the plan before building', timestamp: Date.now() }
        ]
      }))
    })

    // ── Build wave events → system messages ──

    safeSubscribe(window.api.onBlueprintWaveStart, 'onBlueprintWaveStart', (data) => {
      if (shouldDropCancelledEvent(recentlyCancelledIds, data.blueprintId)) return
      if (resolveAction(data.workspaceId) === 'drop') return
      rendererLog.info(`[blueprint] Wave ${data.wave} started (${data.taskCount} tasks)`)
      set((state) => ({
        currentWave: { wave: data.wave, taskCount: data.taskCount },
        // Part B: totalTaskCount now comes from phaseStart — don't overwrite here.
        // Fallback for historical runs: use currentBlueprint.tasks.length via totalTaskCount default.
        waveTasks: {},
        chatMessages: [
          ...state.chatMessages,
          { type: 'system' as const, content: `Wave ${data.wave} started — ${data.taskCount} tasks`, timestamp: Date.now() }
        ]
      }))
    })

    safeSubscribe(window.api.onBlueprintWaveTaskStart, 'onBlueprintWaveTaskStart', (data) => {
      if (shouldDropCancelledEvent(recentlyCancelledIds, data.blueprintId)) return
      if (resolveAction(data.workspaceId) === 'drop') return
      rendererLog.info(`[blueprint] Wave ${data.wave} task ${data.taskId} started`)
      const taskGoal = (data as Record<string, unknown>).goal as string | undefined
      set((state) => ({
        waveTasks: { ...state.waveTasks, [data.taskId]: 'running' as const },
        // Part A: Don't overwrite currentGoal — keep phase goal in header.
        // Store per-task goal in taskGoals for the panel detail view.
        taskGoals: taskGoal
          ? { ...state.taskGoals, [data.taskId]: taskGoal }
          : state.taskGoals,
        // Part A: Track currently executing task for header chip.
        currentTask: { taskId: data.taskId, description: data.description }
      }))
      // Part E: Refresh currentBlueprint.tasks from DB for accurate statuses
      throttledRefetch()
    })

    safeSubscribe(window.api.onBlueprintWaveTaskComplete, 'onBlueprintWaveTaskComplete', (data) => {
      if (shouldDropCancelledEvent(recentlyCancelledIds, data.blueprintId)) return
      if (resolveAction(data.workspaceId) === 'drop') return
      rendererLog.info(`[blueprint] Wave ${data.wave} task ${data.taskId} ${data.status}`)
      set((state) => ({
        waveTasks: {
          ...state.waveTasks,
          [data.taskId]: data.status as BlueprintTaskStatus
        },
        // Part A: Clear current task on completion
        currentTask: state.currentTask?.taskId === data.taskId ? null : state.currentTask
      }))
      // Part E: Refresh currentBlueprint.tasks from DB for accurate statuses
      throttledRefetch()
    })

    safeSubscribe(window.api.onBlueprintWaveComplete, 'onBlueprintWaveComplete', (data) => {
      if (shouldDropCancelledEvent(recentlyCancelledIds, data.blueprintId)) return
      if (resolveAction(data.workspaceId) === 'drop') return
      rendererLog.info(`[blueprint] Wave ${data.wave} complete — ${data.status}`)
      set((state) => ({
        // Part A: Clear current task on wave complete
        currentTask: null,
        chatMessages: [
          ...state.chatMessages,
          { type: 'system' as const, content: `Wave ${data.wave} complete — ${data.status}`, timestamp: Date.now() }
        ]
      }))
      // Part E: Refresh currentBlueprint.tasks from DB for accurate statuses
      throttledRefetch()
      if (data.status === 'failed') {
        const wsId = get().activeWorkspaceId
        set({ isRunning: false, activeWorkspaceId: null })
        if (wsId) void get().loadHistory(wsId)
      }
    })

    // ── M2/M7: Whole-state snapshot sync ──
    // One handler that receives the complete pipeline state from main.
    // Drops stale snapshots (seq ≤ last seen per workspace). Overwrites
    // state-mutation fields from the snapshot, keeping chat transcript and
    // stream data untouched.
    // M7: Track seq per workspace so workspace switches don't reject snapshots.
    const lastSnapshotSeqByWorkspace = new Map<string, number>()
    // BP-SNAPSHOT-RESURRECTION-GUARD: Track when a terminal verify phaseComplete
    // is processed. Snapshots arriving within 10s with machineState='phase-running'
    // but snap.running=false are stale — the session.stop() window emits them
    // before the correcting idle snapshot arrives.
    const terminalPhaseSeenAt = new Map<string, number>()

    // M7: Apply a snapshot to the store (shared by push + pull paths)
    const applySnapshot = (snap: Parameters<Parameters<typeof window.api.onBlueprintStateSync>[0]>[0]): void => {
      // Drop stale/reordered snapshots (per-workspace tracking)
      const lastSeq = lastSnapshotSeqByWorkspace.get(snap.workspaceId) ?? -1
      if (snap.seq <= lastSeq) return
      lastSnapshotSeqByWorkspace.set(snap.workspaceId, snap.seq)

      // Workspace guard: only process snapshots for our active workspace
      const viewedWsId = useWorkspaceStore.getState().activeWorkspace?.id ?? null
      const activeWsId = get().activeWorkspaceId
      if (activeWsId && snap.workspaceId !== activeWsId) return
      if (!activeWsId && viewedWsId && snap.workspaceId !== viewedWsId) return

      // Derive store state from snapshot
      const machineState = snap.machineState as BlueprintMachineState

      // BP-SNAPSHOT-RESURRECTION-GUARD: After a terminal verify phaseComplete,
      // ignore stale 'phase-running' snapshots published during session.stop()
      // window (< 10s). These would otherwise resurrect isRunning=true and the
      // "Analyzing…" bubble permanently (combined with bug where session.stop()
      // failure skips markPipelineStopped).
      const terminalTs = terminalPhaseSeenAt.get(snap.workspaceId)
      if (
        terminalTs &&
        machineState === 'phase-running' &&
        !snap.running &&
        Date.now() - terminalTs < 10_000
      ) {
        rendererLog.info('[blueprint] Dropping stale phase-running snapshot after terminal completion')
        return
      }

      // COHERENT-SNAPSHOT-FIX (defense in depth): idle/failed/cancelled +
      // running:true is impossible during correct operation, but if a stale
      // snapshot sneaks through, this prevents permanent "Analyzing…".
      const IDLE_OR_TERMINAL: BlueprintMachineState[] = ['idle', 'failed', 'cancelled']
      const isRunning = machineState === 'phase-running'
        || (snap.running && !IDLE_OR_TERMINAL.includes(machineState))
      const isClarifyGate = machineState === 'awaiting-clarify-gate'
      const isClarifyQuestions = machineState === 'awaiting-clarify-questions'
      const isClarifyInput = machineState === 'awaiting-clarify-input'

      set({
        // Pipeline state — overwritten from snapshot
        isRunning,
        currentPhase: snap.currentPhase as BlueprintPhaseType | null,
        // Clarify state — derived from machine state + snapshot data
        clarifyGateReady: isClarifyGate,
        clarifyQuestions: isClarifyQuestions
          ? (snap.clarifyQuestions as ClarifyQuestionsBlock | null)
          : null,
        clarifyAwaitingInput: isClarifyInput,
        clarifyFindings: snap.clarifyFindings as ClarifyFindingsBlock | null,
        // Approval state
        pendingApproval: snap.pendingApproval
          ? {
              blueprintId: snap.blueprintId ?? '',
              planSummary: snap.pendingApproval.planSummary,
              completion: snap.pendingApproval.completion,
              reviewMarkdown: snap.pendingApproval.reviewMarkdown
            }
          : null,
        // Wave state
        currentWave: snap.wave
          ? { wave: snap.wave.wave, taskCount: snap.wave.taskCount }
          : null,
        waveTasks: snap.wave?.tasks
          ? (snap.wave.tasks as Record<string, BlueprintTaskStatus>)
          : {},
        // Error state
        lastError: snap.lastError
          ? { blueprintId: snap.blueprintId ?? 'unknown', message: snap.lastError }
          : null,
        // Self-healing: adopt workspace if none active
        ...(activeWsId ? {} : { activeWorkspaceId: snap.workspaceId })
      })
    }

    // Push-based: subscribe to live snapshots
    safeSubscribe(window.api.onBlueprintStateSync, 'onBlueprintStateSync', applySnapshot)

    // M7: Pull-based seed — fetch initial snapshot on mount so renderer
    // doesn't wait for the next state mutation to hydrate.
    const viewedWsId = useWorkspaceStore.getState().activeWorkspace?.id
    if (viewedWsId && typeof window.api.blueprintGetSnapshot === 'function') {
      window.api.blueprintGetSnapshot({ workspaceId: viewedWsId })
        .then((snap) => {
          if (snap) applySnapshot(snap)
        })
        .catch((err) => {
          rendererLog.warn('[blueprint] Pull snapshot failed:', err)
        })
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (refetchTimer) clearTimeout(refetchTimer)
      useBlueprintStreamStore.getState().setOnSegmentCommit(null)
      cleanups.forEach((fn) => fn())
    }
  },

  reset: () => {
    useBlueprintStreamStore.getState().reset()
    set({
      isRunning: false,
      activeWorkspaceId: null,
      currentBlueprint: null,
      currentPhase: null,
      chatMessages: [],
      clarifyRound: 0,
      phaseStartedAt: null,
      lastChunkAt: null,
      phaseStreamText: {},
      phaseStreamEvents: {},
      phaseDurations: {},
      phaseStartTimestamps: {},
      clarifyAwaitingInput: false,
      clarifyFindings: null,
      clarifyQuestions: null,
      clarifyGateReady: false,
      clarifyInFlight: false,
      clarifyBlueprintId: null,
      currentGoal: null,
      taskGoals: {},
      currentTask: null,
      phaseCompletions: {},
      totalTaskCount: 0,
      totalWaves: 0,
      pendingApproval: null,
      currentWave: null,
      waveTasks: {},
      history: [],
      lastError: null,
      orphanedBlueprint: null
    })
  }
}))
