import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import { SentenceBuffer } from '@renderer/utils/sentence-buffer'
import type {
  AuditRun,
  AuditMode,
  AuditTrackId,
  AuditFinding,
  AuditProgressEvent,
  AuditResult,
  AuditStreamChunkEvent,
  ToolActivity
} from '../../../shared/types'

// ── Per-track streaming state ────────────────────────────────────────────────

interface TrackStreamingState {
  content: string // sentence-buffered markdown text
  toolActivities: ToolActivity[] // running/completed tools
}

/**
 * Manages SentenceBuffer instances per audit track — keeps timers and mutable
 * state outside the reactive Zustand store (same pattern as ChatStreamingInternals).
 */
class AuditStreamingInternals {
  private buffers = new Map<string, SentenceBuffer>()
  private storeGet: (() => AuditState) | null = null
  private storeSet: ((partial: Partial<AuditState>) => void) | null = null

  bind(get: () => AuditState, set: (partial: Partial<AuditState>) => void): void {
    this.storeGet = get
    this.storeSet = set
  }

  getOrCreateBuffer(trackId: string): SentenceBuffer {
    if (!this.buffers.has(trackId)) {
      this.buffers.set(
        trackId,
        new SentenceBuffer((sentences: string) => {
          const current = this.storeGet?.()
          if (!current) return
          const track = current.perTrackStreaming[trackId] ?? { content: '', toolActivities: [] }
          this.storeSet?.({
            perTrackStreaming: {
              ...current.perTrackStreaming,
              [trackId]: { ...track, content: track.content + sentences }
            }
          })
        })
      )
    }
    return this.buffers.get(trackId)!
  }

  flushTrack(trackId: string): void {
    this.buffers.get(trackId)?.flush()
  }

  resetTrack(trackId: string): void {
    this.buffers.get(trackId)?.reset()
    this.buffers.delete(trackId)
  }

  resetAll(): void {
    this.buffers.forEach((b) => b.reset())
    this.buffers.clear()
  }
}

const auditInternals = new AuditStreamingInternals()

// ── Store interface ──────────────────────────────────────────────────────────

interface AuditState {
  currentRun: AuditRun | null
  isRunning: boolean
  rerunningTrackId: AuditTrackId | null
  liveStreamText: Record<string, string> // trackId → live text (legacy, still used by progress)
  selectedFindings: AuditFinding[] // for "Fix in Chat"

  // Per-track chat-like streaming state
  perTrackStreaming: Record<string, TrackStreamingState>

  // Actions
  loadLatest: (workspaceId: string) => Promise<void>
  startAudit: (workspaceId: string, mode: AuditMode, tracks: AuditTrackId[]) => Promise<void>
  cancelAudit: () => Promise<void>
  rerunTrack: (workspaceId: string, trackId: AuditTrackId, mode: AuditMode) => Promise<void>
  toggleFinding: (finding: AuditFinding) => void
  clearSelectedFindings: () => void
  convertFindings: (workspaceId: string) => Promise<string> // returns conversationId
  handleProgress: (data: AuditProgressEvent) => void
  handleResult: (data: AuditResult) => void
  handleComplete: (data: AuditRun) => void
  handleStreamChunk: (data: AuditStreamChunkEvent) => void
  reset: () => void
}

export const useAuditStore = create<AuditState>((set, get) => {
  // Bind internals on store creation
  auditInternals.bind(get, (partial) => set(partial))

  return {
    currentRun: null,
    isRunning: false,
    rerunningTrackId: null,
    liveStreamText: {},
    selectedFindings: [],
    perTrackStreaming: {},

    loadLatest: async (workspaceId) => {
      try {
        const run = await window.api.auditGetLatest({ workspaceId })
        // Sync isRunning: if the DB shows a terminal state, ensure store reflects it.
        // This fixes stale spinner when navigating away during a run and coming back.
        const isTerminal = !run || ['completed', 'partial', 'cancelled', 'failed'].includes(run.status)
        set({
          currentRun: run,
          ...(isTerminal ? { isRunning: false, rerunningTrackId: null } : {})
        })
      } catch (error) {
        rendererLog.error('Failed to load latest audit:', error)
      }
    },

    startAudit: async (workspaceId, mode, tracks) => {
      try {
        auditInternals.resetAll()
        set({ isRunning: true, liveStreamText: {}, perTrackStreaming: {}, selectedFindings: [] })
        const run = await window.api.auditStart({ workspaceId, mode, tracks })
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
        // Max 10 selections
        if (s.selectedFindings.length >= 10) return s
        return { selectedFindings: [...s.selectedFindings, finding] }
      })
    },

    clearSelectedFindings: () => set({ selectedFindings: [] }),

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
      set({
        currentRun: data,
        isRunning: false,
        rerunningTrackId: null,
        liveStreamText: {},
        perTrackStreaming: {}
      })
    },

    handleStreamChunk: (data) => {
      if (data.type === 'text' && data.content) {
        auditInternals.getOrCreateBuffer(data.trackId).append(data.content)
      } else if (data.type === 'tool_activity' && data.toolActivity) {
        set((s) => {
          const track = s.perTrackStreaming[data.trackId] ?? { content: '', toolActivities: [] }
          const existingIdx = track.toolActivities.findIndex((a) => a.id === data.toolActivity!.id)
          let updatedActivities: ToolActivity[]
          if (existingIdx >= 0) {
            // Update existing (tool_result / tool_progress)
            updatedActivities = [...track.toolActivities]
            updatedActivities[existingIdx] = {
              ...updatedActivities[existingIdx],
              ...data.toolActivity
            } as ToolActivity
          } else {
            // New tool_use
            updatedActivities = [...track.toolActivities, data.toolActivity as ToolActivity]
          }
          return {
            perTrackStreaming: {
              ...s.perTrackStreaming,
              [data.trackId]: { ...track, toolActivities: updatedActivities }
            }
          }
        })
      }
    },

    reset: () => {
      auditInternals.resetAll()
      set({
        currentRun: null,
        isRunning: false,
        rerunningTrackId: null,
        liveStreamText: {},
        perTrackStreaming: {},
        selectedFindings: []
      })
    }
  }
})
