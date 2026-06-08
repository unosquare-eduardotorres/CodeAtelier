import { readFileSync, existsSync } from 'node:fs'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { conversationSpecialistRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalBoolean } from './validate-args'

export function registerConversationSpecialistIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CONV_SPECIALIST_LIST, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CONV_SPECIALIST_LIST
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)

    return conversationSpecialistRepository.findByConversation(conversationId)
  })

  ipcMain.handle(IPC_CHANNELS.CONV_SPECIALIST_UPSERT, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CONV_SPECIALIST_UPSERT
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)
    const specialistId = requireString(args, 'specialistId', ch)
    const isActive = optionalBoolean(args, 'isActive', ch)

    conversationSpecialistRepository.upsert(conversationId, specialistId, {
      isActive
    })
  })

  ipcMain.handle(IPC_CHANNELS.CONV_SPECIALIST_REMOVE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CONV_SPECIALIST_REMOVE
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)
    const specialistId = requireString(args, 'specialistId', ch)

    conversationSpecialistRepository.remove(conversationId, specialistId)
  })

  ipcMain.handle(IPC_CHANNELS.CONV_SPECIALIST_RESET, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CONV_SPECIALIST_RESET
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)

    conversationSpecialistRepository.removeAll(conversationId)
    conversationSpecialistRepository.initFromWorkspaceDefaults(conversationId)
  })

  ipcMain.handle(IPC_CHANNELS.CONV_SPECIALIST_ESTIMATE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CONV_SPECIALIST_ESTIMATE
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)

    // Get active specialists for this conversation
    const overrides = conversationSpecialistRepository.findByConversation(conversationId)
    const activeWithSkills = overrides.filter((o) => o.isActive)

    // Calculate real token estimates from actual skill file content
    const { specialistRepository } = await import('../db/repositories')
    const estimates = activeWithSkills.map((override) => {
      const specialist = specialistRepository.findById(override.specialistId)
      const skills = specialist ? specialistRepository.getSkills(override.specialistId) : []
      const activeSkills = skills

      // Estimate tokens from specialist prompt (~3.5 chars per token)
      const promptTokens = specialist?.prompt ? Math.ceil(specialist.prompt.length / 3.5) : 0

      let skillTokens = 0
      const skillBreakdown: { name: string; tokens: number }[] = []
      for (const skill of activeSkills) {
        try {
          if (skill.filePath && existsSync(skill.filePath)) {
            const content = readFileSync(skill.filePath, 'utf-8')
            const tokens = Math.ceil(content.length / 3.5)
            skillTokens += tokens
            skillBreakdown.push({ name: skill.name, tokens })
          } else {
            skillTokens += 500
            skillBreakdown.push({ name: skill.name, tokens: 500 })
          }
        } catch {
          // File not found — use fallback estimate
          skillTokens += 500
          skillBreakdown.push({ name: skill.name, tokens: 500 })
        }
      }

      return {
        specialistId: override.specialistId,
        displayName: specialist?.displayName ?? 'Unknown',
        skillCount: activeSkills.length,
        promptTokens,
        skillTokens,
        skillBreakdown,
        estimatedTokens: promptTokens + skillTokens
      }
    })

    return estimates
  })
}
