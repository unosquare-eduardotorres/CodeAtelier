import type { BrowserWindow } from 'electron'
import { fileChangeRepository, workspaceRepository } from '../db/repositories'
import type { StreamChunk } from '../services'
import { summarizeToolInput } from '../services'
import { IPC_CHANNELS } from '../../shared/constants'
import { chatIpcLogger } from '../logger'

const log = chatIpcLogger

/**
 * Shared helper to forward a StreamChunk to the renderer.
 * Eliminates duplicated chunk-handling logic between generalist and orchestrator paths.
 */
export function forwardChunkToRenderer(
  mainWindow: BrowserWindow,
  conversationId: string,
  role: 'generalist' | 'coordinator',
  chunk: StreamChunk,
  contentAccumulator: { value: string }
): void {
  if (chunk.type === 'text' && chunk.content) {
    contentAccumulator.value += chunk.content
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: chunk.content,
      role
    })
  } else if (chunk.type === 'tool_use') {
    // Track file changes for Write/Edit tools
    if ((chunk.toolName === 'Write' || chunk.toolName === 'Edit') && chunk.toolInput) {
      try {
        fileChangeRepository.track(
          conversationId,
          chunk.toolInput,
          chunk.toolName === 'Write' ? 'created' : 'modified'
        )
      } catch (e) {
        log.warn('Failed to track file change:', e)
      }
    }
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: '',
      role,
      toolActivity: {
        id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        toolName: chunk.toolName ?? 'Unknown',
        status: 'running',
        input: chunk.toolInput,
        startedAt: Date.now()
      }
    })
  } else if (chunk.type === 'tool_result') {
    let toolInputSummary: string | undefined
    if (chunk.content) {
      try {
        const parsed = JSON.parse(chunk.content) as Record<string, unknown>
        toolInputSummary = summarizeToolInput(chunk.toolName ?? '', parsed)
      } catch {
        toolInputSummary = chunk.content.slice(0, 120)
      }
    }
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: '',
      role,
      toolActivity: {
        id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        toolName: chunk.toolName ?? 'Unknown',
        status: 'completed',
        input: toolInputSummary,
        completedAt: Date.now()
      }
    })
  } else if (chunk.type === 'error') {
    contentAccumulator.value += `\n\n**Error:** ${chunk.error}`
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_MESSAGE_CHUNK, {
      conversationId,
      chunk: `\n\n**Error:** ${chunk.error}`,
      role
    })
  }
}

/** Check if memory writes are enabled for the given workspace path */
export function isMemoryEnabled(workspacePath: string): boolean {
  const workspace = workspaceRepository.findAll().find((w) => w.repoPath === workspacePath)
  if (!workspace) return true // default enabled
  try {
    const settings = JSON.parse(workspace.settingsJson || '{}')
    return settings.memoryEnabled !== false
  } catch {
    return true
  }
}

/** Check if post-specialist code review is enabled for the given workspace path */
export function isPostReviewEnabled(workspacePath: string): boolean {
  const workspace = workspaceRepository.findAll().find((w) => w.repoPath === workspacePath)
  if (!workspace) return false // default disabled — opt-in feature
  try {
    const settings = JSON.parse(workspace.settingsJson || '{}')
    return settings.postReviewEnabled === true
  } catch {
    return false
  }
}
