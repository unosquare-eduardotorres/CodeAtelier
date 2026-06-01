/**
 * IPC handlers for project creation (Create New Project wizard).
 *
 * Handles creating a new project directory, generating CLAUDE.md via AI,
 * and registering the workspace in the database.
 */

import { ipcMain } from 'electron'
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { IPC_CHANNELS } from '../../shared/constants'
import type { GrillDecision, GrillTrackScore } from '../../shared/types'
import { workspaceRepository } from '../db/repositories'
import { grillSessionRepository } from '../db/repositories/grill-session.repository'
import { generateClaudeMd } from '../services/claude-md-generator'
import { validateSender } from './validate-sender'
import { getDatabase } from '../db/index'
import log from 'electron-log'

const projectLog = log.scope('project-ipc')

export function registerProjectIpc(): void {
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

      const {
        name,
        parentFolder,
        description,
        attachments,
        grillDecisions,
        trackScores,
        tempGrillSessionId
      } = args

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

      projectLog.info(`[project:create] Creating project "${name}" at ${projectPath}`)

      // ── Step 1: Create the project directory ──
      try {
        mkdirSync(projectPath, { recursive: true })
        projectLog.info(`[project:create] Directory created: ${projectPath}`)
      } catch (err) {
        throw new Error(
          `Failed to create project directory: ${err instanceof Error ? err.message : String(err)}`
        )
      }

      // ── Step 2: Generate CLAUDE.md ──
      let claudeMdContent: string
      try {
        claudeMdContent = await generateClaudeMd({
          projectName: name.trim(),
          description: description || '',
          grillDecisions: grillDecisions ?? [],
          trackScores: trackScores ?? []
        })
        projectLog.info(`[project:create] CLAUDE.md generated (${claudeMdContent.length} chars)`)
      } catch (err) {
        projectLog.error('[project:create] CLAUDE.md generation failed:', err)
        // Fallback to a minimal template
        claudeMdContent = `# Project: ${name.trim()}\n\n## Overview\n\n${description || 'No description provided.'}\n`
      }

      try {
        writeFileSync(join(projectPath, 'CLAUDE.md'), claudeMdContent, 'utf-8')
        projectLog.info(`[project:create] CLAUDE.md written`)
      } catch (err) {
        projectLog.error('[project:create] Failed to write CLAUDE.md:', err)
        // Non-fatal — workspace can still be registered
      }

      // ── Step 2b: Copy attachments into project ──
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
          projectLog.info(
            `[project:create] ${attachments.length} attachment(s) copied to .context/`
          )
        } catch (err) {
          projectLog.error('[project:create] Failed to copy attachments:', err)
          // Non-fatal — project still usable
        }
      }

      // ── Step 3: Register workspace in DB ──
      const workspace = workspaceRepository.create(
        name.trim() || basename(projectPath),
        projectPath,
        undefined, // no git remote
        false // not a git repo
      )

      projectLog.info(`[project:create] Workspace registered: ${workspace.id}`)

      // ── Step 4: Seed Project Specialist row ──
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
          ).run(
            workspace.id,
            `workspace-specialist-${workspace.id}`,
            `${workspace.name} Specialist`
          )
          projectLog.info(
            `[project:create] Seeded Project Specialist for workspace ${workspace.id}`
          )
        }
      } catch (err) {
        projectLog.warn('[project:create] Failed to seed Project Specialist:', err)
      }

      // ── Step 5: Link temporary grill session (if applicable) ──
      if (tempGrillSessionId) {
        try {
          grillSessionRepository.linkToWorkspace(tempGrillSessionId, workspace.id)
          projectLog.info(
            `[project:create] Linked grill session ${tempGrillSessionId} to workspace ${workspace.id}`
          )
        } catch (err) {
          projectLog.warn('[project:create] Failed to link grill session:', err)
        }
      }

      return workspace
    }
  )
}
