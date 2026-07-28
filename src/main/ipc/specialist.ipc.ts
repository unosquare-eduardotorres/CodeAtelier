import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { specialistRepository } from '../db/repositories'
import type { CreateSpecialistInput, UpdateSpecialistInput } from '../db/repositories'

import { validateSender } from './validate-sender'
import { requireObject, requireString, requireStringArray } from './validate-args'

export function registerSpecialistIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SPECIALIST_LIST, async (event) => {
    validateSender(event)
    return specialistRepository.findAllWithSkills()
  })

  ipcMain.handle(IPC_CHANNELS.SPECIALIST_GET, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SPECIALIST_GET
    const args = requireObject(rawArgs, ch)
    const id = requireString(args, 'id', ch)

    const specialist = specialistRepository.findById(id)
    if (!specialist) {
      throw new Error(`Specialist not found: ${id}`)
    }

    // Attach all skills (including inactive) for the Settings UI
    specialist.skills = specialistRepository.getAllSkills(id)
    return specialist
  })

  ipcMain.handle(IPC_CHANNELS.SPECIALIST_CREATE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SPECIALIST_CREATE
    const args = requireObject(rawArgs, ch) as unknown as CreateSpecialistInput
    requireString(args as unknown as Record<string, unknown>, 'agentId', ch)
    requireString(args as unknown as Record<string, unknown>, 'displayName', ch)

    return specialistRepository.create(args)
  })

  ipcMain.handle(IPC_CHANNELS.SPECIALIST_UPDATE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SPECIALIST_UPDATE
    const args = requireObject(rawArgs, ch)
    const id = requireString(args, 'id', ch)

    const { id: _, ...data } = args as unknown as { id: string } & UpdateSpecialistInput
    return specialistRepository.update(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.SPECIALIST_DELETE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SPECIALIST_DELETE
    const args = requireObject(rawArgs, ch)
    const id = requireString(args, 'id', ch)

    // Block deletion of core agents (specialist, user)
    const specialist = specialistRepository.findById(id)
    if (specialist?.isCore) {
      throw new Error('Cannot delete core agents')
    }

    const canDeleteResult = specialistRepository.canDelete(id)
    if (!canDeleteResult.allowed) {
      throw new Error(
        `Cannot delete specialist: they are the only specialist assigned to the following active skills: ${canDeleteResult.blockingSkills?.join(', ')}. Please reassign or deactivate those skills first.`
      )
    }

    specialistRepository.delete(id)
  })

  ipcMain.handle(IPC_CHANNELS.SPECIALIST_REORDER, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SPECIALIST_REORDER
    const args = requireObject(rawArgs, ch)
    const orderedIds = requireStringArray(args, 'orderedIds', ch)
    specialistRepository.reorderPriorities(orderedIds)
  })

  ipcMain.handle(IPC_CHANNELS.SPECIALIST_ASSIGN_SKILL, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SPECIALIST_ASSIGN_SKILL
    const args = requireObject(rawArgs, ch)
    const specialistId = requireString(args, 'specialistId', ch)
    const skillId = requireString(args, 'skillId', ch)

    specialistRepository.assignSkill(specialistId, skillId)
  })

  ipcMain.handle(IPC_CHANNELS.SPECIALIST_REMOVE_SKILL, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.SPECIALIST_REMOVE_SKILL
    const args = requireObject(rawArgs, ch)
    const specialistId = requireString(args, 'specialistId', ch)
    const skillId = requireString(args, 'skillId', ch)

    specialistRepository.removeSkill(specialistId, skillId)
  })
}
