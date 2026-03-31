import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { specialistRepository } from '../db/repositories'
import type { CreateSpecialistInput, UpdateSpecialistInput } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerSpecialistIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SPECIALIST_LIST, async (event) => {
    validateSender(event)
    return specialistRepository.findAll()
  })

  ipcMain.handle(IPC_CHANNELS.SPECIALIST_GET, async (event, args: { id: string }) => {
    validateSender(event)

    if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
      throw new Error('Invalid specialist ID')
    }

    const specialist = specialistRepository.findById(args.id)
    if (!specialist) {
      throw new Error(`Specialist not found: ${args.id}`)
    }

    // Attach skills to the specialist
    specialist.skills = specialistRepository.getSkills(args.id)
    return specialist
  })

  ipcMain.handle(IPC_CHANNELS.SPECIALIST_CREATE, async (event, args: CreateSpecialistInput) => {
    validateSender(event)

    if (!args || typeof args !== 'object') {
      throw new Error('Invalid arguments')
    }
    if (typeof args.agentId !== 'string' || args.agentId.trim().length === 0) {
      throw new Error('Invalid agent ID: must be a non-empty string')
    }
    if (typeof args.displayName !== 'string' || args.displayName.trim().length === 0) {
      throw new Error('Invalid display name: must be a non-empty string')
    }

    return specialistRepository.create(args)
  })

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_UPDATE,
    async (event, args: { id: string } & UpdateSpecialistInput) => {
      validateSender(event)

      if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
        throw new Error('Invalid specialist ID')
      }

      const { id, ...data } = args
      return specialistRepository.update(id, data)
    }
  )

  ipcMain.handle(IPC_CHANNELS.SPECIALIST_DELETE, async (event, args: { id: string }) => {
    validateSender(event)

    if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
      throw new Error('Invalid specialist ID')
    }

    // Block deletion of core agents (generalist, coordinator, user)
    const specialist = specialistRepository.findById(args.id)
    if (specialist?.isCore) {
      throw new Error('Cannot delete core agents')
    }

    const canDeleteResult = specialistRepository.canDelete(args.id)
    if (!canDeleteResult.allowed) {
      throw new Error(
        `Cannot delete specialist: they are the only specialist assigned to the following active skills: ${canDeleteResult.blockingSkills?.join(', ')}. Please reassign or deactivate those skills first.`
      )
    }

    specialistRepository.delete(args.id)
  })

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_REORDER,
    async (event, args: { orderedIds: string[] }) => {
      validateSender(event)
      if (!Array.isArray(args?.orderedIds) || args.orderedIds.length === 0) {
        throw new Error('Invalid ordered IDs')
      }
      specialistRepository.reorderPriorities(args.orderedIds)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_ASSIGN_SKILL,
    async (event, args: { specialistId: string; skillId: string }) => {
      validateSender(event)

      if (!args || typeof args.specialistId !== 'string' || typeof args.skillId !== 'string') {
        throw new Error('Invalid arguments: specialistId and skillId are required')
      }

      specialistRepository.assignSkill(args.specialistId, args.skillId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_REMOVE_SKILL,
    async (event, args: { specialistId: string; skillId: string }) => {
      validateSender(event)

      if (!args || typeof args.specialistId !== 'string' || typeof args.skillId !== 'string') {
        throw new Error('Invalid arguments: specialistId and skillId are required')
      }

      specialistRepository.removeSkill(args.specialistId, args.skillId)
    }
  )
}
