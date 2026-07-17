/**
 * chat-action-utils.ts — Pure utility functions extracted from chat.store.ts
 * action methods (stopGeneration, sendMessage) to reduce duplication and
 * improve testability.
 *
 * All functions are stateless — they build data objects but never call
 * set()/get() or perform side effects.
 */

import type { StreamSegment } from '@renderer/utils/stream-segment-accumulator'
import type { Message, ToolActivity } from '../../../shared/types'

// ── Streaming state reset ────────────────────────────────────────────────

/** Fields common to every "stop streaming" state transition. */
interface StreamingResetPatch {
  streamingContent: ''
  streamingSegments: []
  isStreaming: false
  toolActivities: []
  activeRequestId: null
  conversationState: { phase: 'idle'; from: null; event: null; conversationId: null }
  streamingConversationIds: Set<string>
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
    isStreaming: false,
    toolActivities: [],
    activeRequestId: null,
    conversationState: { phase: 'idle', from: null, event: null, conversationId: null },
    streamingConversationIds: newStreamingIds
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
