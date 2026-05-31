import { ipcMain, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { skillRepository } from '../db/repositories'
import { skillService } from '../services'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'

export function registerSkillIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SKILL_LIST, async (event) => {
    validateSender(event)
    return skillRepository.findAll()
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_GET, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SKILL_GET
    const args = requireObject(rawArgs, ch)
    const id = requireString(args, 'id', ch)

    const skill = skillRepository.findById(id)
    if (!skill) {
      throw new Error(`Skill not found: ${id}`)
    }
    return skill
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_IMPORT, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SKILL_IMPORT
    const args = requireObject(rawArgs, ch)
    const filePath = requireString(args, 'filePath', ch)

    return skillService.importSkill(filePath)
  })

  ipcMain.handle(
    IPC_CHANNELS.SKILL_UPDATE,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const ch = IPC_CHANNELS.SKILL_UPDATE
      const args = requireObject(rawArgs, ch)
      const id = requireString(args, 'id', ch)

      const { id: _, ...data } = args as unknown as { id: string; name?: string; description?: string }
      return skillRepository.update(id, data)
    }
  )

  ipcMain.handle(IPC_CHANNELS.SKILL_DELETE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SKILL_DELETE
    const args = requireObject(rawArgs, ch)
    const id = requireString(args, 'id', ch)

    // Delete only removes DB record, not the .MD file
    skillRepository.delete(id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_ACTIVATE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SKILL_ACTIVATE
    const args = requireObject(rawArgs, ch)
    const id = requireString(args, 'id', ch)

    return skillService.activateSkill(id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_DEACTIVATE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SKILL_DEACTIVATE
    const args = requireObject(rawArgs, ch)
    const id = requireString(args, 'id', ch)

    return skillService.deactivateSkill(id)
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
