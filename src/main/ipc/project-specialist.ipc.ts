/**
 * IPC handlers for Project Specialist management.
 *
 * Surfaces:
 *   - Get / List (one per workspace, plus a list call for Settings)
 *   - Build / Rebuild prompt / Rebuild skills (LLM-driven + fast paths)
 *   - Update prompt (manual edit from the slide-over Prompt tab)
 *   - Toggle skill enabled/disabled + attach/detach skill
 *   - Get stack drift (non-blocking banner)
 *
 * MCP tool availability is a workspace-level concern (configured from the
 * workspace settings UI) and is NOT per-specialist — there is no toggle-MCP
 * handler here.
 *
 * The BUILD_PROGRESS channel is an event channel (main → renderer) used to
 * stream build status updates into the inline BuildProgress UI.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { getDatabase } from '../db/index'
import { specialistRepository } from '../db/repositories'
import { specialistBuilderService } from '../services/specialist-builder.service'
import { stackDriftDetectorService } from '../services/stack-drift-detector.service'
import { validateSender } from './validate-sender'
import log from 'electron-log'

const psLog = log.scope('project-specialist-ipc')

interface ProjectSpecialistRow {
  id: string
  workspace_id: string
  agent_id: string
  display_name: string
  icon: string
  color: string
  prompt: string
  build_status: 'pending' | 'building' | 'ready' | 'failed'
  stack_fingerprint: string | null
  detected_techs: string
  last_built_at: string | null
  created_at: string
  updated_at: string
}

function emitProgress(specialistId: string, phase: string, message: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.PROJECT_SPECIALIST_BUILD_PROGRESS, {
      specialistId,
      phase,
      message,
      at: new Date().toISOString()
    })
  }
}

function loadRow(workspaceId: string): ProjectSpecialistRow | undefined {
  const db = getDatabase()
  return db
    .prepare(
      `SELECT id, workspace_id, agent_id, display_name, icon, color, prompt, build_status,
              stack_fingerprint, detected_techs, last_built_at,
              created_at, updated_at
         FROM specialists WHERE workspace_id = ?`
    )
    .get(workspaceId) as ProjectSpecialistRow | undefined
}

function serializeRow(row: ProjectSpecialistRow): Record<string, unknown> {
  let detectedTechs: string[] = []
  try {
    detectedTechs = JSON.parse(row.detected_techs || '[]')
  } catch {
    detectedTechs = []
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    displayName: row.display_name,
    icon: row.icon,
    color: row.color,
    prompt: row.prompt,
    buildStatus: row.build_status,
    stackFingerprint: row.stack_fingerprint,
    detectedTechs,
    lastBuiltAt: row.last_built_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function loadSkillsForSpecialist(specialistId: string): Array<{
  id: string
  name: string
  description: string | null
  filename: string
  isEnabled: boolean
}> {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.description, s.filename, ss.is_enabled
         FROM specialist_skills ss
         JOIN skills s ON s.id = ss.skill_id
        WHERE ss.specialist_id = ?
        ORDER BY s.name`
    )
    .all(specialistId) as Array<{
    id: string
    name: string
    description: string | null
    filename: string
    is_enabled: number
  }>
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    filename: r.filename,
    isEnabled: r.is_enabled === 1
  }))
}

export function registerProjectSpecialistIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_GET,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('Invalid workspaceId')
      const row = loadRow(args.workspaceId)
      if (!row) return null
      const serialized = serializeRow(row)
      serialized.skills = loadSkillsForSpecialist(row.id)
      return serialized
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_BUILD,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('Invalid workspaceId')
      const row = loadRow(args.workspaceId)
      if (!row) throw new Error(`No Project Specialist for workspace ${args.workspaceId}`)
      emitProgress(row.id, 'started', 'Building specialist for this project…')
      try {
        const result = await specialistBuilderService.buildProjectSpecialist(args.workspaceId)
        emitProgress(row.id, 'ready', `Ready — ${result.detectedTechs.length} techs detected`)
        return result
      } catch (err) {
        emitProgress(row.id, 'failed', (err as Error).message)
        throw err
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_REBUILD_PROMPT,
    async (event, args: { specialistId: string }) => {
      validateSender(event)
      if (!args?.specialistId) throw new Error('Invalid specialistId')
      emitProgress(args.specialistId, 'started', 'Rebuilding prompt…')
      try {
        const result = await specialistBuilderService.rebuildPrompt(args.specialistId)
        emitProgress(args.specialistId, 'ready', 'Prompt rebuilt')
        return result
      } catch (err) {
        emitProgress(args.specialistId, 'failed', (err as Error).message)
        throw err
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_REBUILD_SKILLS,
    async (event, args: { specialistId: string }) => {
      validateSender(event)
      if (!args?.specialistId) throw new Error('Invalid specialistId')
      return specialistBuilderService.rebuildSkills(args.specialistId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_UPDATE_PROMPT,
    async (event, args: { specialistId: string; prompt: string }) => {
      validateSender(event)
      if (!args?.specialistId) throw new Error('Invalid specialistId')
      if (typeof args.prompt !== 'string') throw new Error('Invalid prompt')
      const db = getDatabase()
      db.prepare(
        `UPDATE specialists SET prompt = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(args.prompt, args.specialistId)
      psLog.info(`Prompt updated for specialist ${args.specialistId} (${args.prompt.length} chars)`)
      return { ok: true }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_TOGGLE_SKILL,
    async (event, args: { specialistId: string; skillId: string; enabled: boolean }) => {
      validateSender(event)
      if (!args?.specialistId || !args?.skillId) throw new Error('Invalid args')
      const db = getDatabase()
      db.prepare(
        `UPDATE specialist_skills SET is_enabled = ?
           WHERE specialist_id = ? AND skill_id = ?`
      ).run(args.enabled ? 1 : 0, args.specialistId, args.skillId)
      return { ok: true }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_ATTACH_SKILL,
    async (event, args: { specialistId: string; skillId: string }) => {
      validateSender(event)
      if (!args?.specialistId || !args?.skillId) throw new Error('Invalid args')
      specialistRepository.assignSkill(args.specialistId, args.skillId)
      return { ok: true }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_DETACH_SKILL,
    async (event, args: { specialistId: string; skillId: string }) => {
      validateSender(event)
      if (!args?.specialistId || !args?.skillId) throw new Error('Invalid args')
      specialistRepository.removeSkill(args.specialistId, args.skillId)
      return { ok: true }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_GET_DRIFT,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('Invalid workspaceId')
      return stackDriftDetectorService.detectForWorkspace(args.workspaceId)
    }
  )
}
