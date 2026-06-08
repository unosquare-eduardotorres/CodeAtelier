import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import { chatAgentService } from '../services'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'

/**
 * SDK Control IPC handlers — bridges renderer requests to session management.
 *
 * Previously used @anthropic-ai/claude-agent-sdk functions. Now uses CLI
 * equivalents where available, or returns graceful errors for unimplemented ops.
 *
 * ─── Active handlers (wired to renderer) ───────────────────────────────────
 *
 *   ELICITATION_RESPONSE       — generalist MCP elicitation flow
 *   SDK_ELICITATION_RESPONSE   — elicitation.service enriched flow
 *   CHAT_ASK_USER_RESPOND      — ask_user response routing
 *   SDK_STOP_TASK              — stop a SubAgent (not available without SDK)
 *   SDK_SUPPORTED_MODELS       — list available models (returns static list)
 *   SDK_LIST_SUBAGENTS         — enumerate SubAgents (not available without SDK)
 *   SDK_GET_SUBAGENT_MESSAGES  — fetch a SubAgent transcript (not available)
 *   SDK_FORK_SESSION           — branch a conversation
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
            if (
              obj.content === null ||
              typeof obj.content !== 'object' ||
              Array.isArray(obj.content)
            ) {
              throw new Error(`${channel}: field 'content' must be an object when provided`)
            }
            return obj.content as Record<string, unknown>
          })()
    chatAgentService.emit('elicitationResponse', { action, content })
  })

  // Enriched elicitation response — routed through ElicitationService
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
            if (
              obj.content === null ||
              typeof obj.content !== 'object' ||
              Array.isArray(obj.content)
            ) {
              throw new Error(`${channel}: field 'content' must be an object when provided`)
            }
            return obj.content as Record<string, unknown>
          })()
    const { elicitationService } = await import('../services/elicitation.service')
    elicitationService.resolveElicitation(requestId, { action, content })
  })

  // ── Active Query controls ───────────────────────────────────────────────

  // Stop task — not available without SDK Query reference
  ipcMain.handle(IPC_CHANNELS.SDK_STOP_TASK, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SDK_STOP_TASK
    const obj = requireObject(args, channel)
    requireString(obj, 'taskId', channel)
    // SDK Query object no longer available — CLI abort handles full session stop
    log.warn(`[${channel}] Individual task stop not available without SDK Query`)
    return { success: false, error: 'Task stop requires SDK (removed)' }
  })

  // Supported-models list — return via CLI or static config
  ipcMain.handle(IPC_CHANNELS.SDK_SUPPORTED_MODELS, async (event) => {
    validateSender(event)
    // Return static model list — the CLI doesn't expose supportedModels()
    return ['claude-sonnet-4-6', 'claude-sonnet-4-20250514', 'claude-opus-4-0', 'claude-haiku-3-5']
  })

  // ── SubAgent inspection — not available without SDK ────────────────────

  ipcMain.handle(IPC_CHANNELS.SDK_LIST_SUBAGENTS, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SDK_LIST_SUBAGENTS
    const obj = requireObject(args, channel)
    requireString(obj, 'sessionId', channel)
    log.info(`[${channel}] SubAgent listing not available — SDK removed`)
    return []
  })

  ipcMain.handle(IPC_CHANNELS.SDK_GET_SUBAGENT_MESSAGES, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SDK_GET_SUBAGENT_MESSAGES
    const obj = requireObject(args, channel)
    requireString(obj, 'sessionId', channel)
    requireString(obj, 'subagentId', channel)
    log.info(`[${channel}] SubAgent messages not available — SDK removed`)
    return []
  })

  // ── SDK Diagnostics ──────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SDK_RESOLVE_SETTINGS, async (event) => {
    validateSender(event)
    return { success: false, error: 'resolveSettings not available — SDK removed' }
  })

  // ── ask_user response ──────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.CHAT_ASK_USER_RESPOND, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.CHAT_ASK_USER_RESPOND
    const obj = requireObject(args, channel)
    const requestId = requireString(obj, 'requestId', channel)
    const response = requireString(obj, 'response', channel)
    chatAgentService.respondToAskUser(requestId, response)
  })

  // ── Session branching ────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.SDK_FORK_SESSION, async (event, args: unknown) => {
    validateSender(event)
    const channel = IPC_CHANNELS.SDK_FORK_SESSION
    const obj = requireObject(args, channel)
    const sessionId = requireString(obj, 'sessionId', channel)
    optionalString(obj, 'upToMessageId', channel)
    // CLI supports --fork-session with --resume
    try {
      const { execFileSync } = await import('node:child_process')
      const cliArgs = [
        '--resume',
        sessionId,
        '--fork-session',
        '-p',
        '--print',
        'forked',
        '--output-format',
        'json'
      ]
      const result = execFileSync('claude', cliArgs, { encoding: 'utf-8', timeout: 10_000 })
      return JSON.parse(result.trim())
    } catch (err) {
      log.warn(`[${channel}] Fork failed for ${sessionId}:`, err)
      return { success: false, error: 'Session fork failed' }
    }
  })
}
