import type { BrowserWindow } from 'electron'
import type { StreamChunk } from '../services'
import type { ConversationPhase } from '../../shared/types'
import { routeChunk } from './chunk-router'
import {
  extractResultSummary as _extractResultSummary,
  type ToolResultSummary
} from './tool-result-summarizer'
import { reportToolError as _reportToolError } from './tool-error-reporter'

// Re-export for backward compatibility — consumers import from chat-shared
export type { ToolResultSummary }
export const extractResultSummary = _extractResultSummary
export const reportToolError = _reportToolError

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
