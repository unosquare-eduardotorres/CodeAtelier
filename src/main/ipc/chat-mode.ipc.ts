import { ipcMain } from 'electron'
import {
  conversationRepository,
  workspaceRepository,
  turnUsageRepository
} from '../db/repositories'
import { modelConfigService } from '../services/model-config.service'
import { contextWindowResolver } from '../services/context-window-resolver'
import {
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  CLAUDE_1M_CONTEXT_WINDOW,
  IPC_CHANNELS,
  supportsContext1M
} from '../../shared/constants'
import type { ConversationMode, ThinkingEffort } from '../../shared/types'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'
import { resolveContextLevel } from './context-usage-level'
import { conversationLifecycle } from '../services/conversation-lifecycle'

const log = chatIpcLogger

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Chat Mode — mode switching, effort, context usage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function registerChatModeIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CHAT_UPDATE_MODE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CHAT_UPDATE_MODE)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.CHAT_UPDATE_MODE)
    const mode = requireString(args, 'mode', IPC_CHANNELS.CHAT_UPDATE_MODE)

    // CONV-MODIFY-RACE-01: Prevent mode changes during active streaming
    if (
      conversationLifecycle.conversationId === conversationId &&
      conversationLifecycle.isActive
    ) {
      throw new Error('Cannot change mode while streaming — stop or wait for completion')
    }

    const validModes = ['plan', 'build', 'danger']
    if (!validModes.includes(mode)) {
      throw new Error(`${IPC_CHANNELS.CHAT_UPDATE_MODE}: mode must be "plan", "build", or "danger"`)
    }

    const updated = conversationRepository.updateMode(conversationId, mode as ConversationMode)
    if (!updated) throw new Error('Conversation not found')

    log.info(`Mode updated to "${mode}" in DB (CLI restart deferred until next send)`)

    return updated
  })

  // ── Update thinking effort ──
  ipcMain.handle(IPC_CHANNELS.CHAT_UPDATE_EFFORT, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CHAT_UPDATE_EFFORT)
    const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.CHAT_UPDATE_EFFORT)
    const effort = requireString(args, 'effort', IPC_CHANNELS.CHAT_UPDATE_EFFORT)

    // CONV-MODIFY-RACE-01: Prevent effort changes during active streaming
    if (
      conversationLifecycle.conversationId === conversationId &&
      conversationLifecycle.isActive
    ) {
      throw new Error('Cannot change effort while streaming — stop or wait for completion')
    }

    const validEfforts: ThinkingEffort[] = ['low', 'medium', 'high']
    if (!validEfforts.includes(effort as ThinkingEffort)) {
      throw new Error(
        `${IPC_CHANNELS.CHAT_UPDATE_EFFORT}: effort must be "low", "medium", or "high"`
      )
    }

    const updated = conversationRepository.updateEffort(conversationId, effort as ThinkingEffort)
    if (!updated) throw new Error('Conversation not found')

    log.info(`Effort updated to "${effort}" for conversation ${conversationId}`)

    return { effort }
  })

  // ── Context usage: return token consumption for a conversation ──
  // Computed from the last persisted turn's tokens vs. the resolved context
  // window. (The former SDK getContextUsage() "Strategy 1" was removed: the CLI
  // and OpenCode backends don't expose a Query object — getActiveQuery() always
  // returned null — so this DB-backed computation is the single source of truth.
  // Live per-turn updates are pushed separately via the context_usage_update
  // chunk in agent-stream-processor.processMetaChunk.)
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET_CONTEXT_USAGE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const args = requireObject(rawArgs, IPC_CHANNELS.CONVERSATION_GET_CONTEXT_USAGE)
    const conversationId = requireString(
      args,
      'conversationId',
      IPC_CHANNELS.CONVERSATION_GET_CONTEXT_USAGE
    )

    const lastTurn = turnUsageRepository.getLastTurn(conversationId)
    // Prefer context_tokens (SDK-reported, accounts for post-compaction state)
    // over summing raw API fields (which reflect pre-compaction totals).
    const inputTokens =
      lastTurn?.contextTokens && lastTurn.contextTokens > 0
        ? lastTurn.contextTokens
        : (lastTurn?.inputTokens ?? 0) +
          (lastTurn?.cacheReadTokens ?? 0) +
          (lastTurn?.cacheCreationTokens ?? 0)

    // Resolve context window — model-aware for Claude, full resolution chain for local LLMs
    let contextWindowSize = CLAUDE_DEFAULT_CONTEXT_WINDOW
    const dbConversation = conversationRepository.findById(conversationId)
    if (dbConversation) {
      const dbWorkspace = workspaceRepository.findById(dbConversation.workspaceId)
      if (dbWorkspace) {
        if (modelConfigService.isLocalProvider(dbWorkspace.repoPath)) {
          const llmConfig = modelConfigService.getLocalLLMConfig(dbWorkspace.repoPath)
          const ctxSettings = workspaceRepository.getSettings(dbWorkspace.id)
          const userOverride = ctxSettings.localContextWindow
          contextWindowSize = await contextWindowResolver.resolve(llmConfig, userOverride)
        } else {
          // Resolve whether the model used in this workspace supports the 1M beta
          const model = modelConfigService.getModel(dbWorkspace.repoPath, 'specialist:plan')
          contextWindowSize = supportsContext1M(model)
            ? CLAUDE_1M_CONTEXT_WINDOW
            : CLAUDE_DEFAULT_CONTEXT_WINDOW
        }
      }
    }
    const percentage = Math.round((inputTokens / contextWindowSize) * 100)
    const { level, qualityLevel } = resolveContextLevel(percentage, contextWindowSize)

    return {
      conversationId,
      inputTokens,
      contextWindowSize,
      percentage,
      level,
      qualityLevel,
      source: 'db' as const
    }
  })
}
