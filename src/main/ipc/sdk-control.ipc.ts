import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { generalistService } from '../services'
import { validateSender } from './validate-sender'

/**
 * SDK Control IPC handlers — bridges renderer requests to the active
 * Query reference held by the generalist's SDKExecutor.
 *
 * These methods require an active SDK query() session. They throw if
 * called when no query is in progress.
 */
export function registerSdkControlIpc(): void {
  // getContextUsage — native context window breakdown
  ipcMain.handle(IPC_CHANNELS.SDK_GET_CONTEXT_USAGE, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.getContextUsage()
  })

  // stopTask — stop individual SubAgent
  ipcMain.handle(IPC_CHANNELS.SDK_STOP_TASK, async (event, args: { taskId: string }) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.stopTask(args.taskId)
  })

  // interrupt — clean interruption preserving session
  ipcMain.handle(IPC_CHANNELS.SDK_INTERRUPT, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.interrupt()
  })

  // accountInfo — subscription details
  ipcMain.handle(IPC_CHANNELS.SDK_ACCOUNT_INFO, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.accountInfo()
  })

  // supportedModels — available models list
  ipcMain.handle(IPC_CHANNELS.SDK_SUPPORTED_MODELS, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.supportedModels()
  })

  // mcpServerStatus — MCP server health
  ipcMain.handle(IPC_CHANNELS.SDK_MCP_SERVER_STATUS, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.mcpServerStatus()
  })

  // setModel — dynamic model switching
  ipcMain.handle(IPC_CHANNELS.SDK_SET_MODEL, async (event, args: { model?: string }) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.setModel(args.model)
  })

  // setPermissionMode — switch plan/build without restart
  ipcMain.handle(IPC_CHANNELS.SDK_SET_PERMISSION_MODE, async (event, args: { mode: string }) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.setPermissionMode(
      args.mode as 'default' | 'plan' | 'bypassPermissions' | 'acceptEdits'
    )
  })

  // applyFlagSettings — push settings mid-session
  ipcMain.handle(
    IPC_CHANNELS.SDK_APPLY_FLAG_SETTINGS,
    async (event, args: { settings: Record<string, unknown> }) => {
      validateSender(event)
      const query = generalistService.getActiveQuery()
      if (!query) throw new Error('No active query')
      return query.applyFlagSettings(args.settings as Parameters<typeof query.applyFlagSettings>[0])
    }
  )

  // setMcpServers — hot-reload MCP servers
  ipcMain.handle(
    IPC_CHANNELS.SDK_SET_MCP_SERVERS,
    async (event, args: { servers: Record<string, unknown> }) => {
      validateSender(event)
      const query = generalistService.getActiveQuery()
      if (!query) throw new Error('No active query')
      return query.setMcpServers(args.servers as Parameters<typeof query.setMcpServers>[0])
    }
  )

  // rewindFiles — native file rollback
  ipcMain.handle(
    IPC_CHANNELS.SDK_REWIND_FILES,
    async (event, args: { userMessageId: string; dryRun?: boolean }) => {
      validateSender(event)
      const query = generalistService.getActiveQuery()
      if (!query) throw new Error('No active query')
      return query.rewindFiles(args.userMessageId, { dryRun: args.dryRun })
    }
  )

  // reconnectMcpServer — recover from MCP crashes
  ipcMain.handle(
    IPC_CHANNELS.SDK_RECONNECT_MCP,
    async (event, args: { serverName: string }) => {
      validateSender(event)
      const query = generalistService.getActiveQuery()
      if (!query) throw new Error('No active query')
      return query.reconnectMcpServer(args.serverName)
    }
  )

  // supportedAgents — list runtime SubAgents
  ipcMain.handle(IPC_CHANNELS.SDK_SUPPORTED_AGENTS, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.supportedAgents()
  })
}
