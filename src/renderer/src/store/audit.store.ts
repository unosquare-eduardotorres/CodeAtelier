import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import {
  StreamSegmentAccumulator,
  type SegmentState
} from '@renderer/utils/stream-segment-accumulator'
import type {
  AuditRun,
  AuditMode,
  AuditTrackId,
  AuditFinding,
  AuditProgressEvent,
  AuditResult,
  AuditStreamChunkEvent,
  AuditIntermediateEvent,
  AuditSelectedSkills,
  AuditPlanRecord,
  LLMProvider,
  ToolActivity
} from '../../../shared/types'

// ── Per-track streaming internals ───────────────────────────────────────────

/**
 * Manages StreamSegmentAccumulator instances per audit track — keeps timers
 * and mutable state outside the reactive Zustand store.
 */
class AuditStreamingInternals {
  private accumulators = new Map<string, StreamSegmentAccumulator>()
  private storeGet: (() => AuditState) | null = null
  private storeSet: ((partial: Partial<AuditState>) => void) | null = null

  bind(get: () => AuditState, set: (partial: Partial<AuditState>) => void): void {
    this.storeGet = get
    this.storeSet = set
  }

  getOrCreateAccumulator(trackId: string): StreamSegmentAccumulator {
    if (!this.accumulators.has(trackId)) {
      this.accumulators.set(
        trackId,
        new StreamSegmentAccumulator((state: SegmentState) => {
          const current = this.storeGet?.()
          if (!current) return
          this.storeSet?.({
            perTrackStreaming: {
              ...current.perTrackStreaming,
              [trackId]: state
            }
          })
        })
      )
    }
    return this.accumulators.get(trackId)!
  }

  flushTrack(trackId: string): void {
    this.accumulators.get(trackId)?.flush()
  }

  resetTrack(trackId: string): void {
    this.accumulators.get(trackId)?.reset()
    this.accumulators.delete(trackId)
  }

  resetAll(): void {
    this.accumulators.forEach((a) => a.reset())
    this.accumulators.clear()
  }
}

const auditInternals = new AuditStreamingInternals()

// ── Store interface ──────────────────────────────────────────────────────────

interface AuditState {
  currentRun: AuditRun | null
  isRunning: boolean
  isPaused: boolean
  rerunningTrackId: AuditTrackId | null
  liveStreamText: Record<string, string> // trackId → live text (legacy, still used by progress)
  selectedFindings: AuditFinding[] // for "Fix in Chat" / Build Plan
  pendingFixContext: {
    title: string
    description: string
    autoSend?: boolean
    sourceAuditRunId?: string
  } | null
  // Plan generation
  currentPlan: AuditPlanRecord | null
  isGeneratingPlan: boolean

  // Per-track segment-based streaming state
  perTrackStreaming: Record<string, SegmentState>

  // Actions
  loadLatest: (workspaceId: string) => Promise<void>
  openRun: (run: AuditRun) => void
  startAudit: (
    workspaceId: string,
    mode: AuditMode,
    tracks: AuditTrackId[],
    llmProvider?: LLMProvider,
    selectedSkills?: AuditSelectedSkills
  ) => Promise<void>
  cancelAudit: () => Promise<void>
  pauseAudit: () => Promise<void>
  resumeAudit: (workspaceId: string) => Promise<void>
  rerunTrack: (workspaceId: string, trackId: AuditTrackId, mode: AuditMode) => Promise<void>
  toggleFinding: (finding: AuditFinding) => void
  selectAllInTrack: (trackId: AuditTrackId, severity?: AuditFinding['severity']) => void
  selectAllAcrossTracks: () => void
  clearSelectedFindings: () => void
  generatePlan: (workspaceId: string) => Promise<AuditPlanRecord>
  clearPlan: () => void
  setPendingFixContext: (
    ctx: { title: string; description: string; autoSend?: boolean; sourceAuditRunId?: string } | null
  ) => void
  convertFindings: (workspaceId: string) => Promise<string> // returns conversationId
  handleProgress: (data: AuditProgressEvent) => void
  handleResult: (data: AuditResult) => void
  handleComplete: (data: AuditRun) => void
  handleStreamChunk: (data: AuditStreamChunkEvent) => void
  handleIntermediate: (data: AuditIntermediateEvent) => void
  reset: () => void
}

export const useAuditStore = create<AuditState>((set, get) => {
  // Bind internals on store creation
  auditInternals.bind(get, (partial) => set(partial))

  return {
    currentRun: null,
    isRunning: false,
    isPaused: false,
    rerunningTrackId: null,
    liveStreamText: {},
    selectedFindings: [],
    pendingFixContext: null,
    currentPlan: null,
    isGeneratingPlan: false,
    perTrackStreaming: {},

    openRun: (run) => {
      auditInternals.resetAll()
      set({
        currentRun: run,
        isRunning: false,
        isPaused: false,
        rerunningTrackId: null,
        liveStreamText: {},
        perTrackStreaming: {},
        selectedFindings: [],
        currentPlan: null
      })
    },

    loadLatest: async (workspaceId) => {
      try {
        const run = await window.api.auditGetLatest({ workspaceId })
        // Sync isRunning with the DB state so the status bar reflects reality
        // (e.g. after app restart while an audit was in progress).
        const isTerminal =
          !run || ['completed', 'partial', 'cancelled', 'failed'].includes(run.status)
        set({
          currentRun: run,
          isRunning: !isTerminal,
          ...(isTerminal ? { rerunningTrackId: null } : {})
        })
      } catch (error) {
        rendererLog.error('Failed to load latest audit:', error)
      }
    },

    startAudit: async (workspaceId, mode, tracks, llmProvider?, selectedSkills?) => {
      try {
        auditInternals.resetAll()
        set({
          isRunning: true,
          isPaused: false,
          liveStreamText: {},
          perTrackStreaming: {},
          selectedFindings: []
        })
        const run = await window.api.auditStart({
          workspaceId,
          mode,
          tracks,
          llmProvider,
          selectedSkills
        })
        set({ currentRun: run })
      } catch (error) {
        rendererLog.error('Failed to start audit:', error)
        set({ isRunning: false })
        throw error
      }
    },

    cancelAudit: async () => {
      try {
        await window.api.auditCancel()
      } catch (error) {
        rendererLog.error('Failed to cancel audit:', error)
      }
    },

    pauseAudit: async () => {
      try {
        await window.api.auditCancel()
        set({ isPaused: true })
      } catch (error) {
        rendererLog.error('Failed to pause audit:', error)
      }
    },

    resumeAudit: async (workspaceId) => {
      try {
        // Reset streaming state for incomplete tracks
        const current = get()
        const resumableTracks =
          current.currentRun?.results
            .filter(
              (r) => r.status === 'cancelled' || r.status === 'pending' || r.status === 'failed'
            )
            .map((r) => r.trackId) ?? []

        for (const trackId of resumableTracks) {
          auditInternals.resetTrack(trackId)
        }

        set({ isRunning: true, isPaused: false })
        const run = await window.api.auditResume({ workspaceId })
        if (run) set({ currentRun: run })
      } catch (error) {
        rendererLog.error('Failed to resume audit:', error)
        set({ isRunning: false })
        throw error
      }
    },

    rerunTrack: async (workspaceId, trackId, mode) => {
      try {
        auditInternals.resetTrack(trackId)
        set((s) => {
          // Optimistically mark result as 'running' and set rerunningTrackId
          const updatedResults = s.currentRun
            ? s.currentRun.results.map((r) =>
                r.trackId === trackId ? { ...r, status: 'running' as const } : r
              )
            : []
          const newStreaming = { ...s.perTrackStreaming }
          delete newStreaming[trackId]
          return {
            rerunningTrackId: trackId,
            liveStreamText: { ...s.liveStreamText, [trackId]: '' },
            perTrackStreaming: newStreaming,
            ...(s.currentRun ? { currentRun: { ...s.currentRun, results: updatedResults } } : {})
          }
        })
        await window.api.auditRerunTrack({ workspaceId, trackId, mode })
      } catch (error) {
        rendererLog.error('Failed to rerun track:', error)
        set({ rerunningTrackId: null })
        throw error
      }
    },

    toggleFinding: (finding) => {
      set((s) => {
        const exists = s.selectedFindings.some((f) => f.id === finding.id)
        if (exists) {
          return { selectedFindings: s.selectedFindings.filter((f) => f.id !== finding.id) }
        }
        // No cap — selection spans all tracks.
        return { selectedFindings: [...s.selectedFindings, finding] }
      })
    },

    selectAllInTrack: (trackId, severity) => {
      set((s) => {
        const result = s.currentRun?.results.find((r) => r.trackId === trackId)
        if (!result) return s
        const toAdd = result.findings.filter((f) =>
          severity ? f.severity === severity : f.severity !== 'info'
        )
        const byId = new Map(s.selectedFindings.map((f) => [f.id, f]))
        for (const f of toAdd) byId.set(f.id, f)
        return { selectedFindings: [...byId.values()] }
      })
    },

    selectAllAcrossTracks: () => {
      set((s) => {
        if (!s.currentRun) return s
        const byId = new Map(s.selectedFindings.map((f) => [f.id, f]))
        for (const r of s.currentRun.results) {
          if (r.status !== 'completed') continue
          for (const f of r.findings) {
            if (f.severity !== 'info') byId.set(f.id, f)
          }
        }
        return { selectedFindings: [...byId.values()] }
      })
    },

    clearSelectedFindings: () => set({ selectedFindings: [] }),

    generatePlan: async (workspaceId) => {
      const { currentRun, selectedFindings } = get()
      if (!currentRun) throw new Error('No audit run loaded')
      if (selectedFindings.length === 0) throw new Error('No findings selected')
      set({ isGeneratingPlan: true })
      try {
        const plan = await window.api.auditGeneratePlan({
          workspaceId,
          runId: currentRun.id,
          findings: selectedFindings
        })
        set({ currentPlan: plan, isGeneratingPlan: false })
        return plan
      } catch (error) {
        rendererLog.error('Failed to generate audit plan:', error)
        set({ isGeneratingPlan: false })
        throw error
      }
    },

    clearPlan: () => set({ currentPlan: null }),

    setPendingFixContext: (ctx) => set({ pendingFixContext: ctx }),

    convertFindings: async (workspaceId) => {
      const { selectedFindings } = get()
      if (selectedFindings.length === 0) throw new Error('No findings selected')

      const result = await window.api.auditConvertFindings({
        workspaceId,
        findings: selectedFindings
      })

      set({ selectedFindings: [] })
      return result.conversationId
    },

    handleProgress: (data) => {
      set((s) => {
        // Update live stream text
        const newStreamText = { ...s.liveStreamText }
        if (data.streamChunk) {
          newStreamText[data.trackId] = (newStreamText[data.trackId] ?? '') + data.streamChunk
        }

        // Update result status in currentRun
        if (!s.currentRun) return { liveStreamText: newStreamText }

        const updatedResults = s.currentRun.results.map((r) =>
          r.trackId === data.trackId ? { ...r, status: data.status } : r
        )

        return {
          liveStreamText: newStreamText,
          currentRun: { ...s.currentRun, results: updatedResults }
        }
      })
    },

    handleResult: (data) => {
      // Flush any remaining buffered content for this track
      auditInternals.flushTrack(data.trackId)

      set((s) => {
        if (!s.currentRun) return s

        const updatedResults = s.currentRun.results.map((r) =>
          r.trackId === data.trackId ? data : r
        )

        // Clear live stream text for this track
        const newStreamText = { ...s.liveStreamText }
        delete newStreamText[data.trackId]

        return {
          currentRun: { ...s.currentRun, results: updatedResults },
          liveStreamText: newStreamText,
          // Clear rerunningTrackId when the matching track result arrives
          rerunningTrackId: s.rerunningTrackId === data.trackId ? null : s.rerunningTrackId
        }
      })
    },

    handleComplete: (data) => {
      auditInternals.resetAll()
      const wasPaused = get().isPaused
      set({
        currentRun: data,
        isRunning: false,
        isPaused: wasPaused, // preserve — don't blindly clear on complete
        rerunningTrackId: null,
        liveStreamText: {},
        perTrackStreaming: {}
      })
    },

    handleStreamChunk: (data) => {
      if (data.type === 'text' && data.content) {
        auditInternals.getOrCreateAccumulator(data.trackId).appendText(data.content)
      } else if (data.type === 'tool_activity' && data.toolActivity) {
        const activity = data.toolActivity as ToolActivity & { id: string; toolName: string }
        auditInternals.getOrCreateAccumulator(data.trackId).handleToolActivity(activity)
      }
    },

    handleIntermediate: (data) => {
      set((s) => {
        if (!s.currentRun) return s

        // Merge intermediate findings into the running track's result
        const updatedResults = s.currentRun.results.map((r) => {
          if (r.trackId !== data.trackId) return r
          return {
            ...r,
            findings: data.findings,
            coverageStats: data.coverageStats,
            summary: `Round ${data.roundNumber}/${data.totalRounds}: ${data.findings.length} finding(s), ${data.coverageStats.fileCount} files inspected`,
            roundProgress: {
              roundNumber: data.roundNumber,
              totalRounds: data.totalRounds,
              totalFiles: data.totalFiles,
              batchSize: data.batchSize
            }
          }
        })

        return {
          currentRun: { ...s.currentRun, results: updatedResults }
        }
      })
    },

    reset: () => {
      auditInternals.resetAll()
      set({
        currentRun: null,
        isRunning: false,
        isPaused: false,
        rerunningTrackId: null,
        liveStreamText: {},
        perTrackStreaming: {},
        selectedFindings: [],
        pendingFixContext: null,
        currentPlan: null,
        isGeneratingPlan: false
      })
    }
  }
})
