/**
 * IPC handlers for project creation (Create New Project wizard).
 *
 * Handles creating a new project directory, generating CLAUDE.md via AI,
 * and registering the workspace in the database.
 *
 * The wizard creates the workspace EARLY (before the grill step) so the
 * greenfield grill runs workspace-backed. Creation is therefore split:
 *   - `createShell`     — folder + attachments + workspace/specialist rows (no CLAUDE.md)
 *   - `writeBlueprint`  — generate + write CLAUDE.md (deferred until grill decisions exist)
 *   - `discardShell`    — undo a shell on wizard abandon (DB cascade + on-disk folder)
 * `PROJECT_CREATE` remains a thin shell+blueprint wrapper for the skip-grill path.
 */

import { ipcMain } from 'electron'
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { IPC_CHANNELS } from '../../shared/constants'
import type { GrillDecision, GrillTrackScore, Workspace } from '../../shared/types'
import { workspaceRepository } from '../db/repositories'
import { grillSessionRepository } from '../db/repositories/grill-session.repository'
import { generateClaudeMd } from '../services/claude-md-generator'
import { validateSender } from './validate-sender'
import { getDatabase } from '../db/index'
import log from 'electron-log'

const projectLog = log.scope('project-ipc')

interface CreateShellArgs {
  name: string
  parentFolder: string
  description?: string
  attachments?: string[]
  tempGrillSessionId?: string
}

interface BlueprintArgs {
  projectName: string
  description?: string
  grillDecisions?: GrillDecision[]
  trackScores?: GrillTrackScore[]
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Create the project directory + workspace/specialist DB rows. Does NOT generate
 * CLAUDE.md — that's deferred to `writeBlueprint` so grill decisions can be folded in.
 */
function createShell(args: CreateShellArgs): Workspace {
  const { name, parentFolder, description, attachments, tempGrillSessionId } = args

  // ── Validate inputs ──
  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 255) {
    throw new Error('Invalid project name: must be a non-empty string (max 255 chars)')
  }
  if (!parentFolder || typeof parentFolder !== 'string' || parentFolder.trim().length === 0) {
    throw new Error('Invalid parent folder path')
  }

  const normalizedParent = resolve(parentFolder)
  if (!existsSync(normalizedParent)) {
    throw new Error(`Parent folder does not exist: ${normalizedParent}`)
  }

  const projectPath = join(normalizedParent, name.trim())
  if (existsSync(projectPath)) {
    throw new Error(`A folder named "${name.trim()}" already exists at ${normalizedParent}`)
  }

  projectLog.info(`[project:shell] Creating project "${name}" at ${projectPath}`)

  // ── Create the project directory ──
  try {
    mkdirSync(projectPath, { recursive: true })
    projectLog.info(`[project:shell] Directory created: ${projectPath}`)
  } catch (err) {
    throw new Error(
      `Failed to create project directory: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  // ── Copy attachments into project ──
  if (attachments && attachments.length > 0) {
    const contextDir = join(projectPath, '.context')
    try {
      mkdirSync(contextDir, { recursive: true })
      for (const srcPath of attachments) {
        if (existsSync(srcPath)) {
          const fileName = basename(srcPath)
          copyFileSync(srcPath, join(contextDir, fileName))
        }
      }
      projectLog.info(`[project:shell] ${attachments.length} attachment(s) copied to .context/`)
    } catch (err) {
      projectLog.error('[project:shell] Failed to copy attachments:', err)
      // Non-fatal — project still usable
    }
  }

  // ── Register workspace in DB ──
  const workspace = workspaceRepository.create(
    name.trim() || basename(projectPath),
    projectPath,
    undefined, // no git remote
    false // not a git repo
  )
  projectLog.info(`[project:shell] Workspace registered: ${workspace.id}`)



  // ── Seed Project Specialist row ──
  try {
    const db = getDatabase()
    const existing = db
      .prepare(`SELECT id FROM specialists WHERE workspace_id = ?`)
      .get(workspace.id) as { id: string } | undefined
    if (!existing) {
      db.prepare(
        `INSERT INTO specialists (workspace_id, agent_id, display_name, icon, color,
           prompt, priority, is_active, build_status, created_at, updated_at)
         VALUES (?, ?, ?, '🔧', '#6366F1', '', 1, 1, 'pending', datetime('now'), datetime('now'))`
      ).run(workspace.id, `workspace-specialist-${workspace.id}`, `${workspace.name} Specialist`)
      projectLog.info(`[project:shell] Seeded Project Specialist for workspace ${workspace.id}`)
    }
  } catch (err) {
    projectLog.warn('[project:shell] Failed to seed Project Specialist:', err)
  }

  // ── Link temporary grill session (if applicable) ──
  if (tempGrillSessionId) {
    try {
      grillSessionRepository.linkToWorkspace(tempGrillSessionId, workspace.id)
      projectLog.info(
        `[project:shell] Linked grill session ${tempGrillSessionId} to workspace ${workspace.id}`
      )
    } catch (err) {
      projectLog.warn('[project:shell] Failed to link grill session:', err)
    }
  }

  // Best-effort: avoid orphaning the description until the blueprint runs.
  void description
  return workspace
}

/**
 * Generate CLAUDE.md (AI, folding in grill decisions) and write it to the project
 * root. Falls back to a minimal template if generation fails. Idempotent — safe
 * to call once the grill has produced decisions.
 */
async function writeBlueprint(projectPath: string, args: BlueprintArgs): Promise<void> {
  const { projectName, description, grillDecisions, trackScores } = args

  let claudeMdContent: string
  try {
    claudeMdContent = await generateClaudeMd({
      projectName: projectName.trim(),
      description: description || '',
      grillDecisions: grillDecisions ?? [],
      trackScores: trackScores ?? []
    })
    projectLog.info(`[project:blueprint] CLAUDE.md generated (${claudeMdContent.length} chars)`)
  } catch (err) {
    projectLog.error('[project:blueprint] CLAUDE.md generation failed:', err)
    claudeMdContent = `# Project: ${projectName.trim()}\n\n## Overview\n\n${description || 'No description provided.'}\n`
  }

  try {
    writeFileSync(join(projectPath, 'CLAUDE.md'), claudeMdContent, 'utf-8')
    projectLog.info(`[project:blueprint] CLAUDE.md written to ${projectPath}`)
  } catch (err) {
    projectLog.error('[project:blueprint] Failed to write CLAUDE.md:', err)
    // Non-fatal — workspace can still be used
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerProjectIpc(): void {
  // Full create (shell + blueprint) — used by the skip-grill path / backward compat.
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_CREATE,
    async (
      event,
      args: {
        name: string
        parentFolder: string
        description: string
        attachments?: string[]
        grillDecisions?: GrillDecision[]
        trackScores?: GrillTrackScore[]
        tempGrillSessionId?: string
      }
    ) => {
      validateSender(event)
      const workspace = createShell(args)
      await writeBlueprint(workspace.repoPath, {
        projectName: args.name,
        description: args.description,
        grillDecisions: args.grillDecisions,
        trackScores: args.trackScores
      })
      return workspace
    }
  )

  // Shell only — create the workspace BEFORE the grill step (no CLAUDE.md yet).
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_CREATE_SHELL,
    async (event, args: CreateShellArgs): Promise<Workspace> => {
      validateSender(event)
      return createShell(args)
    }
  )

  // Finalize — generate + write CLAUDE.md for an already-created workspace.
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_FINALIZE_BLUEPRINT,
    async (
      event,
      args: {
        workspaceId: string
        projectName: string
        description?: string
        grillDecisions?: GrillDecision[]
        trackScores?: GrillTrackScore[]
      }
    ): Promise<void> => {
      validateSender(event)
      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        throw new Error(`Workspace not found: ${args.workspaceId}`)
      }
      await writeBlueprint(workspace.repoPath, {
        projectName: args.projectName,
        description: args.description,
        grillDecisions: args.grillDecisions,
        trackScores: args.trackScores
      })
    }
  )

  // Discard a shell on wizard abandon — DB cascade + remove the on-disk folder.
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_DISCARD_SHELL,
    async (event, args: { workspaceId: string }): Promise<void> => {
      validateSender(event)
      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) {
        projectLog.warn(
          `[project:discard] Workspace not found (already gone?): ${args.workspaceId}`
        )
        return
      }
      const repoPath = workspace.repoPath

      // DB cascade (conversations, ideas, grill sessions, specialists, …).
      try {
        workspaceRepository.delete(args.workspaceId)
      } catch (err) {
        projectLog.error('[project:discard] Failed to delete workspace row:', err)
      }

      // Remove the on-disk folder we created. Guard against deleting a root /
      // non-existent path; only remove a real, nested project directory.
      try {
        const normalized = resolve(repoPath)
        if (normalized && normalized !== resolve('/') && existsSync(normalized)) {
          rmSync(normalized, { recursive: true, force: true })
          projectLog.info(`[project:discard] Removed project folder: ${normalized}`)
        }
      } catch (err) {
        projectLog.error('[project:discard] Failed to remove project folder:', err)
      }
    }
  )
}
