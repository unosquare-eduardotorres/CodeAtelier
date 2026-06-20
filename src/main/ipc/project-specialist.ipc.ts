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
import { safeWindowSend } from './safe-send'
import { requireObject, requireString, optionalBoolean } from './validate-args'
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
  skill_recommendations_json: string | null
}

function emitProgress(specialistId: string, phase: string, message: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    safeWindowSend(win, IPC_CHANNELS.PROJECT_SPECIALIST_BUILD_PROGRESS, {
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
              skill_recommendations_json,
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
  let skillRecommendations: Array<{
    skillId: string
    relevance: number
    rationale: string
  }> | null = null
  try {
    if (row.skill_recommendations_json) {
      const parsed = JSON.parse(row.skill_recommendations_json)
      skillRecommendations = parsed.recommendations ?? null
    }
  } catch {
    skillRecommendations = null
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
    skillRecommendations,
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
  ipcMain.handle(IPC_CHANNELS.PROJECT_SPECIALIST_GET, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.PROJECT_SPECIALIST_GET
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const row = loadRow(workspaceId)
    if (!row) return null
    const serialized = serializeRow(row)
    serialized.skills = loadSkillsForSpecialist(row.id)
    return serialized
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_SPECIALIST_BUILD, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.PROJECT_SPECIALIST_BUILD
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const row = loadRow(workspaceId)
    if (!row) throw new Error(`No Project Specialist for workspace ${workspaceId}`)
    emitProgress(row.id, 'started', 'Building specialist for this project…')
    try {
      const result = await specialistBuilderService.buildProjectSpecialist(workspaceId)
      emitProgress(row.id, 'ready', `Ready — ${result.detectedTechs.length} techs detected`)
      return result
    } catch (err) {
      emitProgress(row.id, 'failed', (err as Error).message)
      throw err
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_REBUILD_PROMPT,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.PROJECT_SPECIALIST_REBUILD_PROMPT
      const args = requireObject(rawArgs, ch)
      const specialistId = requireString(args, 'specialistId', ch)
      emitProgress(specialistId, 'started', 'Rebuilding prompt…')
      try {
        const result = await specialistBuilderService.rebuildPrompt(specialistId)
        emitProgress(specialistId, 'ready', 'Prompt rebuilt')
        return result
      } catch (err) {
        emitProgress(specialistId, 'failed', (err as Error).message)
        throw err
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_REBUILD_SKILLS,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.PROJECT_SPECIALIST_REBUILD_SKILLS
      const args = requireObject(rawArgs, ch)
      const specialistId = requireString(args, 'specialistId', ch)
      return specialistBuilderService.rebuildSkills(specialistId)
    }
  )

  ipcMain.handle(IPC_CHANNELS.PROJECT_SPECIALIST_UPDATE_PROMPT, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.PROJECT_SPECIALIST_UPDATE_PROMPT
    const args = requireObject(rawArgs, ch)
    const specialistId = requireString(args, 'specialistId', ch)
    const prompt = requireString(args, 'prompt', ch)
    const db = getDatabase()
    db.prepare(`UPDATE specialists SET prompt = ?, updated_at = datetime('now') WHERE id = ?`).run(
      prompt,
      specialistId
    )
    psLog.info(`Prompt updated for specialist ${specialistId} (${prompt.length} chars)`)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_SPECIALIST_TOGGLE_SKILL, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.PROJECT_SPECIALIST_TOGGLE_SKILL
    const args = requireObject(rawArgs, ch)
    const specialistId = requireString(args, 'specialistId', ch)
    const skillId = requireString(args, 'skillId', ch)
    const enabled = optionalBoolean(args, 'enabled', ch) ?? false
    const db = getDatabase()
    db.prepare(
      `UPDATE specialist_skills SET is_enabled = ?
           WHERE specialist_id = ? AND skill_id = ?`
    ).run(enabled ? 1 : 0, specialistId, skillId)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_SPECIALIST_ATTACH_SKILL, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.PROJECT_SPECIALIST_ATTACH_SKILL
    const args = requireObject(rawArgs, ch)
    const specialistId = requireString(args, 'specialistId', ch)
    const skillId = requireString(args, 'skillId', ch)
    specialistRepository.assignSkill(specialistId, skillId)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_SPECIALIST_DETACH_SKILL, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.PROJECT_SPECIALIST_DETACH_SKILL
    const args = requireObject(rawArgs, ch)
    const specialistId = requireString(args, 'specialistId', ch)
    const skillId = requireString(args, 'skillId', ch)
    specialistRepository.removeSkill(specialistId, skillId)
    return { ok: true }
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_SPECIALIST_GET_DRIFT, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.PROJECT_SPECIALIST_GET_DRIFT
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    return stackDriftDetectorService.detectForWorkspace(workspaceId)
  })

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_SPECIALIST_REFRESH_RECOMMENDATIONS,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.PROJECT_SPECIALIST_REFRESH_RECOMMENDATIONS
      const args = requireObject(rawArgs, ch)
      const specialistId = requireString(args, 'specialistId', ch)

      const db = getDatabase()
      const row = db
        .prepare(
          `SELECT s.id, s.workspace_id, s.detected_techs, w.repo_path
             FROM specialists s
             JOIN workspaces w ON w.id = s.workspace_id
            WHERE s.id = ?`
        )
        .get(specialistId) as
        | { id: string; workspace_id: string; detected_techs: string; repo_path: string }
        | undefined

      if (!row) throw new Error(`Specialist not found: ${specialistId}`)

      let detectedTechs: string[] = []
      try {
        detectedTechs = JSON.parse(row.detected_techs || '[]')
      } catch {
        detectedTechs = []
      }

      await specialistBuilderService.forceRefreshRecommendations(
        row.id,
        row.repo_path,
        detectedTechs
      )

      psLog.info(`Skill recommendations force-refreshed for specialist ${specialistId}`)
      return { ok: true }
    }
  )
}
