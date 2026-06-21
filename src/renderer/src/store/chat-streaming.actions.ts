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
import type { ChatState } from './chat.store'

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal interface for the streaming-related state slice */
export interface ChatStreamingState {
  streamingContent: string
  streamingRole: 'da-vinci' | 'specialist'
  streamingSpecialist: string | null
  streamingTaskId: string | null
  isStreaming: boolean
  isSending: boolean
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
// SetFn mirrors zustand's `set` for the full ChatState — the streaming actions
// only touch the ChatStreamingState slice, but the callback receives the full
// store state, so the param/return must be typed against ChatState.
type SetFn = (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void

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

  /**
   * MSG-RELOAD-01: Monotonically increasing generation counter.
   * Bumped on every sendMessage() and selectConversation().
   * The async DB reload after stream finalize captures the current generation
   * and discards the result if it changed (meaning a new message or conv switch
   * happened while the reload was in flight).
   */
  private _messageGeneration = 0
  get messageGeneration(): number {
    return this._messageGeneration
  }
  bumpGeneration(): void {
    this._messageGeneration++
  }

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
          // STREAM-SAFETY-PARTIAL-01: Also clear activeRequestId so late chunks
          // from the timed-out request are rejected instead of silently accepted.
          this.storeSet?.({
            isStreaming: false,
            activeRequestId: null,
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
  const isCurrentlyStreaming = get().isStreaming

  // CHUNK-LEAK-01: Drop chunks when no active request is expected AND not streaming.
  // Previously, the null-guard was inverted: when activeRequestId was null (e.g. after
  // conv switch), the check was bypassed, leaking chunks to the wrong conversation.
  if (!activeRequestId && !isCurrentlyStreaming) return

  // Drop stale chunks (mismatched request)
  if (activeRequestId && requestId && requestId !== activeRequestId) {
    rendererLog.debug(
      `[appendStreamChunk] Dropped stale chunk: expected=${activeRequestId.slice(0, 12)} got=${requestId.slice(0, 12)}`
    )
    return
  }

  // STREAM-REQID-BYPASS-01: If we expect a specific request but this chunk has no ID,
  // drop it — it's likely a late chunk from a previous request that omitted requestId.
  if (activeRequestId && !requestId) {
    rendererLog.debug('[appendStreamChunk] Dropped chunk without requestId (activeRequestId set)')
    return
  }

  // Reset safety timer — backend is still alive
  streamingInternals.resetSafetyTimer()
  if (!chunk) return // Skip empty chunks (tool-only messages)

  const isNewTask = taskId != null && taskId !== get().streamingTaskId

  // STREAM-TASK-FLUSH-RACE-01: On task switch, flush the accumulator (which pushes
  // buffered text to the store via onFlush), then read the flushed state BEFORE
  // clearing — otherwise the set() below overwrites what flush just wrote.
  if (isNewTask) {
    streamingInternals.flushAccumulator()
    streamingInternals.resetAccumulator()
  }

  // Update streaming metadata (non-content state) immediately.
  // On task switch the segments/content were already archived by flush above,
  // so clearing here is safe (flush output was consumed by the accumulator's onFlush).
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

// ── finalizeStream helpers ───────────────────────────────────────────────

function mergeStreamedContent(
  streamingSegments: StreamSegment[],
  streamingContent: string,
  toolActivities: ToolActivity[]
): { mergedContent: string; mergedTools: ToolActivity[] } {
  const mergedContent = [...streamingSegments.map((s) => s.content), streamingContent]
    .map((c) => c.trim())
    .filter(Boolean)
    .join('\n\n')

  const mergedTools = [
    ...streamingSegments.flatMap((s) => s.toolActivities),
    ...toolActivities
  ].map((a) => (a.status === 'running' ? { ...a, status: 'completed' as const } : a))

  return { mergedContent, mergedTools }
}

function computeFinalizeStateDelta(
  taskId: string | undefined,
  activeConversation: { id: string } | null,
  currentStreamingIds: Set<string>
): Partial<ChatState> {
  const newStreamingIds = taskId
    ? currentStreamingIds
    : (() => {
        const s = new Set(currentStreamingIds)
        if (activeConversation) s.delete(activeConversation.id)
        return s
      })()

  const base: Partial<ChatState> = {
    streamingContent: '',
    streamingSegments: [],
    isStreaming: !!taskId,
    activeRequestId: taskId ? undefined : null,
    streamingPhase: taskId ? undefined : null,
    streamingTaskId: null,
    streamingConversationIds: newStreamingIds
  }

  if (!taskId) {
    Object.assign(base, {
      toolActivities: [],
      streamingSpecialist: null,
      pendingQuestions: null,
      pendingQuestionAction: null,
      pendingQuestionRequestId: null
    })
  }

  return base
}

function reloadMessagesFromDb(
  conversationId: string,
  get: GetFn,
  set: SetFn
): void {
  const reloadGeneration = streamingInternals.messageGeneration
  window.api
    .getMessages({ conversationId })
    .then((dbMessages) => {
      const current = get()
      if (
        current.activeConversation?.id === conversationId &&
        !current.isStreaming &&
        streamingInternals.messageGeneration === reloadGeneration &&
        dbMessages.length > 0
      ) {
        set({ messages: dbMessages })
      }
    })
    .catch((error) => {
      rendererLog.error('Failed to reload messages after stream finalize:', error)
    })
}

// ── finalizeStreamAction ──────────────────────────────────────────────

export function finalizeStreamAction(
  get: GetFn,
  set: SetFn,
  messageId: string,
  taskId?: string,
  requestId?: string
): void {
  streamingInternals.flushAccumulator()

  const activeRequestId = get().activeRequestId
  if (activeRequestId && requestId && requestId !== activeRequestId) return

  if (!taskId) streamingInternals.clearSafetyTimer()

  const {
    streamingSegments,
    streamingContent,
    streamingRole,
    streamingSpecialist,
    activeConversation,
    toolActivities
  } = get()

  // Main path: streamed content exists and we have a conversation
  if ((streamingContent || streamingSegments.length > 0) && activeConversation) {
    const { mergedContent, mergedTools } = mergeStreamedContent(
      streamingSegments, streamingContent, toolActivities
    )

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

    set((state) => ({
      messages: [...state.messages, ...newMessages],
      ...computeFinalizeStateDelta(taskId, activeConversation, state.streamingConversationIds),
      // Preserve mutable refs when task is still active
      ...(taskId ? {
        activeRequestId: state.activeRequestId,
        streamingPhase: state.streamingPhase,
        toolActivities: state.toolActivities,
        streamingSpecialist: state.streamingSpecialist
      } : {})
    }))
  } else if (taskId) {
    // Per-task complete with no accumulated content
    set({ streamingContent: '', streamingSegments: [], streamingTaskId: null })
  } else if (activeConversation) {
    // Clear streaming state + reload from DB
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
        streamingConversationIds: newStreamingIds,
        pendingQuestions: null,
        pendingQuestionAction: null,
        pendingQuestionRequestId: null
      }
    })
    reloadMessagesFromDb(activeConversation.id, get, set)
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
