import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { ollamaManager } from '../services/ollama-manager.service'
import { validateSender } from './validate-sender'
import type { PullProgress } from '../../shared/types'

export function registerOllamaIpc(mainWindow: BrowserWindow): void {
  // Forward pull progress events to the renderer
  ollamaManager.on('pullProgress', (progress: PullProgress) => {
    mainWindow.webContents.send(IPC_CHANNELS.OLLAMA_PULL_PROGRESS, progress)
  })
  ollamaManager.on('pullComplete', (model: string) => {
    mainWindow.webContents.send(IPC_CHANNELS.OLLAMA_PULL_COMPLETE, model)
  })
  ollamaManager.on('pullError', (error: string) => {
    mainWindow.webContents.send(IPC_CHANNELS.OLLAMA_PULL_ERROR, error)
  })

  ipcMain.handle(IPC_CHANNELS.OLLAMA_CHECK_STATUS, async (event) => {
    validateSender(event)
    return ollamaManager.checkStatus()
  })

  ipcMain.handle(IPC_CHANNELS.OLLAMA_PULL_MODEL, async (event, args: { model: string }) => {
    validateSender(event)
    await ollamaManager.pullModel(args.model)
  })

  ipcMain.handle(IPC_CHANNELS.OLLAMA_CANCEL_PULL, (event) => {
    validateSender(event)
    ollamaManager.cancelPull()
  })

  ipcMain.handle(IPC_CHANNELS.OLLAMA_REMOVE_MODEL, async (event, args: { model: string }) => {
    validateSender(event)
    await ollamaManager.removeModel(args.model)
  })

  ipcMain.handle(IPC_CHANNELS.OLLAMA_START, async (event) => {
    validateSender(event)
    return ollamaManager.startOllama()
  })
}
