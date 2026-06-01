import type { BrowserWindow } from 'electron'
import type { StreamChunk } from '../services'
import type { ConversationPhase } from '../../shared/types'
import { routeChunk } from './chunk-router'

/**
 * Shared helper to forward a StreamChunk to the renderer.
 * Delegates to the ChunkRouter dispatch table (see chunk-router.ts).
 */
export function forwardChunkToRenderer(
  mainWindow: BrowserWindow,
  conversationId: string,
  role: 'da-vinci' | 'specialist',
  chunk: StreamChunk,
  contentAccumulator: { value: string },
  workspacePath?: string,
  specialistMeta?: { specialist: string; taskId?: string },
  phase?: ConversationPhase,
  requestId?: string
): void {
  routeChunk(
    { mainWindow, conversationId, role, contentAccumulator, workspacePath, specialistMeta, phase, requestId },
    chunk
  )
}
