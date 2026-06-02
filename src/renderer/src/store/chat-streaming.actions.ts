/**
 * Chat Streaming Actions — extracted from chat.store.ts for readability.
 *
 * Contains all streaming-related action implementations:
 *   - appendStreamChunk, handleKeepalive, updateStreamingIdentity
 *   - addToolActivity, updateToolActivity
 *   - finalizeStream, finalizeTurnBubble
 *   - stopGeneration
 *
 * These operate on the shared ChatState via get/set references passed in.
 */

import { rendererLog } from '@renderer/utils/logger'
import {
  StreamSegmentAccumulator,
  type SegmentState
} from '@renderer/utils/stream-segment-accumulator'
import type { ConversationPhase, Message, ToolActivity } from '../../../shared/types'
import type { StreamSegment } from '@renderer/utils/stream-segment-accumulator'

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal interface for the streaming-related state slice */
export interface ChatStreamingState {
  streamingContent: string
  streamingRole: 'da-vinci' | 'specialist'
  streamingSpecialist: string | null
  streamingTaskId: string | null
  isStreaming: boolean
  streamingConversationIds: Set<string>
  activeRequestId: string | null
  streamingPhase: ConversationPhase | null
  toolActivities: ToolActivity[]
  streamingSegments: StreamSegment[]
  messages: Message[]
  activeConversation: { id: string; workspaceId?: string } | null
  conversationState: {
    phase: ConversationPhase | 'idle' | 'error' | 'stopped'
    from: string | null
    event: string | null
    conversationId: string | null
  }
}

type GetFn = () => ChatStreamingState
type SetFn = (
  partial:
    | Partial<ChatStreamingState>
    | ((state: ChatStreamingState) => Partial<ChatStreamingState>)
) => void

// ── ChatStreamingInternals ──────────────────────────────────────────────────

/**
 * Encapsulates non-reactive internal state for the chat store.
 * These are operational concerns (timers, buffers) that shouldn't trigger
 * React re-renders or pollute module scope with mutable lets.
 */
export class ChatStreamingInternals {
  private safetyTimer: ReturnType<typeof setTimeout> | null = null
  private accumulator: StreamSegmentAccumulator | null = null
  private storeGet: GetFn | null = null
  private storeSet: SetFn | null = null

  /** Bind the Zustand get/set refs — called once during store creation */
  bind(get: GetFn, set: SetFn): void {
    this.storeGet = get
    this.storeSet = set
  }

  getOrCreateAccumulator(): StreamSegmentAccumulator {
    if (!this.accumulator) {
      this.accumulator = new StreamSegmentAccumulator((state: SegmentState) => {
        // Sync accumulator state → Zustand store
        this.storeSet?.({
          streamingSegments: state.segments,
          streamingContent: state.currentContent,
          toolActivities: state.currentToolActivities
        })
      })
    }
    return this.accumulator
  }

  resetAccumulator(): void {
    this.accumulator?.reset()
    this.accumulator = null
  }

  /** Flush whatever's currently buffered without creating an accumulator if none exists. */
  flushAccumulator(): void {
    this.accumulator?.flush()
  }

  /** Stop the safety timer if one is running. */
  clearSafetyTimer(): void {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer)
      this.safetyTimer = null
    }
  }

  /**
   * Resets the streaming safety timer — call on any sign of backend activity
   * (text chunks, tool starts, tool completions). This prevents the timer from
   * killing active-but-slow streams (e.g., agent running multiple Bash tools).
   */
  resetSafetyTimer(): void {
    if (this.safetyTimer) clearTimeout(this.safetyTimer)
    this.safetyTimer = setTimeout(
      () => {
        if (this.storeGet?.().isStreaming) {
          rendererLog.warn('Safety timeout: isStreaming stuck for 2 minutes — force-resetting')
          this.storeSet?.({
            isStreaming: false,
            streamingConversationIds: new Set<string>(),
            conversationState: { phase: 'idle', from: null, event: null, conversationId: null }
          })
        }
        this.safetyTimer = null
      },
      2 * 60 * 1000
    )
  }
}

/** Singleton internals — encapsulates timers and buffers outside reactive state */
export const streamingInternals = new ChatStreamingInternals()

// ── Action implementations ──────────────────────────────────────────────────

export function appendStreamChunkAction(
  get: GetFn,
  set: SetFn,
  chunk: string,
  role?: 'da-vinci' | 'specialist',
  taskId?: string,
  specialist?: string,
  requestId?: string
): void {
  const activeRequestId = get().activeRequestId
  if (activeRequestId && requestId && requestId !== activeRequestId) return

  // Reset safety timer — backend is still alive
  streamingInternals.resetSafetyTimer()
  if (!chunk) return // Skip empty chunks (tool-only messages)

  const isNewTask = taskId != null && taskId !== get().streamingTaskId

  // If task changed, flush old accumulator and reset
  if (isNewTask) {
    streamingInternals.flushAccumulator()
    streamingInternals.resetAccumulator()
  }

  // Update streaming metadata (non-content state) immediately
  set((state) => ({
    isStreaming: true, // Ensure streaming bubble renders for specialist chunks
    streamingPhase: role === 'specialist' ? 'specialist-executing' : 'da-vinci-responding',
    streamingSegments: isNewTask ? [] : state.streamingSegments,
    streamingContent: isNewTask ? '' : state.streamingContent,
    streamingRole: role ?? state.streamingRole,
    streamingSpecialist: specialist ?? state.streamingSpecialist,
    streamingTaskId: taskId ?? state.streamingTaskId
  }))

  // Push chunk through segment accumulator (auto-segments at sentence + tool boundaries)
  streamingInternals.getOrCreateAccumulator().appendText(chunk)
}

export function finalizeStreamAction(
  get: GetFn,
  set: SetFn,
  messageId: string,
  taskId?: string,
  requestId?: string
): void {
  // Force-flush any remaining buffered content before finalizing
  streamingInternals.flushAccumulator()

  const activeRequestId = get().activeRequestId
  if (activeRequestId && requestId && requestId !== activeRequestId) return

  // Clear safety timer on normal stream completion (only on final complete, not per-task)
  if (!taskId) {
    streamingInternals.clearSafetyTimer()
  }

  const {
    streamingSegments,
    streamingContent,
    streamingRole,
    streamingSpecialist,
    activeConversation,
    toolActivities
  } = get()

  if ((streamingContent || streamingSegments.length > 0) && activeConversation) {
    // Merge all segments + current content into a single message
    const mergedContent = [...streamingSegments.map((s) => s.content), streamingContent]
      .map((c) => c.trim())
      .filter(Boolean)
      .join('\n\n')

    const mergedTools = [
      ...streamingSegments.flatMap((s) => s.toolActivities),
      ...toolActivities
    ].map((a) => (a.status === 'running' ? { ...a, status: 'completed' as const } : a))

    const newMessages: Message[] = []
    if (mergedContent || mergedTools.length > 0) {
      newMessages.push({
        id: messageId,
        conversationId: activeConversation.id,
        role: streamingRole,
        ...(streamingRole === 'specialist' && streamingSpecialist
          ? { agentId: streamingSpecialist }
          : {}),
        contentMd: mergedContent,
        attachmentsJson: '[]',
        createdAt:
          streamingSegments.length > 0
            ? new Date(streamingSegments[0].timestamp).toISOString()
            : new Date().toISOString(),
        toolActivities: mergedTools.length > 0 ? [...mergedTools] : undefined
      })
    }

    set((state) => {
      // Remove from per-conversation streaming set on final complete
      const newStreamingIds = taskId
        ? state.streamingConversationIds
        : (() => {
            const s = new Set(state.streamingConversationIds)
            if (activeConversation) s.delete(activeConversation.id)
            return s
          })()
      return {
        messages: [...state.messages, ...newMessages],
        streamingContent: '',
        streamingSegments: [],
        // Only stop streaming if this is the final complete (no taskId = final summary)
        isStreaming: !!taskId,
        activeRequestId: taskId ? state.activeRequestId : null,
        streamingPhase: taskId ? state.streamingPhase : null,
        toolActivities: taskId ? state.toolActivities : [],
        streamingTaskId: null,
        streamingSpecialist: taskId ? state.streamingSpecialist : null,
        streamingConversationIds: newStreamingIds
      }
    })
  } else if (taskId) {
    // Per-task complete with no accumulated content — just reset task tracking
    set({ streamingContent: '', streamingSegments: [], streamingTaskId: null })
  } else if (activeConversation) {
    // Clear streaming state synchronously to prevent the thinking indicator
    // from hanging while the DB reload completes.
    set((state) => {
      const newStreamingIds = new Set(state.streamingConversationIds)
      newStreamingIds.delete(activeConversation.id)
      return {
        streamingContent: '',
        streamingSegments: [],
        isStreaming: false,
        activeRequestId: null,
        toolActivities: [],
        streamingTaskId: null,
        streamingConversationIds: newStreamingIds
      }
    })
    // Reload messages from DB asynchronously.
    // DB is the source of truth — no optimistic message preservation.
    // The previous merge strategy incorrectly kept temp-* optimistic messages
    // (whose IDs never exist in the DB), causing duplicate user bubbles.
    window.api
      .getMessages({ conversationId: activeConversation.id })
      .then((dbMessages) => {
        if (dbMessages.length > 0) {
          set({ messages: dbMessages })
        }
      })
      .catch((error) => {
        rendererLog.error('Failed to reload messages after stream finalize:', error)
      })
  } else {
    set({
      streamingContent: '',
      streamingSegments: [],
      isStreaming: false,
      activeRequestId: null,
      toolActivities: [],
      streamingTaskId: null
    })
  }

  streamingInternals.resetAccumulator()
}

export function finalizeTurnBubbleAction(
  get: GetFn,
  set: SetFn,
  turnId: string,
  turnRole?: 'da-vinci' | 'specialist',
  turnSpecialist?: string
): void {
  // Flush any remaining buffered content before finalizing the turn.
  streamingInternals.flushAccumulator()

  const {
    streamingSegments,
    streamingContent,
    streamingRole,
    streamingSpecialist,
    activeConversation,
    toolActivities
  } = get()

  // Nothing to finalize — agent went straight to tools without text
  if (!streamingContent && streamingSegments.length === 0 && toolActivities.length === 0) return

  // Use identity from the turn boundary chunk if provided (defensive against stale store state)
  const role = turnRole ?? streamingRole
  const specialist = turnSpecialist ?? streamingSpecialist

  if (activeConversation) {
    // Merge ALL segments + current content into a single message per turn
    const mergedContent = [...streamingSegments.map((s) => s.content), streamingContent]
      .map((c) => c.trim())
      .filter(Boolean)
      .join('\n\n')

    const mergedTools = [
      ...streamingSegments.flatMap((s) => s.toolActivities),
      ...toolActivities
    ].map((a) => (a.status === 'running' ? { ...a, status: 'completed' as const } : a))

    if (mergedContent || mergedTools.length > 0) {
      const message: Message = {
        id: turnId,
        conversationId: activeConversation.id,
        role,
        ...(role === 'specialist' && specialist ? { agentId: specialist } : {}),
        contentMd: mergedContent,
        attachmentsJson: '[]',
        createdAt:
          streamingSegments.length > 0
            ? new Date(streamingSegments[0].timestamp).toISOString()
            : new Date().toISOString(),
        toolActivities: mergedTools.length > 0 ? mergedTools : undefined
      }

      set((state) => ({
        messages: [...state.messages, message],
        streamingContent: '',
        streamingSegments: [],
        toolActivities: [],
        isStreaming: true
      }))
    } else {
      set({ streamingContent: '', streamingSegments: [], toolActivities: [], isStreaming: true })
    }
  }

  streamingInternals.resetAccumulator()
}
