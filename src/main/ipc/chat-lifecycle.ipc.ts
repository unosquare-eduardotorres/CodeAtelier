import { ipcMain, app, type BrowserWindow } from 'electron'
import { join, resolve } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import simpleGit from 'simple-git'
import {
  conversationRepository,
  conversationSpecialistRepository,
  messageRepository,
  workspaceRepository,
  turnUsageRepository,
  specialistRepository
} from '../db/repositories'
import { chatAgentService, fileService } from '../services'
import { repoService } from '../services/repo.service'
import { modelConfigService } from '../services/model-config.service'
import { contextWindowResolver } from '../services/context-window-resolver'
import { IPC_CHANNELS } from '../../shared/constants'
import type { ConversationMode, ContextUsageLevel, LLMProvider } from '../../shared/types'
import { githubService } from '../services/github.service'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'

const log = chatIpcLogger

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Conversation CRUD — create, delete, rename, reorder, list, get messages
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function registerConversationCrudIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_CONVERSATIONS,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)

      if (!args || typeof args.workspaceId !== 'string' || args.workspaceId.trim().length === 0) {
        throw new Error('Invalid workspace ID')
      }

      return conversationRepository.findByWorkspace(args.workspaceId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_CREATE_CONVERSATION,
    async (
      event,
      args: {
        workspaceId: string
        title?: string
        mode?: ConversationMode
        personaSpecialistId?: string
        llmProvider?: LLMProvider
        mcpOverrides?: Record<string, boolean>
      }
    ) => {
      validateSender(event)

      if (!args || typeof args.workspaceId !== 'string' || args.workspaceId.trim().length === 0) {
        throw new Error('Invalid workspace ID')
      }

      if (args.title !== undefined && (typeof args.title !== 'string' || args.title.length > 500)) {
        throw new Error('Invalid conversation title (max 500 chars)')
      }

      const validModes = ['plan', 'build']
      if (args.mode !== undefined && !validModes.includes(args.mode)) {
        throw new Error('Invalid mode: must be "plan" or "build"')
      }

      // Validate persona specialist if provided
      if (args.personaSpecialistId) {
        const specialist = specialistRepository.findById(args.personaSpecialistId)
        if (!specialist) throw new Error('Invalid persona specialist ID')
      }

      // Per-conversation LLM provider: explicit selection → workspace setting → 'claude'
      const wsRow = workspaceRepository.findById(args.workspaceId)
      const settings = JSON.parse(wsRow?.settingsJson ?? '{}')
      const llmProvider: LLMProvider =
        (args.llmProvider as LLMProvider) ?? settings.llmProvider ?? 'claude'

      const conversation = conversationRepository.create(
        args.workspaceId,
        args.title,
        args.mode,
        args.personaSpecialistId,
        llmProvider,
        args.mcpOverrides
      )
      conversationSpecialistRepository.initFromWorkspaceDefaults(conversation.id)

      // Auto-attach the workspace's Project Specialist (if one exists).
      // After migration 66 there's exactly one per workspace, so we just
      // upsert it into conversation_specialists to keep per-conversation
      // activation tracking intact.
      try {
        const projectSpecialist = specialistRepository.findByAgentId(
          `workspace-specialist-${args.workspaceId}`
        )
        if (projectSpecialist) {
          conversationSpecialistRepository.upsert(conversation.id, projectSpecialist.id, {
            isActive: true
          })
        }
      } catch (e) {
        log.warn('Project Specialist auto-attach failed:', e)
      }

      // Branch-per-conversation: auto-create branch if enabled in workspace settings
      if (settings.gitAutoBranch) {
        try {
          const git = simpleGit(wsRow!.repoPath)
          const isRepo = await git.checkIsRepo()
          if (isRepo) {
            const title = conversation.title || 'new-conversation'
            const slug = title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 50)
            const branchName = `chat/${slug}-${conversation.id.slice(0, 8)}`

            await git.checkoutLocalBranch(branchName)
            conversationRepository.updateBranchName(conversation.id, branchName)
            conversation.branchName = branchName
            log.info(`Auto-created branch: ${branchName}`)
          }
        } catch (e) {
          log.warn('Auto-branch creation failed (non-fatal):', e)
        }
      }

      return conversation
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_MESSAGES,
    async (event, args: { conversationId: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }

      return messageRepository.findByConversation(args.conversationId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_DELETE_CONVERSATION,
    async (event, args: { conversationId: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }

      const { conversationId } = args

      // Same cleanup as /close — stop agents and clear all data
      chatAgentService.clearSession(conversationId)

      conversationRepository.delete(conversationId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.CHAT_RENAME,
    async (event, args: { conversationId: string; title: string }) => {
      validateSender(event)

      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }
      if (typeof args.title !== 'string' || args.title.trim().length === 0) {
        throw new Error('Title cannot be empty')
      }
      if (args.title.length > 500) {
        throw new Error('Title too long (max 500 chars)')
      }

      const updated = conversationRepository.updateTitle(args.conversationId, args.title.trim())
      if (!updated) throw new Error('Conversation not found')
      return updated
    }
  )

  // ── Get file changes from git status for a conversation's workspace ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_GET_FILE_CHANGES,
    async (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('Invalid conversation ID')

      const conversation = conversationRepository.findById(args.conversationId)
      if (!conversation) throw new Error('Conversation not found')
      const workspace = workspaceRepository.findById(conversation.workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      return repoService.getUncommittedFileDetails(workspace.repoPath)
    }
  )

  // ── Switch git branch for a conversation ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SWITCH_BRANCH,
    async (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('Missing conversationId')

      const conversation = conversationRepository.findById(args.conversationId)
      if (!conversation?.branchName) return { switched: false, branch: null }

      const workspace = workspaceRepository.findById(conversation.workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      const git = simpleGit(workspace.repoPath)
      const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD'])

      // Already on the right branch
      if (currentBranch === conversation.branchName) {
        return { switched: false, branch: conversation.branchName }
      }

      // Auto-WIP-commit uncommitted changes on current branch
      const status = await git.status()
      const dirtyFiles = [
        ...status.modified,
        ...status.created,
        ...status.not_added,
        ...status.deleted,
        ...status.renamed.map((r) => r.to)
      ]
      if (dirtyFiles.length > 0) {
        try {
          await git.add(dirtyFiles)
          await git.commit('WIP: auto-save from conversation switch')
          log.info(`WIP commit on ${currentBranch} (${dirtyFiles.length} files)`)
        } catch (e) {
          log.warn('WIP auto-commit failed (proceeding with checkout):', e)
        }
      }

      // Switch to conversation's branch
      try {
        await git.checkout(conversation.branchName)
        log.info(`Switched to branch: ${conversation.branchName}`)
        return { switched: true, branch: conversation.branchName }
      } catch (e) {
        log.warn(`Failed to switch to branch ${conversation.branchName}:`, e)
        throw new Error(`Failed to switch to branch: ${conversation.branchName}`)
      }
    }
  )

  // ── Reorder conversations ──
  ipcMain.handle(
    IPC_CHANNELS.CONVERSATION_REORDER,
    async (event, args: { orderedIds: string[] }) => {
      validateSender(event)
      if (!args?.orderedIds || !Array.isArray(args.orderedIds)) {
        throw new Error('Invalid orderedIds')
      }
      conversationRepository.reorderConversations(args.orderedIds)
    }
  )

  // ── Resume at checkpoint — undo to a specific message point ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_RESUME_AT,
    async (event, args: { conversationId: string; messageId: string }) => {
      validateSender(event)
      if (!args?.messageId || typeof args.messageId !== 'string') {
        throw new Error('Invalid messageId')
      }
      await chatAgentService.resumeAt(args.messageId)
    }
  )

  // ── Update per-conversation external MCP overrides ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_UPDATE_MCP_OVERRIDES,
    async (event, args: { conversationId: string; overrides: Record<string, boolean> }) => {
      validateSender(event)
      if (
        !args ||
        typeof args.conversationId !== 'string' ||
        args.conversationId.trim().length === 0
      ) {
        throw new Error('Invalid conversation ID')
      }
      if (!args.overrides || typeof args.overrides !== 'object' || Array.isArray(args.overrides)) {
        throw new Error('Invalid overrides object')
      }
      const updated = conversationRepository.updateMcpOverrides(args.conversationId, args.overrides)
      if (!updated) throw new Error('Conversation not found')
      return updated
    }
  )
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Chat Mode — mode switching, persona, context usage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function registerChatModeIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.CHAT_UPDATE_MODE,
    async (event, args: { conversationId: string; mode: ConversationMode }) => {
      validateSender(event)

      if (!args || typeof args.conversationId !== 'string') {
        throw new Error('Invalid conversation ID')
      }

      const validModes = ['plan', 'build']
      if (!validModes.includes(args.mode)) {
        throw new Error('Invalid mode')
      }

      const updated = conversationRepository.updateMode(args.conversationId, args.mode)
      if (!updated) throw new Error('Conversation not found')

      // Mode is persisted to DB — CLI restart is deferred until next message send
      log.info(`Mode updated to "${args.mode}" in DB (CLI restart deferred until next send)`)

      return updated
    }
  )

  // ── Swap DaVinci → ready Project Specialist ──
  // Triggered when the user accepts an ask_user { action: 'swap-to-specialist' }
  // proposal. Re-runs chatAgentService.start() so resolveAdapter() picks the
  // ProjectSpecialistRoleAdapter (build_status is now 'ready'), which tears
  // down the DaVinci session and rebuilds as the specialist.
  ipcMain.handle(
    IPC_CHANNELS.CHAT_SWAP_TO_SPECIALIST,
    async (event, args: { workspaceId?: string; workspacePath?: string }) => {
      validateSender(event)
      if (
        !args ||
        (typeof args.workspaceId !== 'string' && typeof args.workspacePath !== 'string')
      ) {
        throw new Error('Invalid swap args — workspaceId or workspacePath required')
      }

      const workspace = args.workspaceId
        ? workspaceRepository.findById(args.workspaceId)
        : workspaceRepository.findByPath(args.workspacePath!)
      if (!workspace) throw new Error('Workspace not found')

      // Persist consent — resolveAdapter() reads this flag to decide whether to
      // pick the ProjectSpecialistRoleAdapter. Until set, the workspace stays on DaVinci.
      const settings = JSON.parse(workspace.settingsJson || '{}') as Record<string, unknown>
      settings.specialistSwapAccepted = true
      workspaceRepository.updateSettings(workspace.id, settings)

      // Re-start so resolveAdapter() now picks the ProjectSpecialistRoleAdapter,
      // which tears down the DaVinci session and rebuilds as the specialist.
      await chatAgentService.start(workspace.repoPath)
      log.info(`[chat:swap] User accepted swap for workspace=${workspace.id}`)
    }
  )

  // ── Update generalist persona (mid-conversation persona switch) ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_UPDATE_PERSONA,
    async (event, args: { conversationId: string; personaSpecialistId: string | null }) => {
      validateSender(event)
      if (!args || typeof args.conversationId !== 'string') {
        throw new Error('Invalid conversation ID')
      }
      if (args.personaSpecialistId) {
        const specialist = specialistRepository.findById(args.personaSpecialistId)
        if (!specialist) throw new Error('Invalid persona specialist ID')
      }
      const updated = conversationRepository.updatePersona(
        args.conversationId,
        args.personaSpecialistId
      )
      if (!updated) throw new Error('Conversation not found')

      await chatAgentService.switchPersona(args.personaSpecialistId, args.conversationId)
      log.info(`Persona → "${args.personaSpecialistId ?? 'Da Vinci'}" for ${args.conversationId}`)
      return updated
    }
  )

  // ── Context usage: return token consumption for a conversation ──
  // Strategy: SDK-first (accurate, live) → DB fallback (historical/idle)
  ipcMain.handle(
    IPC_CHANNELS.CONVERSATION_GET_CONTEXT_USAGE,
    async (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('Invalid conversation ID')

      // ── Strategy 1: Use SDK native context usage (accurate, live) ──
      const activeQuery = chatAgentService.getActiveQuery()
      const currentConvId = chatAgentService.getCurrentConversationId()

      if (activeQuery && currentConvId === args.conversationId) {
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
            const conversation = conversationRepository.findById(args.conversationId)
            if (conversation) {
              const workspace = workspaceRepository.findById(conversation.workspaceId)
              if (workspace && modelConfigService.isLocalProvider(workspace.repoPath)) {
                const llmConfig = modelConfigService.getLocalLLMConfig(workspace.repoPath)
                const settings = JSON.parse(workspace.settingsJson || '{}')
                const userOverride = settings.localContextWindow as number | undefined
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
              conversationId: args.conversationId,
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
      const lastTurn = turnUsageRepository.getLastTurn(args.conversationId)
      // Prefer context_tokens (SDK-reported, accounts for post-compaction state)
      // over summing raw API fields (which reflect pre-compaction totals).
      const inputTokens =
        lastTurn?.contextTokens && lastTurn.contextTokens > 0
          ? lastTurn.contextTokens
          : (lastTurn?.inputTokens ?? 0) +
            (lastTurn?.cacheReadTokens ?? 0) +
            (lastTurn?.cacheCreationTokens ?? 0)

      // Resolve context window — use full resolution chain for local LLMs, Claude's 1M otherwise
      let contextWindowSize = 1_000_000
      const dbConversation = conversationRepository.findById(args.conversationId)
      if (dbConversation) {
        const dbWorkspace = workspaceRepository.findById(dbConversation.workspaceId)
        if (dbWorkspace && modelConfigService.isLocalProvider(dbWorkspace.repoPath)) {
          const llmConfig = modelConfigService.getLocalLLMConfig(dbWorkspace.repoPath)
          const settings = JSON.parse(dbWorkspace.settingsJson || '{}')
          const userOverride = settings.localContextWindow as number | undefined
          contextWindowSize = await contextWindowResolver.resolve(llmConfig, userOverride)
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
        conversationId: args.conversationId,
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Chat Completion & Images — close, complete, clipboard images, image reading
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function registerChatCompletionIpc(): void {
  // ── /close: delete conversation and all associated data ──
  ipcMain.handle(IPC_CHANNELS.CHAT_CLOSE, async (event, args: { conversationId: string }) => {
    validateSender(event)
    if (!args?.conversationId) throw new Error('Invalid conversation ID')

    const { conversationId } = args

    // Stop running agents for this conversation
    chatAgentService.clearSession(conversationId)

    // Clean up branches (local + remote if PR was merged)
    const workspacePath = chatAgentService.getWorkspacePath()
    try {
      const conv = conversationRepository.findById(conversationId)
      if (conv?.branchName && workspacePath) {
        const git = simpleGit(workspacePath)
        const allWs = workspaceRepository.findAll()
        const ws = allWs.find((w) => w.repoPath === workspacePath)

        // Delete remote branch if PR was merged/closed
        if (conv.prNumber && ws && githubService.isConfigured(ws.id)) {
          try {
            const status = await githubService.getPullRequestStatus(
              ws.id,
              workspacePath,
              conv.prNumber
            )
            if (status === 'merged' || status === 'closed') {
              await githubService.deleteRemoteBranch(ws.id, workspacePath, conv.branchName)
            }
          } catch (e) {
            log.warn('Remote branch cleanup failed:', e)
          }
        }

        // Always clean up local branch
        try {
          await git.deleteLocalBranch(conv.branchName, true)
        } catch {
          /* branch may already be deleted */
        }
      }
    } catch (e) {
      log.warn('Branch cleanup failed:', e)
    }

    // Delete conversation (cascades: file_changes, messages, attachments, agent_worktrees)
    conversationRepository.delete(conversationId)
  })

  // ── /complete: commit changes, push, create PR, and clean up ──
  ipcMain.handle(
    IPC_CHANNELS.CHAT_COMPLETE,
    async (
      event,
      args: {
        conversationId: string
        branchName: string
        commitMessage: string
        description: string
      }
    ) => {
      validateSender(event)

      const { conversationId, commitMessage, description } = args
      if (!conversationId || !commitMessage) throw new Error('Missing required fields')

      // 1. Resolve workspace path
      const conversation = conversationRepository.findById(conversationId)
      if (!conversation) throw new Error('Conversation not found')
      const workspace = workspaceRepository.findById(conversation.workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      const git = simpleGit(workspace.repoPath)

      // Post-migration-66: no worktrees to merge (specialist-pool deleted).
      // Direct git flow commits against the workspace repo.
      try {
        log.debug(`No worktrees to merge for conversation ${conversationId}`)
      } catch (error) {
        if ((error as Error).message.includes('Merge conflict')) {
          throw error
        }
        log.warn('Worktree merge during /complete encountered an issue:', error)
      }

      // 2. Get ALL uncommitted files from git status
      const status = await git.status()
      const changedPaths = [
        ...status.modified,
        ...status.created,
        ...status.not_added,
        ...status.deleted,
        ...status.renamed.map((r) => r.to)
      ]
      if (changedPaths.length === 0) throw new Error('No uncommitted changes in workspace')

      // 3. Create feature branch — use user-provided name or auto-generate
      const branchName =
        args.branchName ||
        `chat/${conversation.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 50)}-${conversationId.slice(0, 8)}`

      const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD'])
      await git.checkoutLocalBranch(branchName)

      try {
        // 4. Stage all uncommitted files
        await git.add(changedPaths)

        // 5. Commit with message + description
        const fullMessage = description ? `${commitMessage}\n\n${description}` : commitMessage
        await git.commit(fullMessage)

        const commitHash = await git.revparse(['HEAD'])

        // 6. Push if remote exists
        let prUrl: string | undefined
        try {
          const remotes = await git.getRemotes(true)
          if (remotes.length > 0) {
            await git.push('origin', branchName, ['--set-upstream'])
          }
        } catch (e) {
          log.warn('Push failed (no remote or auth issue):', e)
          // Local commit still succeeded — that's fine
        }

        // 7. Auto-create PR if GitHub is configured
        if (githubService.isConfigured(workspace.id)) {
          try {
            const prResult = await githubService.createPullRequest({
              workspaceId: workspace.id,
              repoPath: workspace.repoPath,
              head: branchName,
              base: currentBranch,
              title: commitMessage,
              body: description
            })
            prUrl = prResult.prUrl
            conversationRepository.updatePrInfo(
              conversationId,
              prResult.prUrl,
              prResult.prNumber,
              branchName
            )
          } catch (e) {
            log.warn('GitHub PR creation failed (push succeeded):', e)
          }
        }

        // 8. Cleanup: stop agents, delete conversation
        chatAgentService.clearSession(conversationId)
        conversationRepository.delete(conversationId)

        return { branch: branchName, commitHash, prUrl }
      } catch (error) {
        // On failure, switch back to original branch and clean up
        try {
          await git.checkout(currentBranch)
          await git.deleteLocalBranch(branchName, true)
        } catch {
          /* best effort */
        }
        throw error
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.SAVE_CLIPBOARD_IMAGE,
    async (event, args: { dataUrl: string; conversationId: string }) => {
      validateSender(event)

      if (!args?.dataUrl || typeof args.dataUrl !== 'string') {
        throw new Error('Invalid image data')
      }

      // Extract base64 data from data URL
      const matches = args.dataUrl.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/)
      if (!matches) {
        throw new Error('Invalid image data URL format')
      }

      const ext = matches[1]
      const base64Data = matches[2]
      const buffer = Buffer.from(base64Data, 'base64')

      // Save to conversation-scoped directory
      const imageDir = join(
        app.getPath('userData'),
        'chat-images',
        args.conversationId || 'unsorted'
      )
      mkdirSync(imageDir, { recursive: true })

      const filename = `clipboard-${Date.now()}.${ext}`
      const filePath = join(imageDir, filename)
      writeFileSync(filePath, buffer)

      return filePath
    }
  )

  ipcMain.handle(IPC_CHANNELS.READ_IMAGE_BASE64, async (event, args: { filePath: string }) => {
    validateSender(event)

    if (!args?.filePath || typeof args.filePath !== 'string') {
      throw new Error('Invalid file path')
    }

    // Security: only allow reading from chat-images directory
    const chatImagesDir = join(app.getPath('userData'), 'chat-images')
    const resolved = resolve(args.filePath)
    if (!resolved.startsWith(chatImagesDir)) {
      throw new Error('Access denied: file is outside chat-images directory')
    }

    const { base64, mimeType } = fileService.readImageAsBase64(resolved)
    return `data:${mimeType};base64,${base64}`
  })
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Main entry point — orchestrates all chat lifecycle IPC registrations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function registerChatLifecycleIpc(_mainWindow: BrowserWindow): void {
  registerConversationCrudIpc()
  registerChatModeIpc()
  registerChatCompletionIpc()
}
