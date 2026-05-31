import { ipcMain } from 'electron'
import {
  conversationRepository,
  workspaceRepository,
  turnUsageRepository,
  specialistRepository
} from '../db/repositories'
import { chatAgentService } from '../services'
import { modelConfigService } from '../services/model-config.service'
import { contextWindowResolver } from '../services/context-window-resolver'
import {
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  CLAUDE_1M_CONTEXT_WINDOW,
  IPC_CHANNELS,
  supportsContext1M
} from '../../shared/constants'
import type { ConversationMode, ContextUsageLevel, ThinkingEffort } from '../../shared/types'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'

const log = chatIpcLogger

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Chat Mode — mode switching, persona, context usage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function registerChatModeIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_UPDATE_MODE,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.CHAT_UPDATE_MODE)
      const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.CHAT_UPDATE_MODE)
      const mode = requireString(args, 'mode', IPC_CHANNELS.CHAT_UPDATE_MODE)

      const validModes = ['plan', 'build', 'danger']
      if (!validModes.includes(mode)) {
        throw new Error(`${IPC_CHANNELS.CHAT_UPDATE_MODE}: mode must be "plan", "build", or "danger"`)
      }

      const updated = conversationRepository.updateMode(conversationId, mode as ConversationMode)
      if (!updated) throw new Error('Conversation not found')

      log.info(`Mode updated to "${mode}" in DB (CLI restart deferred until next send)`)

      return updated
    }
  )

  // ── Update thinking effort ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_UPDATE_EFFORT,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.CHAT_UPDATE_EFFORT)
      const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.CHAT_UPDATE_EFFORT)
      const effort = requireString(args, 'effort', IPC_CHANNELS.CHAT_UPDATE_EFFORT)

      const validEfforts: ThinkingEffort[] = ['low', 'medium', 'high']
      if (!validEfforts.includes(effort as ThinkingEffort)) {
        throw new Error(`${IPC_CHANNELS.CHAT_UPDATE_EFFORT}: effort must be "low", "medium", or "high"`)
      }

      const updated = conversationRepository.updateEffort(conversationId, effort as ThinkingEffort)
      if (!updated) throw new Error('Conversation not found')

      log.info(`Effort updated to "${effort}" for conversation ${conversationId}`)

      return { effort }
    }
  )

  // ── Swap DaVinci → ready Project Specialist ──
  // Triggered when the user accepts an ask_user { action: 'swap-to-specialist' }
  // proposal. Re-runs chatAgentService.start() so resolveAdapter() picks the
  // ProjectSpecialistRoleAdapter (build_status is now 'ready'), which tears
  // down the DaVinci session and rebuilds as the specialist.
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SWAP_TO_SPECIALIST,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.CHAT_SWAP_TO_SPECIALIST)
      const workspaceId = optionalString(args, 'workspaceId', IPC_CHANNELS.CHAT_SWAP_TO_SPECIALIST)
      const workspacePath = optionalString(args, 'workspacePath', IPC_CHANNELS.CHAT_SWAP_TO_SPECIALIST)
      if (!workspaceId && !workspacePath) {
        throw new Error(`${IPC_CHANNELS.CHAT_SWAP_TO_SPECIALIST}: workspaceId or workspacePath required`)
      }

      const workspace = workspaceId
        ? workspaceRepository.findById(workspaceId)
        : workspaceRepository.findByPath(workspacePath!)
      if (!workspace) throw new Error('Workspace not found')

      // Persist consent — resolveAdapter() reads this flag to decide whether to
      // pick the ProjectSpecialistRoleAdapter. Until set, the workspace stays on DaVinci.
      const swapSettings = workspaceRepository.getSettings(workspace.id)
      swapSettings.specialistSwapAccepted = true
      workspaceRepository.updateSettings(workspace.id, swapSettings)

      // Re-start so resolveAdapter() now picks the ProjectSpecialistRoleAdapter,
      // which tears down the DaVinci session and rebuilds as the specialist.
      await chatAgentService.start(workspace.repoPath)
      log.info(`[chat:swap] User accepted swap for workspace=${workspace.id}`)
    }
  )

  // ── Update generalist persona (mid-conversation persona switch) ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_UPDATE_PERSONA,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.CHAT_UPDATE_PERSONA)
      const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.CHAT_UPDATE_PERSONA)
      const personaSpecialistId = (args.personaSpecialistId as string | null) ?? null
      if (personaSpecialistId) {
        const specialist = specialistRepository.findById(personaSpecialistId)
        if (!specialist) throw new Error('Invalid persona specialist ID')
      }
      const updated = conversationRepository.updatePersona(
        conversationId,
        personaSpecialistId
      )
      if (!updated) throw new Error('Conversation not found')

      await chatAgentService.switchPersona(personaSpecialistId, conversationId)
      log.info(`Persona → "${personaSpecialistId ?? 'Da Vinci'}" for ${conversationId}`)
      return updated
    }
  )

  // ── Context usage: return token consumption for a conversation ──
  // Strategy: SDK-first (accurate, live) → DB fallback (historical/idle)
  ipcMain.handle(
    IPC_CHANNELS.CONVERSATION_GET_CONTEXT_USAGE,
    async (event, rawArgs: unknown) => {
      validateSender(event)
      const args = requireObject(rawArgs, IPC_CHANNELS.CONVERSATION_GET_CONTEXT_USAGE)
      const conversationId = requireString(args, 'conversationId', IPC_CHANNELS.CONVERSATION_GET_CONTEXT_USAGE)

      // ── Strategy 1: Use SDK native context usage (accurate, live) ──
      const activeQuery = chatAgentService.getActiveQuery()
      const currentConvId = chatAgentService.getCurrentConversationId()

      if (activeQuery && currentConvId === conversationId) {
        try {
          const sdkUsage = await activeQuery.getContextUsage()
          if (sdkUsage && typeof sdkUsage === 'object' && 'totalTokens' in sdkUsage) {
            const sdk = sdkUsage as {
              totalTokens: number
              maxTokens: number
              percentage?: number
              model?: string
              categories?: {
                name: string
                tokens: number
                color: string
                isDeferred?: boolean
              }[]
              mcpTools?: {
                name: string
                serverName: string
                tokens: number
                isLoaded?: boolean
              }[]
              systemTools?: { name: string; tokens: number }[]
              deferredBuiltinTools?: { name: string; tokens: number; isLoaded: boolean }[]
              memoryFiles?: { path: string; type: string; tokens: number }[]
              autoCompactThreshold?: number
              isAutoCompactEnabled?: boolean
            }
            // For local LLMs: SDK reports the backend's working limit (oMLX scales
            // it down, Ollama defaults by VRAM). Override with the resolved model
            // context window so the UI shows the real capability.
            let effectiveMaxTokens = sdk.maxTokens
            const conversation = conversationRepository.findById(conversationId)
            if (conversation) {
              const workspace = workspaceRepository.findById(conversation.workspaceId)
              if (workspace && modelConfigService.isLocalProvider(workspace.repoPath)) {
                const llmConfig = modelConfigService.getLocalLLMConfig(workspace.repoPath)
                const ctxSettings = workspaceRepository.getSettings(workspace.id)
                const userOverride = ctxSettings.localContextWindow
                const resolved = await contextWindowResolver.resolve(llmConfig, userOverride)
                if (resolved > sdk.maxTokens) {
                  log.info(
                    `[ContextUsage] Overriding SDK maxTokens ${sdk.maxTokens} → ${resolved} (${llmConfig.backend})`
                  )
                  effectiveMaxTokens = resolved
                }
              }
            }

            const percentage =
              sdk.percentage && effectiveMaxTokens === sdk.maxTokens
                ? sdk.percentage
                : Math.round((sdk.totalTokens / effectiveMaxTokens) * 100)
            // Quality window scales with context window: 50% of max, capped at 500K
            // For 1M context: 500K quality window. For 200K context: 100K quality window.
            const effectiveQualityWindow = Math.min(Math.round(effectiveMaxTokens * 0.5), 500_000)
            const qualityPercentage = Math.round((sdk.totalTokens / effectiveQualityWindow) * 100)
            const level: ContextUsageLevel =
              qualityPercentage > 80
                ? 'critical'
                : qualityPercentage > 60
                  ? 'red'
                  : qualityPercentage > 40
                    ? 'yellow'
                    : 'green'
            const qualityLevel: 'excellent' | 'good' | 'moderate' | 'low' =
              qualityPercentage <= 40
                ? 'excellent'
                : qualityPercentage <= 60
                  ? 'good'
                  : qualityPercentage <= 80
                    ? 'moderate'
                    : 'low'

            return {
              conversationId,
              inputTokens: sdk.totalTokens,
              contextWindowSize: effectiveMaxTokens,
              percentage,
              level,
              qualityLevel,
              categories: sdk.categories,
              breakdown: {
                categories: sdk.categories,
                mcpTools: sdk.mcpTools,
                systemTools: sdk.systemTools,
                deferredBuiltinTools: sdk.deferredBuiltinTools,
                memoryFiles: sdk.memoryFiles,
                autoCompactThreshold: sdk.autoCompactThreshold,
                isAutoCompactEnabled: sdk.isAutoCompactEnabled
              },
              model: sdk.model,
              source: 'sdk' as const
            }
          }
        } catch (err) {
          log.warn('SDK getContextUsage failed, falling back to DB:', err)
          // Fall through to DB-based calculation
        }
      }

      // ── Strategy 2: DB fallback (historical/idle conversations) ──
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
            const model = modelConfigService.getModel(dbWorkspace.repoPath, 'da-vinci:plan')
            contextWindowSize = supportsContext1M(model)
              ? CLAUDE_1M_CONTEXT_WINDOW
              : CLAUDE_DEFAULT_CONTEXT_WINDOW
          }
        }
      }
      // Quality window scales with context window: 50% of max, capped at 500K
      const effectiveQualityWindow = Math.min(Math.round(contextWindowSize * 0.5), 500_000)
      const percentage = Math.round((inputTokens / contextWindowSize) * 100)
      const qualityPercentage = Math.round((inputTokens / effectiveQualityWindow) * 100)
      const level: ContextUsageLevel =
        qualityPercentage > 80
          ? 'critical'
          : qualityPercentage > 60
            ? 'red'
            : qualityPercentage > 40
              ? 'yellow'
              : 'green'
      const qualityLevel: 'excellent' | 'good' | 'moderate' | 'low' =
        qualityPercentage <= 40
          ? 'excellent'
          : qualityPercentage <= 60
            ? 'good'
            : qualityPercentage <= 80
              ? 'moderate'
              : 'low'

      return {
        conversationId,
        inputTokens,
        contextWindowSize,
        percentage,
        level,
        qualityLevel,
        source: 'db' as const
      }
    }
  )
}
