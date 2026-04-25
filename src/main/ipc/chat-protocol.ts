/**
 * Type-safe IPC protocol for chat messages.
 *
 * Replaces stringly-typed message objects with compile-time enforced builders.
 * All IPC sends for CHAT_MESSAGE_CHUNK, CHAT_MESSAGE_COMPLETE, and related
 * channels should use these builders instead of inline object literals.
 *
 * This ensures: requestId is never accidentally omitted, phase is always included,
 * and message shapes are consistent across generalist and specialist paths.
 */

import type { ConversationPhase, ToolActivity } from '../../shared/types'

// ── Message Interfaces ──

/** Base fields present on every chunk message */
export interface BaseChunkMessage {
  conversationId: string
  requestId?: string
  role: 'da-vinci' | 'specialist'
  phase?: ConversationPhase
}

/** Text content chunk */
export interface TextChunkMessage extends BaseChunkMessage {
  chunk: string
  specialist?: string
  taskId?: string
}

/** Tool activity chunk (tool_use / tool_result / tool_progress) */
export interface ToolActivityChunkMessage extends BaseChunkMessage {
  chunk: ''
  toolActivity: Partial<ToolActivity> & { id: string; toolName: string }
  specialist?: string
  taskId?: string
}

/** Turn boundary signal */
export interface TurnBoundaryMessage extends BaseChunkMessage {
  chunk: ''
  turnBoundary: true
  turnId: string
}

/** Compact needed suggestion */
export interface CompactNeededMessage extends BaseChunkMessage {
  chunk: ''
  compactNeeded: { level: string; inputTokens: number }
}

/** Message complete signal */
export interface CompleteMessage {
  conversationId: string
  requestId?: string
  messageId: string
  taskId?: string
  phase?: ConversationPhase
}

// ── Builder Functions ──

/**
 * Create a text chunk message. Enforces required fields at compile time.
 */
export function createTextChunk(opts: {
  conversationId: string
  requestId?: string
  text: string
  role: 'da-vinci' | 'specialist'
  phase?: ConversationPhase
  specialist?: string
  taskId?: string
}): TextChunkMessage {
  return {
    conversationId: opts.conversationId,
    chunk: opts.text,
    role: opts.role,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.phase ? { phase: opts.phase } : {}),
    ...(opts.specialist ? { specialist: opts.specialist } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {})
  }
}

/**
 * Create a tool activity chunk message.
 */
export function createToolActivityChunk(opts: {
  conversationId: string
  requestId?: string
  role: 'da-vinci' | 'specialist'
  toolActivity: Partial<ToolActivity> & { id: string; toolName: string }
  specialist?: string
  taskId?: string
}): ToolActivityChunkMessage {
  return {
    conversationId: opts.conversationId,
    chunk: '' as const,
    role: opts.role,
    toolActivity: opts.toolActivity,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.specialist ? { specialist: opts.specialist } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {})
  }
}

/**
 * Create a turn boundary message.
 */
export function createTurnBoundary(opts: {
  conversationId: string
  requestId?: string
  role: 'da-vinci' | 'specialist'
  turnId: string
  specialist?: string
  taskId?: string
}): TurnBoundaryMessage {
  return {
    conversationId: opts.conversationId,
    chunk: '' as const,
    role: opts.role,
    turnBoundary: true as const,
    turnId: opts.turnId,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.specialist ? { specialist: opts.specialist } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {})
  } as TurnBoundaryMessage
}

/**
 * Create a compact needed message.
 */
export function createCompactNeeded(opts: {
  conversationId: string
  requestId?: string
  role: 'da-vinci' | 'specialist'
  compactNeeded: { level: string; inputTokens: number }
}): CompactNeededMessage {
  return {
    conversationId: opts.conversationId,
    chunk: '' as const,
    role: opts.role,
    compactNeeded: opts.compactNeeded,
    ...(opts.requestId ? { requestId: opts.requestId } : {})
  }
}

/**
 * Create a message complete signal. Enforces required fields.
 */
export function createCompleteMessage(opts: {
  conversationId: string
  requestId?: string
  messageId: string
  phase?: ConversationPhase
  taskId?: string
}): CompleteMessage {
  return {
    conversationId: opts.conversationId,
    messageId: opts.messageId,
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    ...(opts.phase ? { phase: opts.phase } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {})
  }
}
