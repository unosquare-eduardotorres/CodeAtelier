import fs from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'
import {
  conversationRepository,
  workspaceRepository,
  blueprintRepository
} from '../db/repositories'
import { trackService } from '../services/track.service'

const viewerLog = log.scope('file-viewer')

/** Hard cap on file size served to the viewer — 1 MB. */
const MAX_FILE_BYTES = 1024 * 1024

/** Files larger than this are still served but without a highlight hint. */
const BINARY_SNIFF_BYTES = 8192

export interface FileViewerContent {
  content: string
  /** Size in bytes of the raw file. */
  size: number
  /** True when the content was clipped by the size cap. */
  truncated: boolean
}

/**
 * Read a workspace file for the file viewer. The path is resolved against the
 * workspace root and must stay inside it — this is a boundary check, not a
 * pattern allowlist: any file in the workspace is viewable, nothing outside is.
 * Exported for unit tests (pure fs logic, no Electron dependency in this path).
 */
export function readWorkspaceFile(workspacePath: string, filePath: string): FileViewerContent {
  const root = path.resolve(workspacePath)
  const resolved = path.resolve(root, filePath)

  // Containment: resolved path must sit under the workspace root. path.sep
  // prefix prevents sibling-directory prefix attacks (/ws vs /ws-evil).
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Access denied: path escapes workspace root — ${filePath}`)
  }

  const stat = fs.statSync(resolved, { throwIfNoEntry: false })
  if (!stat) throw new Error(`File not found: ${filePath}`)
  if (stat.isDirectory()) throw new Error(`Not a file: ${filePath}`)

  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `File too large to display (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit 1 MB) — ${filePath}`
    )
  }

  // Binary sniff: a NUL byte in the first 8K means this is not text.
  const fd = fs.openSync(resolved, 'r')
  try {
    const probe = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stat.size))
    const bytesRead = fs.readSync(fd, probe, 0, probe.length, 0)
    if (probe.subarray(0, bytesRead).includes(0)) {
      throw new Error(`Binary file — cannot display: ${filePath}`)
    }
  } finally {
    fs.closeSync(fd)
  }

  const raw = fs.readFileSync(resolved)
  const content = raw.toString('utf8')
  return { content, size: stat.size, truncated: false }
}

/** Context identifying which tree a viewer read should run against. */
export interface ViewerRootCtx {
  conversationId?: string
  blueprintId?: string
  workspacePath?: string
}

/** Primary checkout path for the workspace a conversation belongs to. */
function conversationRepoPath(conversationId: string): string {
  const conversation = conversationRepository.findById(conversationId)
  if (!conversation) {
    throw new Error(`FILES_VIEWER_READ: conversation not found — ${conversationId}`)
  }
  const workspace = workspaceRepository.findById(conversation.workspaceId)
  if (!workspace) {
    throw new Error('FILES_VIEWER_READ: workspace not found for conversation')
  }
  return workspace.repoPath
}

/** Primary checkout path for the workspace a blueprint belongs to. */
function blueprintRepoPath(blueprintId: string): string {
  const blueprint = blueprintRepository.findById(blueprintId)
  if (!blueprint) {
    throw new Error(`FILES_VIEWER_READ: blueprint not found — ${blueprintId}`)
  }
  const workspace = workspaceRepository.findById(blueprint.workspaceId)
  if (!workspace) {
    throw new Error('FILES_VIEWER_READ: workspace not found for blueprint')
  }
  return workspace.repoPath
}

/**
 * Resolve the root a viewer read should run against. Track-aware: a chat file
 * must be read from the conversation's worktree (branch-per-chat), a blueprint
 * file from the blueprint's execution track. `resolveTrack`/`resolve` never
 * create anything and fall back to the primary checkout when no track row
 * exists, so non-isolated owners keep working unchanged.
 *
 * Resolution order: conversationId → blueprintId → explicit workspacePath →
 * error. Defense in depth: a conversationId that fails to resolve (synthetic
 * ids like 'streaming' from live surfaces, a deleted conversation behind a
 * stale recents entry) degrades to the explicit workspacePath — the primary
 * checkout — instead of an error card; only when both fail do we throw.
 * Exported for unit tests.
 */
export function resolveViewerRoot(ctx: ViewerRootCtx): string {
  if (ctx.conversationId) {
    try {
      return trackService.resolve(ctx.conversationId, conversationRepoPath(ctx.conversationId)).path
    } catch (err) {
      if (ctx.workspacePath && ctx.workspacePath.trim()) {
        viewerLog.warn(
          `[resolveViewerRoot] conversationId '${ctx.conversationId}' unresolvable ` +
            `(${(err as Error).message}) — falling back to workspacePath`
        )
        return ctx.workspacePath
      }
      throw err
    }
  }
  if (ctx.blueprintId) {
    return trackService.resolveTrack(
      'blueprint',
      ctx.blueprintId,
      blueprintRepoPath(ctx.blueprintId)
    ).path
  }
  if (ctx.workspacePath && ctx.workspacePath.trim()) return ctx.workspacePath
  throw new Error(
    'FILES_VIEWER_READ: one of conversationId, blueprintId or workspacePath is required'
  )
}

export function registerFileViewerIpc(): void {
  ipcMain.handle(IPC_CHANNELS.FILES_VIEWER_READ, (event, rawArgs: unknown): FileViewerContent => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.FILES_VIEWER_READ)
    const filePath = requireString(args, 'filePath', IPC_CHANNELS.FILES_VIEWER_READ)
    const conversationId = optionalString(args, 'conversationId', IPC_CHANNELS.FILES_VIEWER_READ)
    const blueprintId = optionalString(args, 'blueprintId', IPC_CHANNELS.FILES_VIEWER_READ)
    const workspacePath = optionalString(args, 'workspacePath', IPC_CHANNELS.FILES_VIEWER_READ)

    // Containment applies to the RESOLVED root — the track worktree when one
    // exists, the primary checkout otherwise — never to the raw arg.
    return readWorkspaceFile(
      resolveViewerRoot({ conversationId, blueprintId, workspacePath }),
      filePath
    )
  })
}
