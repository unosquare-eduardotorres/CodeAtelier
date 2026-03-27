import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'

const rendererLog = log.scope('Renderer')

export function registerLogIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.LOG_FROM_RENDERER,
    (
      event,
      args: {
        level: 'error' | 'warn' | 'info' | 'debug'
        message: string
        data?: unknown[]
      }
    ) => {
      validateSender(event)
      const { level, message, data } = args
      if (data?.length) {
        rendererLog[level](message, ...data)
      } else {
        rendererLog[level](message)
      }
    }
  )
}
