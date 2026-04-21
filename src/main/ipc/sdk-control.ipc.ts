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
 *
 * STATUS: Most of these handlers are wired but NOT called from the renderer.
 * Only `sdkStopTask` is actively used (AgentStatusCard.tsx).
 * The rest are available for future UI features or can be removed in a cleanup pass.
 *
 * NOT YET WIRED (exist on Query but have no IPC handler):
 * - toggleMcpServer(name, enabled) — enable/disable MCP servers
 * - seedReadState(path, mtime) — prevent "file not read" errors after context snip
 * - reloadPlugins() — hot-reload plugins, commands, agents
 * - initializationResult() — get full init config (replaces accountInfo + supportedModels)
 * - supportedCommands() — list available slash commands
 * - setMaxThinkingTokens() — dynamic thinking budget (deprecated, use thinking option)
 * - close() — forceful query termination (we use AbortController instead)
 */
export function registerSdkControlIpc(): void {
  // Elicitation response — renderer sends user's response to MCP elicitation request
  ipcMain.handle(
    IPC_CHANNELS.ELICITATION_RESPONSE,
    async (event, args: { action: string; content?: Record<string, unknown> }) => {
      validateSender(event)
      generalistService.emit('elicitationResponse', {
        action: args.action as 'accept' | 'decline' | 'cancel',
        content: args.content
      })
    }
  )

  // TODO: Not called from renderer — generalist.service.ts uses SDK directly for context usage
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

  // TODO: Not called from renderer — we use cancelCurrentQuery() with AbortController instead
  // interrupt — clean interruption preserving session
  ipcMain.handle(IPC_CHANNELS.SDK_INTERRUPT, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.interrupt()
  })

  // TODO: Not called from renderer — could power a subscription status UI
  // accountInfo — subscription details
  ipcMain.handle(IPC_CHANNELS.SDK_ACCOUNT_INFO, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.accountInfo()
  })

  // TODO: Not called from renderer — could power a model picker UI
  // supportedModels — available models list
  ipcMain.handle(IPC_CHANNELS.SDK_SUPPORTED_MODELS, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.supportedModels()
  })

  // TODO: Not called from renderer — could power MCP health dashboard
  // mcpServerStatus — MCP server health
  ipcMain.handle(IPC_CHANNELS.SDK_MCP_SERVER_STATUS, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.mcpServerStatus()
  })

  // TODO: Not called from renderer — model is set at execute() time via modelConfigService
  // setModel — dynamic model switching
  ipcMain.handle(IPC_CHANNELS.SDK_SET_MODEL, async (event, args: { model?: string }) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.setModel(args.model)
  })

  // TODO: Not called from renderer — switchMode() now calls setPermissionMode() directly
  // setPermissionMode — switch plan/build without restart
  ipcMain.handle(IPC_CHANNELS.SDK_SET_PERMISSION_MODE, async (event, args: { mode: string }) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.setPermissionMode(
      args.mode as 'default' | 'plan' | 'bypassPermissions' | 'acceptEdits' | 'auto' | 'dontAsk'
    )
  })

  // TODO: Not called from renderer — no settings UI uses mid-session flag changes
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

  // TODO: Not called from renderer — MCP servers are configured at query creation time
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

  // TODO: Not called from renderer — could power an undo/rollback UI
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

  // TODO: Not called from renderer — could power MCP health recovery UI
  // reconnectMcpServer — recover from MCP crashes
  ipcMain.handle(IPC_CHANNELS.SDK_RECONNECT_MCP, async (event, args: { serverName: string }) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.reconnectMcpServer(args.serverName)
  })

  // toggleMcpServer — enable/disable MCP servers mid-session
  ipcMain.handle(
    IPC_CHANNELS.SDK_TOGGLE_MCP_SERVER,
    async (event, args: { serverName: string; enabled: boolean }) => {
      validateSender(event)
      const query = generalistService.getActiveQuery()
      if (!query) throw new Error('No active query')
      return query.toggleMcpServer(args.serverName, args.enabled)
    }
  )

  // TODO: Not called from renderer — could power dynamic agent discovery UI
  // supportedAgents — list runtime SubAgents
  ipcMain.handle(IPC_CHANNELS.SDK_SUPPORTED_AGENTS, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) throw new Error('No active query')
    return query.supportedAgents()
  })

  // close — forceful query termination (backstop when AbortController doesn't work)
  ipcMain.handle(IPC_CHANNELS.SDK_CLOSE_QUERY, async (event) => {
    validateSender(event)
    const query = generalistService.getActiveQuery()
    if (!query) return
    query.close()
  })

  // seedReadState — prevent "file not read" errors after context compaction
  ipcMain.handle(
    IPC_CHANNELS.SDK_SEED_READ_STATE,
    async (event, args: { path: string; mtime: number }) => {
      validateSender(event)
      const query = generalistService.getActiveQuery()
      if (!query) throw new Error('No active query')
      return query.seedReadState(args.path, args.mtime)
    }
  )

  // Elicitation response (enriched) — renderer sends user's response via elicitation.service
  ipcMain.handle(
    IPC_CHANNELS.SDK_ELICITATION_RESPONSE,
    async (
      event,
      args: { requestId: string; action: string; content?: Record<string, unknown> }
    ) => {
      validateSender(event)
      const { elicitationService } = await import('../services/elicitation.service')
      elicitationService.resolveElicitation(args.requestId, {
        action: args.action as 'accept' | 'decline' | 'cancel',
        content: args.content
      })
    }
  )

  // listSubagents — list all SubAgents spawned during a session (SDK 0.2.96+)
  ipcMain.handle(IPC_CHANNELS.SDK_LIST_SUBAGENTS, async (event, args: { sessionId: string }) => {
    validateSender(event)
    const { listSubagents } = await import('@anthropic-ai/claude-agent-sdk')
    return listSubagents(args.sessionId)
  })

  // getSubagentMessages — get the full transcript of a SubAgent (SDK 0.2.96+)
  ipcMain.handle(
    IPC_CHANNELS.SDK_GET_SUBAGENT_MESSAGES,
    async (event, args: { sessionId: string; subagentId: string }) => {
      validateSender(event)
      const { getSubagentMessages } = await import('@anthropic-ai/claude-agent-sdk')
      return getSubagentMessages(args.sessionId, args.subagentId)
    }
  )

  // forkSession — branch a conversation at a specific message point
  // Used for "Branch Conversation" feature — creates a new session forked from an existing one
  ipcMain.handle(
    IPC_CHANNELS.SDK_FORK_SESSION,
    async (event, args: { sessionId: string; upToMessageId?: string }) => {
      validateSender(event)
      const { forkSession } = await import('@anthropic-ai/claude-agent-sdk')
      return forkSession(
        args.sessionId,
        args.upToMessageId ? { upToMessageId: args.upToMessageId } : undefined
      )
    }
  )
}
