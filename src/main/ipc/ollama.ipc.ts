import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { ollamaManager } from '../services/ollama-manager.service'
import { omlxManager } from '../services/omlx-manager.service'
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

  // ── Ollama handlers ──

  ipcMain.handle(IPC_CHANNELS.OLLAMA_CHECK_STATUS, async (event, args?: { baseUrl?: string }) => {
    validateSender(event)
    return ollamaManager.checkStatus(args?.baseUrl)
  })

  ipcMain.handle(
    IPC_CHANNELS.OLLAMA_PULL_MODEL,
    async (event, args: { model: string; baseUrl?: string }) => {
      validateSender(event)
      await ollamaManager.pullModel(args.model, args.baseUrl)
    }
  )

  ipcMain.handle(IPC_CHANNELS.OLLAMA_CANCEL_PULL, (event) => {
    validateSender(event)
    ollamaManager.cancelPull()
  })

  ipcMain.handle(
    IPC_CHANNELS.OLLAMA_REMOVE_MODEL,
    async (event, args: { model: string; baseUrl?: string }) => {
      validateSender(event)
      await ollamaManager.removeModel(args.model, args.baseUrl)
    }
  )

  ipcMain.handle(IPC_CHANNELS.OLLAMA_START, async (event) => {
    validateSender(event)
    return ollamaManager.startOllama()
  })

  // ── oMLX handlers ──

  ipcMain.handle(
    IPC_CHANNELS.OMLX_CHECK_STATUS,
    async (event, args?: { baseUrl?: string; apiKey?: string }) => {
      validateSender(event)
      return omlxManager.checkStatus(args?.baseUrl, args?.apiKey)
    }
  )

  ipcMain.handle(IPC_CHANNELS.OMLX_START, async (event) => {
    validateSender(event)
    return omlxManager.startOmlx()
  })

  ipcMain.handle(IPC_CHANNELS.OMLX_ADMIN_URL, (event, args?: { baseUrl?: string }) => {
    validateSender(event)
    return omlxManager.getAdminUrl(args?.baseUrl)
  })

  ipcMain.handle(
    IPC_CHANNELS.OMLX_LOAD_MODEL,
    async (event, args: { modelId: string; baseUrl?: string; apiKey?: string }) => {
      validateSender(event)
      await omlxManager.loadModel(args.modelId, args.baseUrl, args.apiKey)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.OMLX_UNLOAD_MODEL,
    async (event, args: { modelId: string; baseUrl?: string; apiKey?: string }) => {
      validateSender(event)
      await omlxManager.unloadModel(args.modelId, args.baseUrl, args.apiKey)
    }
  )
}
