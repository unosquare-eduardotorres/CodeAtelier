import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import { chatAgentService } from '../services'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'

/**
 * SDK Control IPC handlers — bridges renderer requests to the active
 * Query reference held by the generalist's SDKExecutor, or to top-level SDK
 * functions that operate on persisted sessions.
 *
 * ─── Active handlers (wired to renderer) ───────────────────────────────────
 *
 *   ELICITATION_RESPONSE       — generalist MCP elicitation flow
 *   SDK_ELICITATION_RESPONSE   — elicitation.service enriched flow (SDK 0.2.96+)
 *   SDK_STOP_TASK              — stop an individual SubAgent (AgentStatusCard)
 *   SDK_SUPPORTED_MODELS       — list available models (ModelConfigTab)
 *   SDK_LIST_SUBAGENTS         — enumerate SubAgents in a session (SDK 0.2.96+)
 *   SDK_GET_SUBAGENT_MESSAGES  — fetch a SubAgent transcript (SDK 0.2.96+)
 *   SDK_FORK_SESSION           — branch a conversation at a message boundary
 *
 * ─── Reserved handlers (deliberately not wired yet) ────────────────────────
 *
 * The SDK Query interface exposes additional control methods we have
 * intentionally NOT surfaced. If you find yourself about to add one of these
 * handlers, check first whether the feature is better implemented elsewhere:
 *
 *   - getContextUsage()        → use chatAgentService.getContextUsage() directly
 *   - interrupt() / close()    → use conversationLifecycle.abort() (AbortController)
 *   - accountInfo()            → no subscription UI yet — defer until needed
 *   - setModel()               → model is pinned at execute() time via modelConfigService
 *   - setPermissionMode()      → chat-lifecycle.ipc.ts switchMode already covers this
 *   - applyFlagSettings()      → no mid-session settings UI; settings rebuild the query
 *   - setMcpServers()          → MCP servers are configured at query creation time
 *   - toggleMcpServer()        → same — restart the query to change MCP set
 *   - mcpServerStatus()        → no health dashboard yet
 *   - reconnectMcpServer()     → same — no MCP health UI
 *   - rewindFiles()            → no undo UI yet
 *   - seedReadState()          → handled inside the SDKExecutor on context snip
 *   - supportedAgents()        → SubAgent set is static per session config
 *
 * Adding a handler here is cheap; adding a feature that depends on an unstable
 * Query reference is expensive. Prefer routing through a service that owns the
 * lifecycle (chatAgentService, conversationLifecycle, modelConfigService).
 */
export function registerSdkControlIpc(): void {
  // ── Elicitation ────────────────────────────────────────────────────────

  // Generalist MCP elicitation response — forwarded to the generalist's
  // active session via an event emitter.
  ipcMain.handle(IPC_CHANNELS.ELICITATION_RESPONSE, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.ELICITATION_RESPONSE
    const obj = requireObject(args, channel)
    const action = requireString(obj, 'action', channel)
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
      throw new Error(`${channel}: field 'action' must be 'accept' | 'decline' | 'cancel'`)
    }
    const content =
      obj.content === undefined
        ? undefined
        : (() => {
            if (obj.content === null || typeof obj.content !== 'object' || Array.isArray(obj.content)) {
              throw new Error(`${channel}: field 'content' must be an object when provided`)
            }
            return obj.content as Record<string, unknown>
          })()
    chatAgentService.emit('elicitationResponse', { action, content })
  })

  // Enriched elicitation response (SDK 0.2.96+) — routed through
  // ElicitationService so the pending Promise resolves for the specific
  // requestId that originated the prompt.
  ipcMain.handle(IPC_CHANNELS.SDK_ELICITATION_RESPONSE, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SDK_ELICITATION_RESPONSE
    const obj = requireObject(args, channel)
    const requestId = requireString(obj, 'requestId', channel)
    const action = requireString(obj, 'action', channel)
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
      throw new Error(`${channel}: field 'action' must be 'accept' | 'decline' | 'cancel'`)
    }
    const content =
      obj.content === undefined
        ? undefined
        : (() => {
            if (obj.content === null || typeof obj.content !== 'object' || Array.isArray(obj.content)) {
              throw new Error(`${channel}: field 'content' must be an object when provided`)
            }
            return obj.content as Record<string, unknown>
          })()
    const { elicitationService } = await import('../services/elicitation.service')
    elicitationService.resolveElicitation(requestId, { action, content })
  })

  // ── Active Query controls (require an in-flight query) ───────────────────

  // Stop an individual SubAgent mid-execution (AgentStatusCard "stop" button).
  ipcMain.handle(IPC_CHANNELS.SDK_STOP_TASK, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SDK_STOP_TASK
    const obj = requireObject(args, channel)
    const taskId = requireString(obj, 'taskId', channel)
    const query = chatAgentService.getActiveQuery()
    if (!query) throw new Error(`${channel}: no active query`)
    return query.stopTask(taskId)
  })

  // Supported-models list for ModelConfigTab — reads from the live Query
  // rather than a static config so account-dependent models appear correctly.
  ipcMain.handle(IPC_CHANNELS.SDK_SUPPORTED_MODELS, async (event) => {
    validateSender(event)
    const query = chatAgentService.getActiveQuery()
    if (!query) throw new Error(`${IPC_CHANNELS.SDK_SUPPORTED_MODELS}: no active query`)
    return query.supportedModels()
  })

  // ── SubAgent inspection (SDK 0.2.96+) — operate on persisted sessions ────

  ipcMain.handle(IPC_CHANNELS.SDK_LIST_SUBAGENTS, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SDK_LIST_SUBAGENTS
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    const { listSubagents } = await import('@anthropic-ai/claude-agent-sdk')
    return listSubagents(sessionId)
  })

  ipcMain.handle(IPC_CHANNELS.SDK_GET_SUBAGENT_MESSAGES, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SDK_GET_SUBAGENT_MESSAGES
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    const subagentId = requireString(obj, 'subagentId', channel)
    const { getSubagentMessages } = await import('@anthropic-ai/claude-agent-sdk')
    return getSubagentMessages(sessionId, subagentId)
  })

  // ── SDK Diagnostics (@alpha — 0.2.138+) ──────────────────────────────────

  // resolveSettings() — inspect effective merged SDK settings without spawning
  // a CLI process. Useful for diagnostics and settings validation.
  ipcMain.handle(IPC_CHANNELS.SDK_RESOLVE_SETTINGS, async (event) => {
    validateSender(event)
    try {
      const { resolveSettings } = await import('@anthropic-ai/claude-agent-sdk')
      const settings = await resolveSettings()
      return { success: true, settings }
    } catch (error) {
      log.error('resolveSettings failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // ── Session branching ────────────────────────────────────────────────────

  // Fork a conversation at a message boundary — "Branch Conversation" feature.
  ipcMain.handle(IPC_CHANNELS.SDK_FORK_SESSION, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SDK_FORK_SESSION
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    const upToMessageId = optionalString(obj, 'upToMessageId', channel)
    const { forkSession } = await import('@anthropic-ai/claude-agent-sdk')
    return forkSession(sessionId, upToMessageId ? { upToMessageId } : undefined)
  })
}
