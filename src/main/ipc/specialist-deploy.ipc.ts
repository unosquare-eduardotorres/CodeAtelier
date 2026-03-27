import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { specialistDeployService } from '../services/specialist-deploy.service'
import { validateSender } from './validate-sender'

export function registerSpecialistDeployIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_DEPLOY,
    (event, args: { workspacePath: string; specialistId: string }) => {
      validateSender(event)
      specialistDeployService.deploySpecialist(args.workspacePath, args.specialistId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_UNDEPLOY,
    (event, args: { workspacePath: string; specialistId: string }) => {
      validateSender(event)
      specialistDeployService.undeploySpecialist(args.workspacePath, args.specialistId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_UPDATE_CONFIG,
    (
      event,
      args: {
        id: string
        displayName?: string
        icon?: string
        color?: string
        alias?: string | null
        avatarUrl?: string | null
        priority?: number
      }
    ) => {
      validateSender(event)
      const { id, ...data } = args
      return specialistDeployService.updateConfig(id, data)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SPECIALIST_GET_MARKETPLACE,
    (event, args: { workspacePath: string }) => {
      validateSender(event)
      return specialistDeployService.getMarketplaceData(args.workspacePath)
    }
  )
}
