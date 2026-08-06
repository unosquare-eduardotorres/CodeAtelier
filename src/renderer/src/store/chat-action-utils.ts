/**
 * chat-action-utils.ts — Pure utility functions extracted from chat.store.ts
 * action methods (stopGeneration, sendMessage) to reduce duplication and
 * improve testability.
 *
 * All functions are stateless — they build data objects but never call
 * set()/get() or perform side effects.
 */

import type { StreamSegment } from '../utils/stream-segment-accumulator'
import type { Message, ToolActivity, GrillQuestion, ConversationPhase } from '../../../shared/types'

// ── Per-conversation streaming state (MULTI-CHAT-06) ──────────────────────

/**
 * Snapshot of streaming state for a single conversation.
 * Stored in `conversationStreams` so background conversations retain their
 * streaming progress while the user views another conversation.
 */
export interface PerConversationStreamState {
  streamingContent: string
  streamingSegments: StreamSegment[]
  streamingRole: 'specialist'
  streamingSpecialist: string | null
  streamingTaskId: string | null
  streamingPhase: ConversationPhase | null
  activeRequestId: string | null
  isStreaming: boolean
  toolActivities: ToolActivity[]
  pendingQuestions: GrillQuestion[] | null
  pendingQuestionAction: string | null
  pendingQuestionRequestId: string | null
}

/** Build an empty per-conversation stream state. */
export function emptyStreamState(): PerConversationStreamState {
  return {
    streamingContent: '',
    streamingSegments: [],
    streamingRole: 'specialist',
    streamingSpecialist: null,
    streamingTaskId: null,
    streamingPhase: null,
    activeRequestId: null,
    isStreaming: false,
    toolActivities: [],
    pendingQuestions: null,
    pendingQuestionAction: null,
    pendingQuestionRequestId: null
  }
}

/**
 * Capture the currently active streaming state into a per-conversation snapshot.
 * Used when switching away from a streaming conversation.
 */
export function captureStreamState(state: {
  streamingContent: string
  streamingSegments: StreamSegment[]
  streamingRole: 'specialist'
  streamingSpecialist: string | null
  streamingTaskId: string | null
  streamingPhase: ConversationPhase | null
  activeRequestId: string | null
  isStreaming: boolean
  toolActivities: ToolActivity[]
  pendingQuestions: GrillQuestion[] | null
  pendingQuestionAction: string | null
  pendingQuestionRequestId: string | null
}): PerConversationStreamState {
  return {
    streamingContent: state.streamingContent,
    streamingSegments: [...state.streamingSegments],
    streamingRole: state.streamingRole,
    streamingSpecialist: state.streamingSpecialist,
    streamingTaskId: state.streamingTaskId,
    streamingPhase: state.streamingPhase,
    activeRequestId: state.activeRequestId,
    isStreaming: state.isStreaming,
    toolActivities: [...state.toolActivities],
    pendingQuestions: state.pendingQuestions ? [...state.pendingQuestions] : null,
    pendingQuestionAction: state.pendingQuestionAction,
    pendingQuestionRequestId: state.pendingQuestionRequestId
  }
}

// ── Streaming state reset ────────────────────────────────────────────────

/** Fields common to every "stop streaming" state transition. */
interface StreamingResetPatch {
  streamingContent: ''
  streamingSegments: []
  isStreaming: boolean
  toolActivities: []
  activeRequestId: null
  // IMP-R8-1: Include streaming identity fields to prevent stale display
  streamingPhase: null
  streamingSpecialist: null
  streamingTaskId: null
  conversationState: { phase: 'idle'; from: null; event: null; conversationId: null }
  streamingConversationIds: Set<string>
  streamStalledConversationId: null // STALL-DETECT-05: Defense-in-depth — always clear stall flag on stream reset
}

/**
 * Build the common state patch for resetting streaming state.
 * Removes `conversationId` from the active streaming set if provided.
 */
export function buildStreamingResetState(
  conversationId: string | null,
  streamingConversationIds: Set<string>
): StreamingResetPatch {
  const newStreamingIds = new Set(streamingConversationIds)
  if (conversationId) newStreamingIds.delete(conversationId)
  return {
    streamingContent: '',
    streamingSegments: [],
    // BUG-R5-1: The active conversation just stopped — isStreaming always false.
    // Background streams are tracked by streamingConversationIds, not this flag.
    isStreaming: false,
    toolActivities: [],
    activeRequestId: null,
    // IMP-R8-1: Clear streaming identity to prevent stale specialist avatar
    // or phase label from flashing during the stop → re-send gap.
    streamingPhase: null,
    streamingSpecialist: null,
    streamingTaskId: null,
    conversationState: { phase: 'idle', from: null, event: null, conversationId: null },
    streamingConversationIds: newStreamingIds,
    streamStalledConversationId: null // STALL-DETECT-05: Defense-in-depth — always clear stall flag on stream reset
  }
}

// ── Segment merging ──────────────────────────────────────────────────────

/**
 * Merge finalized streaming segments + any remaining current content into
 * a single text block, and coalesce tool activities (marking stale
 * "running" entries as "completed").
 */
export function mergeChatSegments(
  segments: StreamSegment[],
  currentContent: string | undefined
): { mergedContent: string; mergedTools: ToolActivity[] } {
  const mergedContent = [...segments.map((s) => s.content), currentContent || '']
    .map((c) => c.trim())
    .filter(Boolean)
    .join('\n\n')

  const mergedTools = [...segments.flatMap((s) => s.toolActivities)].map((a) =>
    a.status === 'running' ? { ...a, status: 'completed' as const } : a
  )

  return { mergedContent, mergedTools }
}

// ── Message builders ─────────────────────────────────────────────────────

/**
 * Build the `Message` object for a stopped generation (user pressed stop).
 * Appends a "stopped" suffix to whatever content was streamed.
 */
export function createStoppedMessage(
  conversationId: string,
  mergedContent: string,
  mergedTools: ToolActivity[],
  role: 'specialist',
  specialist: string | null,
  segments: StreamSegment[]
): Message {
  return {
    id: `stopped-${crypto.randomUUID().slice(0, 8)}`,
    conversationId,
    role,
    ...(role === 'specialist' && specialist ? { agentId: specialist } : {}),
    contentMd: (mergedContent || '') + '\n\n---\n\n⏹ *Generation stopped by user.*',
    attachmentsJson: '[]',
    createdAt:
      segments.length > 0
        ? new Date(segments[0].timestamp).toISOString()
        : new Date().toISOString(),
    toolActivities: mergedTools.length > 0 ? mergedTools : undefined
  }
}

/**
 * Build an optimistic user message for immediate display before the
 * backend round-trip completes.
 */
export function createOptimisticUserMessage(
  conversationId: string,
  text: string,
  attachments?: string[]
): Message {
  return {
    id: `temp-${crypto.randomUUID().slice(0, 8)}`,
    conversationId,
    role: 'user',
    contentMd: text,
    attachmentsJson: attachments ? JSON.stringify(attachments) : '[]',
    createdAt: new Date().toISOString()
  }
}

// ── Error parsing ───────────────────────────────────────────────────────

/** Prefix Electron IPC adds to remote-method errors. */
const IPC_ERROR_PREFIX_RE = /^Error invoking remote method '[^']+': /

/** Escape markdown-significant chars so a title can't break error-bubble formatting. */
const escapeMarkdown = (s: string): string => s.replace(/([\\*_`~[\]])/g, '\\$1')

/**
 * Parse the F6 `(blockedBy:<uuid>)` tag from a raw backend error string,
 * resolve the blocking conversation's title when possible, and build a
 * clean user-facing message.
 *
 * The raw error arrives as:
 *   "Another chat is still processing. … (blockedBy:<uuid>)"
 * Electron's IPC may also wrap it with:
 *   "Error invoking remote method 'chat:sendMessage': …"
 *
 * When the title is known → "Another chat ("<title>") is still processing…"
 * When unknown           → "Another chat is still processing…" (no parenthetical)
 *
 * Pure function — no DOM/store deps; importable from the main-process test harness.
 *
 * @see chat-stream.service.ts acquireStreamLock — F6-FIX throws the tagged error.
 */
export function parseBlockedByError(
  rawError: string,
  conversations: Array<{ id: string; title: string }>
): { errorMsg: string; blockedConvId?: string; blockedConvTitle?: string } {
  const blockedByMatch = rawError.match(/\(blockedBy:([^)]+)\)/)
  if (!blockedByMatch) {
    // Not a blocked-by error — strip IPC prefix only
    return { errorMsg: rawError.replace(IPC_ERROR_PREFIX_RE, '') }
  }

  const blockedConvId = blockedByMatch[1]
  const blockedConv = conversations.find((c) => c.id === blockedConvId)

  // P1-FIX: Build the whole message conditionally.
  // Known title  → Another chat ("My Chat") is still processing…
  // Unknown      → Another chat is still processing… (no redundant parenthetical)
  const errorMsg = blockedConv
    ? `Another chat ("${escapeMarkdown(blockedConv.title)}") is still processing. Please wait for it to complete or stop it first.`
    : 'Another chat is still processing. Please wait for it to complete or stop it first.'

  // MULTI-CHAT-04: Return blocking conversation info so the UI can offer
  // actionable "Switch to it" / "Stop it" buttons.
  return { errorMsg, blockedConvId, blockedConvTitle: blockedConv?.title }
}

// ── Stop reconciliation ──────────────────────────────────────

/**
 * WEDGE-RECOVERY: after a stop, reconcile the local send/stream flags against
 * main.  `sendingConversationIds` is set before the send IPC and cleared in its
 * finally — if that path is ever skipped the input stays disabled while nothing
 * is actually running, and one Stop click must be enough to recover.
 *
 * Returns the state patch to apply, or `null` when nothing should change:
 * either main is still streaming, or the query failed (in which case the local
 * state is the only state we have and must not be clobbered).
 */
export async function reconcileStopState(
  fetchStreamingState: () => Promise<{ isStreaming: boolean }>,
  /** Read lazily — a send may have started during the IPC round-trip. */
  readSendingConversationIds: () => Set<string>,
  activeConversationId: string | null | undefined,
  onError?: (error: unknown) => void
): Promise<{ isStreaming: false; sendingConversationIds: Set<string> } | null> {
  try {
    const backendState = await fetchStreamingState()
    if (backendState.isStreaming) return null
    const remaining = new Set(readSendingConversationIds())
    if (activeConversationId) remaining.delete(activeConversationId)
    return { isStreaming: false, sendingConversationIds: remaining }
  } catch (error) {
    onError?.(error)
    return null
  }
}

// ── Message builders (continued) ────────────────────────────────────────

/**
 * Build an error message shown to the user when sendMessage fails.
 */
export function createErrorMessage(conversationId: string, errorMsg: string): Message {
  return {
    id: `error-${Date.now()}`,
    conversationId,
    role: 'specialist',
    contentMd: `**Failed to send message:** ${errorMsg}`,
    attachmentsJson: '[]',
    createdAt: new Date().toISOString()
  }
}
