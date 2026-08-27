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
import { resolveSafetyTimeout, type PerConversationStreamState } from './chat-action-utils'
import type { ChatState, PendingToolPermission } from './chat.store'
import { findPlanBlock } from '@renderer/components/chat/plan-detection'
import { usePlanExecutionStore } from './plan-execution.store'

// ── Types ────────────────────────────────────────────────────────────────────

/** Minimal interface for the streaming-related state slice */
export interface ChatStreamingState {
  streamingContent: string
  streamingRole: 'specialist'
  streamingSpecialist: string | null
  streamingTaskId: string | null
  isStreaming: boolean
  /** SEND-RACE-02: Per-conversation send mutex — replaces the global isSending boolean.
   *  Tracks which conversations have an IPC send in-flight. Phase 2 ready. */
  sendingConversationIds: Set<string>
  streamingConversationIds: Set<string>
  activeRequestId: string | null
  streamingPhase: ConversationPhase | null
  toolActivities: ToolActivity[]
  streamingSegments: StreamSegment[]
  /** STALL-DETECT-01: Conversation ID whose stream has stalled (no real content for 3 minutes).
   *  null when no stall detected. Used to show a warning banner — does NOT kill the stream. */
  streamStalledConversationId: string | null
  /** Inline tool-permission prompt — cleared when its turn finalizes. */
  pendingToolPermission: PendingToolPermission | null
  /**
   * Open `ask_user` gate for the active conversation, or null.
   *
   * Read by the safety timeout: a gate has no backend timeout by design (a
   * human may take arbitrarily long), so it is the one state where two minutes
   * of silence is not evidence that anything died.
   */
  pendingQuestions: unknown[] | null
  /** MULTI-CHAT-06: Per-conversation streaming state snapshots. */
  conversationStreams: Map<string, PerConversationStreamState>
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
  // MULTI-CHAT-05: Per-conversation safety and stall timers. Each conversation
  // gets its own timeout so clearing/resetting one doesn't affect others.
  private safetyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private stallTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** PER-CONV-ACCUM: Per-conversation accumulators — each conversation gets its own
   *  StreamSegmentAccumulator so chunks are always routed to the right buffer,
   *  eliminating the stash/restore race (P0 RACE #4). */
  private accumulators = new Map<string, StreamSegmentAccumulator>()
  /** PRE-MORTEM-2: Pending metadata written by appendStreamChunkAction, consumed by
   *  the accumulator's onChange to avoid an extra Map-copy set() per chunk. */
  private pendingMeta = new Map<
    string,
    {
      role?: 'specialist'
      specialist?: string | null
      taskId?: string | null
      phase?: ConversationPhase | null
      requestId?: string | null
    }
  >()
  private storeGet: GetFn | null = null
  private storeSet: SetFn | null = null

  /** STALL-DETECT-01: Threshold for detecting stalled streams (no real content chunks). */
  private static readonly STALL_THRESHOLD_MS = 3 * 60 * 1000 // 3 minutes

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

  /**
   * PER-CONV-ACCUM: Get or create a per-conversation accumulator.
   * Each accumulator writes to its conversation's buffer in conversationStreams
   * AND projects to global streaming fields if it's the active conversation.
   *
   * @param conversationId — required; identifies which conversation owns this accumulator
   */
  getOrCreateAccumulatorFor(conversationId: string): StreamSegmentAccumulator {
    let acc = this.accumulators.get(conversationId)
    if (!acc) {
      acc = new StreamSegmentAccumulator((state: SegmentState) => {
        // PRE-MORTEM-2: Consume pending metadata (written by appendStreamChunkAction)
        // in the same set() call that writes content, avoiding an extra Map copy.
        const meta = this.pendingMeta.get(conversationId)
        if (meta) this.pendingMeta.delete(conversationId)

        // Write to per-conversation buffer AND project to globals if active
        this.storeSet?.((prev) => {
          const streams = new Map(prev.conversationStreams)
          const existing = streams.get(conversationId)
          const entry = {
            streamingContent: state.currentContent,
            streamingSegments: state.segments,
            streamingRole: meta?.role ?? existing?.streamingRole ?? ('specialist' as const),
            streamingSpecialist:
              (meta?.specialist !== undefined ? meta.specialist : existing?.streamingSpecialist) ??
              null,
            streamingTaskId:
              (meta?.taskId !== undefined ? meta.taskId : existing?.streamingTaskId) ?? null,
            streamingPhase: meta?.phase ?? existing?.streamingPhase ?? null,
            activeRequestId:
              (meta?.requestId !== undefined ? meta.requestId : existing?.activeRequestId) ?? null,
            isStreaming: existing?.isStreaming ?? true,
            toolActivities: state.currentToolActivities,
            pendingQuestions: existing?.pendingQuestions ?? null,
            pendingQuestionAction: existing?.pendingQuestionAction ?? null,
            pendingQuestionRequestId: existing?.pendingQuestionRequestId ?? null
          }
          streams.set(conversationId, entry)
          // Project to globals if this is the active conversation
          const isActive = prev.activeConversation?.id === conversationId
          return {
            conversationStreams: streams,
            ...(isActive
              ? {
                  streamingContent: state.currentContent,
                  streamingSegments: state.segments,
                  toolActivities: state.currentToolActivities,
                  // Also project metadata when present
                  ...(meta
                    ? {
                        streamingRole: entry.streamingRole,
                        streamingSpecialist: entry.streamingSpecialist,
                        streamingTaskId: entry.streamingTaskId,
                        streamingPhase: entry.streamingPhase,
                        isStreaming: true
                      }
                    : {})
                }
              : {})
          }
        })
      })
      this.accumulators.set(conversationId, acc)
    }
    return acc
  }

  /**
   * PER-CONV-ACCUM: Reset accumulator(s).
   * With conversationId: resets and removes that conversation's accumulator.
   * Without: resets and removes ALL accumulators.
   */
  resetAccumulator(conversationId?: string): void {
    if (conversationId) {
      const acc = this.accumulators.get(conversationId)
      if (acc) {
        acc.reset()
        this.accumulators.delete(conversationId)
      }
      this.pendingMeta.delete(conversationId)
    } else {
      for (const acc of this.accumulators.values()) acc.reset()
      this.accumulators.clear()
      this.pendingMeta.clear()
    }
  }

  /**
   * PER-CONV-ACCUM: Flush accumulator(s) without destroying them.
   * With conversationId: flushes that conversation's accumulator.
   * Without: flushes ALL accumulators.
   */
  flushAccumulator(conversationId?: string): void {
    if (conversationId) {
      this.accumulators.get(conversationId)?.flush()
    } else {
      for (const acc of this.accumulators.values()) acc.flush()
    }
  }

  /** PRE-MORTEM-2: Stash metadata for the next accumulator onChange to consume. */
  setPendingMeta(
    conversationId: string,
    meta: {
      role?: 'specialist'
      specialist?: string | null
      taskId?: string | null
      phase?: ConversationPhase | null
      requestId?: string | null
    }
  ): void {
    this.pendingMeta.set(conversationId, meta)
  }

  /**
   * Stop safety timer(s). With conversationId, clears only that conversation's
   * timer. Without, clears ALL timers (used during full reset).
   */
  clearSafetyTimer(conversationId?: string): void {
    if (conversationId) {
      const timer = this.safetyTimers.get(conversationId)
      if (timer) {
        clearTimeout(timer)
        this.safetyTimers.delete(conversationId)
      }
    } else {
      for (const timer of this.safetyTimers.values()) clearTimeout(timer)
      this.safetyTimers.clear()
    }
    // STALL-DETECT-01: Always clear stall timer alongside safety timer.
    this.clearStallTimer(conversationId)
  }

  // ── Stall Detection ──────────────────────────────────────────────────
  // STALL-DETECT-01: Independent of keepalive-based safety timer.
  // Tracks time since last REAL content chunk (text, not keepalive/tool).
  // Sets streamStalledConversationId after 3 minutes of silence so the UI can
  // show a warning banner — does NOT kill the stream.

  /**
   * Record real chunk activity (text content, NOT keepalive).
   * Resets the stall timer and clears the stalled flag.
   * Uses activeConversation.id when conversationId not provided.
   */
  recordChunkActivity(conversationId?: string): void {
    const convId = conversationId ?? this.storeGet?.().activeConversation?.id
    if (!convId) return
    this.clearStallTimer(convId)
    this.stallTimers.set(
      convId,
      setTimeout(() => {
        // STALL-DETECT-06: Per-conversation guard — only flag stall if THIS conversation
        // is still in the streaming set. No global isStreaming check, no active-conv check.
        // The banner render guard in ChatPanel checks activeConversation match.
        const state = this.storeGet?.()
        if (state?.streamingConversationIds.has(convId)) {
          this.storeSet?.({ streamStalledConversationId: convId })
        }
      }, ChatStreamingInternals.STALL_THRESHOLD_MS)
    )
  }

  /**
   * Clear stall timer(s). With conversationId, clears only that conversation's
   * timer. Without, clears ALL stall timers.
   */
  clearStallTimer(conversationId?: string): void {
    if (conversationId) {
      const timer = this.stallTimers.get(conversationId)
      if (timer) {
        clearTimeout(timer)
        this.stallTimers.delete(conversationId)
      }
    } else {
      for (const timer of this.stallTimers.values()) clearTimeout(timer)
      this.stallTimers.clear()
    }
    // STALL-DETECT-06: Only clear the stall flag if it belongs to the conversation
    // whose timer we just cleared. Prevents clearing conv A's stall when conv B completes.
    const stalledId = this.storeGet?.().streamStalledConversationId
    if (stalledId && (!conversationId || stalledId === conversationId)) {
      this.storeSet?.({ streamStalledConversationId: null })
    }
  }

  /**
   * Resets the streaming safety timer — call on any sign of backend activity
   * (text chunks, tool starts, tool completions). This prevents the timer from
   * killing active-but-slow streams (e.g., agent running multiple Bash tools).
   * Uses activeConversation.id when conversationId not provided.
   */
  resetSafetyTimer(conversationId?: string): void {
    const convId = conversationId ?? this.storeGet?.().activeConversation?.id
    if (!convId) return

    const existing = this.safetyTimers.get(convId)
    if (existing) clearTimeout(existing)

    this.safetyTimers.set(
      convId,
      setTimeout(
        () => {
          this.safetyTimers.delete(convId)
          void this.handleSafetyTimeout(convId)
        },
        2 * 60 * 1000
      )
    )
  }

  /**
   * Fired when a conversation has shown no sign of life for two minutes.
   *
   * This watchdog is the last defence against a wedged main process, so it
   * stays — but it no longer tears down on silence alone. A background
   * conversation running a long tool emitted only `toolActivity` chunks, which
   * did not reset this timer; the teardown clears `activeRequestId`, so the two
   * further minutes main streamed were all rejected and the turn's output was
   * destroyed. Main is now asked whether it still owns the stream before
   * anything is torn down. A throw counts as "gone", so a genuinely unreachable
   * main process still triggers recovery.
   */
  private async handleSafetyTimeout(convId: string): Promise<void> {
    const get = this.storeGet
    const set = this.storeSet
    if (!get || !set) return

    // MULTI-CHAT-06: Check per-conversation membership instead of global isStreaming.
    // After a conversation switch, isStreaming reflects the TARGET conv's state, not this
    // timed-out conv. Without this, safety cleanup is skipped and the dead conv stays
    // in streamingConversationIds forever (permanent sidebar spinner ghost).
    if (!get().streamingConversationIds.has(convId)) return

    // SAFETY-GATE-ALIVE: silence proves nothing on its own — ask main whether
    // the request is really dead before tearing anything down.
    const backendOwnsStream = await this.backendStillOwns(convId)

    const outcome = resolveSafetyTimeout({
      // Re-read: state can have moved on across the await above.
      stillStreaming: get().streamingConversationIds.has(convId),
      backendOwnsStream
    })
    if (outcome === 'ignore') return
    if (outcome === 'defer') {
      rendererLog.warn(
        `Safety timeout: conversation ${convId} silent for 2 minutes but main still owns the ` +
          `stream — re-arming instead of tearing it down`
      )
      this.resetSafetyTimer(convId)
      return
    }

    rendererLog.warn(`Safety timeout: conversation ${convId} stuck for 2 minutes — force-resetting`)

    // STREAM-SAFETY-ORPHAN-01: Commit whatever was already streamed.
    // Clearing conversationStreams below drops the per-conversation buffer
    // but leaves the TOP-LEVEL streamingContent/segments/toolActivities
    // untouched — and stopGeneration reads exactly those. That is how a
    // timed-out turn's text vanished from the transcript and then came
    // back inside a "⏹ stopped" bubble on the next Stop. Committing it
    // here means it is either shown once or not at all.
    // Only for the active conversation: the globals belong to whatever is
    // on screen, and flushStreamingIntoMessage commits to that same
    // conversation. Like the pre-question and stopped bubbles, this is a
    // client-only message — main persists its own copy of the turn, so
    // saving it here would duplicate the text after a reload.
    if (get().activeConversation?.id === convId) {
      flushStreamingIntoMessage(get, set, 'safety-timeout')
    }

    // STREAM-SAFETY-PARTIAL-01: Also clear activeRequestId so late chunks
    // from the timed-out request are rejected instead of silently accepted.
    // MULTI-CHAT-05: Only remove THIS timed-out conversation from
    // streamingConversationIds — other conversations may still be
    // legitimately streaming in the background.
    const currentIds = this.storeGet?.().streamingConversationIds ?? new Set<string>()
    const newIds = new Set(currentIds)
    newIds.delete(convId)
    // GAP-R7-1: Clean up stashed streaming state for the timed-out conversation.
    // Without this, the stash retains isStreaming: true, causing BUG-R7-1 (locked
    // input when the user switches to this conversation).
    const currentStreams =
      this.storeGet?.().conversationStreams ?? new Map<string, PerConversationStreamState>()
    const newStreams = new Map(currentStreams)
    newStreams.delete(convId)
    // BUG-R5-1: Derive isStreaming from active conv membership, not global set size.
    // A background conv timing out shouldn't lock/unlock the active conv's input.
    const activeId = this.storeGet?.()?.activeConversation?.id
    // IMP-R6-1: Only reset conversationState/activeRequestId if the timed-out
    // conv is the active one. A background conv timing out shouldn't clear
    // the active conv's phase label or request tracking.
    const isActiveConv = activeId === convId
    // WEDGE-FIX: release the send flag too. `sendingConversationIds`
    // drives the composer lock and the Stop button independently of
    // `isStreaming`; if the stream dies silently after the 30s reconcile
    // declined, clearing only the streaming state removes the thinking
    // indicator but leaves the composer permanently disabled.
    const currentSending = this.storeGet?.().sendingConversationIds ?? new Set<string>()
    const newSending = new Set(currentSending)
    newSending.delete(convId)
    this.storeSet?.({
      isStreaming: activeId ? newIds.has(activeId) : false,
      ...(isActiveConv ? { activeRequestId: null } : {}),
      streamingConversationIds: newIds,
      sendingConversationIds: newSending,
      conversationStreams: newStreams,
      ...(isActiveConv
        ? {
            conversationState: {
              phase: 'idle',
              from: null,
              event: null,
              conversationId: null
            }
          }
        : {}),
      // STALL-DETECT-01: Clear stall flag on safety timeout.
      // Use per-conversation matching (not isActiveConv) so background
      // safety timeouts also clear their own stale stall flag.
      ...(this.storeGet?.().streamStalledConversationId === convId
        ? { streamStalledConversationId: null }
        : {}),
      // SAFETY-ORPHAN-QUESTIONS: Clear orphaned question cards on safety timeout.
      // The backend is dead — answers can't be routed to the CLI anymore.
      ...(isActiveConv
        ? {
            pendingQuestions: null,
            pendingQuestionAction: null,
            pendingQuestionRequestId: null
          }
        : {})
    })
  }

  /**
   * Ask main whether it still owns a stream for this conversation.
   *
   * A failed query counts as "gone": an unreachable main process is exactly the
   * wedge the safety timeout exists to recover from, so the watchdog must not
   * be disarmed by the very failure it is watching for.
   */
  private async backendStillOwns(
    conversationId: string,
    /** Injectable for tests — same seam as reconcileStopState's fetchStreamingState. */
    fetchStreamingState: () => Promise<{
      streams?: Array<{ conversationId: string }>
    }> = () => window.api.getStreamingState()
  ): Promise<boolean> {
    try {
      const state = await fetchStreamingState()
      return !!state?.streams?.some((s) => s.conversationId === conversationId)
    } catch (error) {
      rendererLog.warn('[SAFETY-GATE-ALIVE] Streaming-state query failed:', error)
      return false
    }
  }
}

/** Singleton internals — encapsulates timers and buffers outside reactive state */
export const streamingInternals = new ChatStreamingInternals()

// ── Action implementations ──────────────────────────────────────────────────

export function appendStreamChunkAction(
  get: GetFn,
  set: SetFn,
  conversationId: string,
  chunk: string,
  role?: 'specialist',
  taskId?: string,
  specialist?: string,
  requestId?: string
): void {
  // PER-CONV-ACCUM: Validate against the conversation's own buffer state,
  // not just the global activeRequestId. For active conversations, the global
  // activeRequestId is authoritative; for background ones, the buffer's is.
  const isActive = get().activeConversation?.id === conversationId
  const buffer = get().conversationStreams.get(conversationId)
  const effectiveRequestId = isActive ? get().activeRequestId : (buffer?.activeRequestId ?? null)
  const isCurrentlyStreaming = isActive ? get().isStreaming : (buffer?.isStreaming ?? false)

  // CHUNK-LEAK-01: Drop chunks when no active request is expected AND not streaming.
  if (!effectiveRequestId && !isCurrentlyStreaming) {
    if (chunk?.includes?.('```plan\n')) {
      rendererLog.warn(
        `[appendStreamChunk:plan-block-DROPPED] reason=no-active-request ` +
          `conversationId=${conversationId} chunkLen=${chunk.length}`
      )
    }
    return
  }

  // Drop stale chunks (mismatched request)
  if (effectiveRequestId && requestId && requestId !== effectiveRequestId) {
    if (chunk?.includes?.('```plan\n')) {
      rendererLog.warn(
        `[appendStreamChunk:plan-block-DROPPED] reason=stale-request ` +
          `conversationId=${conversationId} expected=${effectiveRequestId.slice(0, 12)} got=${requestId.slice(0, 12)}`
      )
    }
    rendererLog.debug(
      `[appendStreamChunk] Dropped stale chunk: expected=${effectiveRequestId.slice(0, 12)} got=${requestId.slice(0, 12)}`
    )
    return
  }

  // STREAM-REQID-BYPASS-01: If we expect a specific request but this chunk has no ID,
  // drop it — it's likely a late chunk from a previous request that omitted requestId.
  if (effectiveRequestId && !requestId) {
    if (chunk?.includes?.('```plan\n')) {
      rendererLog.warn(
        `[appendStreamChunk:plan-block-DROPPED] reason=no-requestId ` +
          `conversationId=${conversationId} chunkLen=${chunk.length}`
      )
    }
    rendererLog.debug(
      '[appendStreamChunk] Dropped chunk without requestId (effectiveRequestId set)'
    )
    return
  }

  // Log plan block reception for diagnostics
  if (chunk?.includes?.('```plan\n')) {
    rendererLog.info(
      `[appendStreamChunk:plan-block] conversationId=${conversationId} ` +
        `effectiveRequestId=${effectiveRequestId?.slice(0, 12)} requestId=${requestId?.slice(0, 12)} ` +
        `isCurrentlyStreaming=${isCurrentlyStreaming} chunkLen=${chunk.length}`
    )
  }

  // Reset safety timer — backend is still alive
  streamingInternals.resetSafetyTimer(conversationId)
  if (!chunk) return // Skip empty chunks (tool-only messages)
  // STALL-DETECT-01: Track real content chunk activity (independent of keepalive).
  streamingInternals.recordChunkActivity(conversationId)

  const currentTaskId = isActive ? get().streamingTaskId : (buffer?.streamingTaskId ?? null)
  const isNewTask = taskId != null && taskId !== currentTaskId

  // STREAM-TASK-FLUSH-RACE-01: On task switch, flush then reset the accumulator.
  if (isNewTask) {
    streamingInternals.flushAccumulator(conversationId)
    streamingInternals.resetAccumulator(conversationId)
    // Clear globals immediately so the UI doesn't flash old task content
    // between the reset and the next SentenceBuffer flush.
    if (isActive) {
      set({ streamingContent: '', streamingSegments: [], streamingTaskId: taskId ?? null })
    }
  }

  // PRE-MORTEM-2: Stash metadata so the accumulator's onChange merges it in the
  // same set() call that writes content. This eliminates a redundant Map copy
  // that the old separate set() did on every chunk (~50/sec).
  const updatedPhase =
    role === 'specialist' ? ('specialist-executing' as const) : ('specialist-responding' as const)
  streamingInternals.setPendingMeta(conversationId, {
    role,
    specialist: specialist ?? undefined,
    taskId: taskId ?? undefined,
    phase: updatedPhase,
    requestId: requestId ?? undefined
  })

  // Push chunk through per-conversation segment accumulator.
  // SentenceBuffer will fire onChange which reads pendingMeta and does a single set().
  streamingInternals.getOrCreateAccumulatorFor(conversationId).appendText(chunk)
}

// ── Interrupt flush ──────────────────────────────────────────────────────

/**
 * Commit whatever the agent has streamed so far as a message, so an interrupt
 * card (question / tool permission) lands BELOW the text that led to it rather
 * than above it. Shared by setPendingQuestions and setPendingToolPermission.
 *
 * `idPrefix` only distinguishes the synthetic message ids in the transcript.
 */
export function flushStreamingIntoMessage(get: GetFn, set: SetFn, idPrefix: string): void {
  // FLUSH-ORDER-01: Flush the active conversation's accumulator BEFORE reading state.
  const activeConversation = get().activeConversation
  streamingInternals.flushAccumulator(activeConversation?.id)

  // PER-CONV-ACCUM: Read from per-conversation buffer (or globals as fallback)
  const buffer = activeConversation
    ? get().conversationStreams.get(activeConversation.id)
    : undefined
  const streamingContent = buffer?.streamingContent ?? get().streamingContent
  const streamingSegments = buffer?.streamingSegments ?? get().streamingSegments
  const streamingRole = buffer?.streamingRole ?? get().streamingRole
  const streamingSpecialist = buffer?.streamingSpecialist ?? get().streamingSpecialist
  const toolActivities = buffer?.toolActivities ?? get().toolActivities

  if (
    !activeConversation ||
    (!streamingContent && streamingSegments.length === 0 && toolActivities.length === 0)
  ) {
    return
  }

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
      id: `${idPrefix}-${Date.now()}`,
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
      toolActivities: mergedTools.length > 0 ? mergedTools : undefined
    }

    set((state) => ({
      messages: [...state.messages, message],
      streamingContent: '',
      streamingSegments: [],
      toolActivities: []
    }))
  }

  streamingInternals.resetAccumulator(activeConversation.id)
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
    // BUG-R5-1: When taskId is set, a sub-task completed but overall stream continues.
    // When no taskId, the active conv just finished — isStreaming: false.
    // Background streams are tracked by streamingConversationIds, not this flag.
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
      // STALL-DETECT-05: Defense-in-depth — clear stall flag alongside other streaming state
      streamStalledConversationId: null
      // DON'T clear pendingQuestions here — let submitQuestionAnswers/skipAllQuestions
      // handle that. Clearing here races with user submission and drops the requestId.
    })
  }

  return base
}

function reloadMessagesFromDb(conversationId: string, get: GetFn, set: SetFn): void {
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
  conversationId: string,
  messageId: string,
  taskId?: string,
  requestId?: string
): void {
  streamingInternals.flushAccumulator(conversationId)

  const isActive = get().activeConversation?.id === conversationId
  // PER-CONV-ACCUM: Read from per-conversation buffer, not from globals
  const buffer = get().conversationStreams.get(conversationId)
  const effectiveRequestId = isActive ? get().activeRequestId : (buffer?.activeRequestId ?? null)
  if (effectiveRequestId && requestId && requestId !== effectiveRequestId) return

  // Read streaming state from the buffer (or globals for active conv as fallback)
  const streamingSegments = buffer?.streamingSegments ?? (isActive ? get().streamingSegments : [])
  const streamingContent = buffer?.streamingContent ?? (isActive ? get().streamingContent : '')
  const streamingRole =
    buffer?.streamingRole ?? (isActive ? get().streamingRole : ('specialist' as const))
  const streamingSpecialist =
    buffer?.streamingSpecialist ?? (isActive ? get().streamingSpecialist : null)
  const toolActivities = buffer?.toolActivities ?? (isActive ? get().toolActivities : [])

  if (!taskId) streamingInternals.clearSafetyTimer(conversationId)

  // Main path: streamed content exists
  if (streamingContent || streamingSegments.length > 0) {
    const { mergedContent, mergedTools } = mergeStreamedContent(
      streamingSegments,
      streamingContent,
      toolActivities
    )

    const newMessages: Message[] = []
    if (mergedContent || mergedTools.length > 0) {
      newMessages.push({
        id: messageId,
        conversationId,
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
      // Clean up the conversation buffer
      const streams = new Map(state.conversationStreams)
      if (!taskId) {
        streams.delete(conversationId)
      } else {
        // Task completed but stream continues — clear content but keep buffer
        const existing = streams.get(conversationId)
        if (existing) {
          streams.set(conversationId, {
            ...existing,
            streamingContent: '',
            streamingSegments: [],
            streamingTaskId: null
          })
        }
      }
      return {
        conversationStreams: streams,
        // Only append messages + update globals for active conversation
        ...(isActive
          ? {
              messages: [...state.messages, ...newMessages],
              ...computeFinalizeStateDelta(
                taskId,
                { id: conversationId },
                state.streamingConversationIds
              ),
              ...(taskId
                ? {
                    activeRequestId: state.activeRequestId,
                    streamingPhase: state.streamingPhase,
                    toolActivities: state.toolActivities,
                    streamingSpecialist: state.streamingSpecialist
                  }
                : {})
            }
          : {})
      }
    })
  } else if (taskId) {
    // Per-task complete with no accumulated content
    set((state) => {
      const streams = new Map(state.conversationStreams)
      const existing = streams.get(conversationId)
      if (existing) {
        streams.set(conversationId, {
          ...existing,
          streamingContent: '',
          streamingSegments: [],
          streamingTaskId: null
        })
      }
      return {
        conversationStreams: streams,
        ...(isActive ? { streamingContent: '', streamingSegments: [], streamingTaskId: null } : {})
      }
    })
  } else if (isActive) {
    // Active conversation — clear streaming state + reload from DB
    set((state) => {
      const newStreamingIds = new Set(state.streamingConversationIds)
      newStreamingIds.delete(conversationId)
      const streams = new Map(state.conversationStreams)
      streams.delete(conversationId)
      return {
        conversationStreams: streams,
        streamingContent: '',
        streamingSegments: [],
        isStreaming: false,
        activeRequestId: null,
        toolActivities: [],
        streamingTaskId: null,
        streamingConversationIds: newStreamingIds,
        streamStalledConversationId: null
      }
    })
    reloadMessagesFromDb(conversationId, get, set)
  } else {
    // Background or no active conv — clean up buffer only
    set((state) => {
      const streams = new Map(state.conversationStreams)
      streams.delete(conversationId)
      return { conversationStreams: streams }
    })
  }

  streamingInternals.resetAccumulator(conversationId)

  // PERM-INLINE-01: A tool-permission card must not outlive its turn. The
  // server denies on its own 15-min timeout and never tells the renderer, so
  // the end of the stream is the only signal that the card is dead. Per-task
  // finalizes (taskId) are mid-turn and must not clear it.
  if (!taskId && get().pendingToolPermission?.permission.conversationId === conversationId) {
    set({ pendingToolPermission: null })
  }

  // PLAN-RACE-FIX-E1: After finalize, schedule a deferred check for late plan blocks.
  // The backend's late injection (PLAN-RACE-FIX-01) sends the plan chunk after the
  // complete event. ChunkConsumer's rAF batching could delay it by one frame,
  // causing it to arrive after this finalize ran. This deferred scan catches that.
  setTimeout(() => {
    // GAP-2-GUARD: If the user switched conversations within 500ms, get().messages
    // now contains messages from a different conversation. Bail out to avoid
    // populating plan content for a stale conversation.
    if (get().activeConversation?.id !== conversationId) return
    const currentMessages = get().messages
    const msg = currentMessages.find((m: Message) => m.id === messageId)
    const block = msg?.contentMd ? findPlanBlock(msg.contentMd) : null
    if (block?.content) {
      usePlanExecutionStore.getState().setLatestPlanContent(conversationId, block.content)
    }
  }, 500)
}

export function finalizeTurnBubbleAction(
  get: GetFn,
  set: SetFn,
  turnId: string,
  turnRole?: 'specialist',
  turnSpecialist?: string
): void {
  const activeConversation = get().activeConversation
  const conversationId = activeConversation?.id
  // Flush the active conversation's accumulator before finalizing
  streamingInternals.flushAccumulator(conversationId)

  // PER-CONV-ACCUM: Read from per-conversation buffer (or globals as fallback)
  const buffer = conversationId ? get().conversationStreams.get(conversationId) : undefined
  const streamingSegments = buffer?.streamingSegments ?? get().streamingSegments
  const streamingContent = buffer?.streamingContent ?? get().streamingContent
  const streamingRole = buffer?.streamingRole ?? get().streamingRole
  const streamingSpecialist = buffer?.streamingSpecialist ?? get().streamingSpecialist
  const toolActivities = buffer?.toolActivities ?? get().toolActivities

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

      set((state) => {
        // Clean up the conversation buffer content
        const streams = new Map(state.conversationStreams)
        const existing = streams.get(activeConversation.id)
        if (existing) {
          streams.set(activeConversation.id, {
            ...existing,
            streamingContent: '',
            streamingSegments: [],
            toolActivities: []
          })
        }
        return {
          messages: [...state.messages, message],
          streamingContent: '',
          streamingSegments: [],
          toolActivities: [],
          isStreaming: true,
          conversationStreams: streams
        }
      })
    } else {
      set((state) => {
        const streams = new Map(state.conversationStreams)
        const existing = streams.get(activeConversation.id)
        if (existing) {
          streams.set(activeConversation.id, {
            ...existing,
            streamingContent: '',
            streamingSegments: [],
            toolActivities: []
          })
        }
        return {
          streamingContent: '',
          streamingSegments: [],
          toolActivities: [],
          isStreaming: true,
          conversationStreams: streams
        }
      })
    }
  }

  streamingInternals.resetAccumulator(conversationId)
}
