import type { BrowserWindow } from 'electron'
import type { StreamChunk } from '../services'
import type { ConversationMode, ConversationPhase } from '../../shared/types'
import { routeChunk } from './chunk-router'

// ── Chunk Tap Registry (E2E testing) ──
// Allows the E2E runner to capture transcript chunks without
// altering renderer behavior. Listeners are called synchronously
// before the chunk is routed to handlers.

type ChunkTapCallback = (requestId: string | undefined, chunk: StreamChunk) => void
const chunkTapListeners = new Map<string, ChunkTapCallback>()

export function registerChunkTap(key: string, cb: ChunkTapCallback): void {
  chunkTapListeners.set(key, cb)
}

export function unregisterChunkTap(key: string): void {
  chunkTapListeners.delete(key)
}

/**
 * R6-B2: Notify chunk-tap listeners directly (bypasses renderer routing).
 * Used by prompt optimizer to make optimization visible in E2E transcripts.
 * No-op when no taps are registered (normal app operation).
 */
export function notifyChunkTaps(requestId: string | undefined, chunk: StreamChunk): void {
  if (chunkTapListeners.size === 0) return
  for (const cb of chunkTapListeners.values()) {
    try {
      cb(requestId, chunk)
    } catch { /* tap errors must not break streaming */ }
  }
}

/**
 * Shared helper to forward a StreamChunk to the renderer.
 * Delegates to the ChunkRouter dispatch table (see chunk-router.ts).
 */
export function forwardChunkToRenderer(
  mainWindow: BrowserWindow,
  conversationId: string,
  role: 'specialist',
  chunk: StreamChunk,
  contentAccumulator: { value: string },
  workspacePath?: string,
  specialistMeta?: { specialist: string; taskId?: string },
  phase?: ConversationPhase,
  requestId?: string,
  mode?: ConversationMode
): void {
  // Notify chunk-tap listeners (E2E testing) before routing
  if (chunkTapListeners.size > 0) {
    for (const cb of chunkTapListeners.values()) {
      try {
        cb(requestId, chunk)
      } catch { /* tap errors must not break streaming */ }
    }
  }

  routeChunk(
    {
      mainWindow,
      conversationId,
      role,
      contentAccumulator,
      workspacePath,
      specialistMeta,
      phase,
      requestId,
      mode
    },
    chunk
  )
}
