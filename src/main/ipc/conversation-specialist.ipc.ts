import { readFileSync, existsSync } from 'node:fs'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { conversationSpecialistRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerConversationSpecialistIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.CONV_SPECIALIST_LIST,
    async (event, args: { conversationId: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }

      return conversationSpecialistRepository.findByConversation(args.conversationId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONV_SPECIALIST_UPSERT,
    async (
      event,
      args: {
        conversationId: string
        specialistId: string
        isActive?: boolean
        skillsEnabled?: boolean
        skillOverrides?: string[] | null
      }
    ) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }
      if (typeof args.specialistId !== 'string' || args.specialistId.trim().length === 0) {
        throw new Error('Invalid specialist ID')
      }

      conversationSpecialistRepository.upsert(args.conversationId, args.specialistId, {
        isActive: args.isActive,
        skillsEnabled: args.skillsEnabled,
        skillOverrides: args.skillOverrides
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONV_SPECIALIST_REMOVE,
    async (event, args: { conversationId: string; specialistId: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }
      if (typeof args.specialistId !== 'string' || args.specialistId.trim().length === 0) {
        throw new Error('Invalid specialist ID')
      }

      conversationSpecialistRepository.remove(args.conversationId, args.specialistId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONV_SPECIALIST_RESET,
    async (event, args: { conversationId: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }

      conversationSpecialistRepository.removeAll(args.conversationId)
      conversationSpecialistRepository.initFromWorkspaceDefaults(args.conversationId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CONV_SPECIALIST_ESTIMATE,
    async (event, args: { conversationId: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }

      // Get active specialists with skills enabled for this conversation
      const overrides = conversationSpecialistRepository.findByConversation(args.conversationId)
      const activeWithSkills = overrides.filter((o) => o.isActive && o.skillsEnabled)

      // Calculate real token estimates from actual skill file content
      const { specialistRepository } = await import('../db/repositories')
      const estimates = activeWithSkills.map((override) => {
        const specialist = specialistRepository.findById(override.specialistId)
        const skills = specialist ? specialistRepository.getSkills(override.specialistId) : []
        const activeSkills = override.skillOverrides
          ? skills.filter((s) => override.skillOverrides!.includes(s.id))
          : skills

        // Estimate tokens from specialist prompt (~3.5 chars per token)
        const promptTokens = specialist?.prompt
          ? Math.ceil(specialist.prompt.length / 3.5)
          : 0

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
    }
  )
}
