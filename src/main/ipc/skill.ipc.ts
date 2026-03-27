import { ipcMain, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { skillRepository } from '../db/repositories'
import { skillService } from '../services'
import { validateSender } from './validate-sender'

export function registerSkillIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SKILL_LIST, async (event) => {
    validateSender(event)
    return skillRepository.findAll()
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_GET, async (event, args: { id: string }) => {
    validateSender(event)

    if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
      throw new Error('Invalid skill ID')
    }

    const skill = skillRepository.findById(args.id)
    if (!skill) {
      throw new Error(`Skill not found: ${args.id}`)
    }
    return skill
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_IMPORT, async (event, args: { filePath: string }) => {
    validateSender(event)

    if (!args || typeof args.filePath !== 'string' || args.filePath.trim().length === 0) {
      throw new Error('Invalid file path')
    }

    return skillService.importSkill(args.filePath)
  })

  ipcMain.handle(
    IPC_CHANNELS.SKILL_UPDATE,
    async (event, args: { id: string; name?: string; description?: string }) => {
      validateSender(event)

      if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
        throw new Error('Invalid skill ID')
      }

      const { id, ...data } = args
      return skillRepository.update(id, data)
    }
  )

  ipcMain.handle(IPC_CHANNELS.SKILL_DELETE, async (event, args: { id: string }) => {
    validateSender(event)

    if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
      throw new Error('Invalid skill ID')
    }

    // Delete only removes DB record, not the .MD file
    skillRepository.delete(args.id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_ACTIVATE, async (event, args: { id: string }) => {
    validateSender(event)

    if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
      throw new Error('Invalid skill ID')
    }

    return skillService.activateSkill(args.id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_DEACTIVATE, async (event, args: { id: string }) => {
    validateSender(event)

    if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
      throw new Error('Invalid skill ID')
    }

    return skillService.deactivateSkill(args.id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_SELECT_FILE, async (event) => {
    validateSender(event)

    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: 'Select Skill File (.md)',
      filters: [{ name: 'Markdown Files', extensions: ['md'] }]
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })
}
