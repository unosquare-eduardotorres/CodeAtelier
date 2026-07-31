import { app, ipcMain } from 'electron'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import simpleGit from 'simple-git'
import {
  conversationRepository,
  conversationSpecialistRepository,
  messageRepository,
  workspaceRepository,
  specialistRepository
} from '../db/repositories'
import { todoRepository } from '../db/repositories/todo.repository'
import { chatAgentService } from '../services'
import { lifecycleRegistry } from '../services/conversation-lifecycle'
import { chatStreamService } from '../services/chat-stream.service'
import { repoService } from '../services/repo.service'
import { IPC_CHANNELS, VALID_COMMUNICATION_TONES } from '../../shared/constants'
import type { CommunicationTone, ConversationMode, LLMProvider, ModelRoleMap, ConversationModelSnapshot } from '../../shared/types'
import { buildConversationModelSnapshot } from '../services/model-config.service'
import { chatIpcLogger } from '../logger'
import { validateSender } from './validate-sender'
import { completeStreamMetrics } from './chunk-router'
import {
  requireObject,
  requireString,
  optionalString,
  requireStringArray,
  requirePlainObject
} from './validate-args'

const log = chatIpcLogger

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Extracted handlers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function handleCreateConversation(args: {
  workspaceId: string
  title?: string
  mode?: ConversationMode
  personaSpecialistId?: string
  /** @deprecated Use routingOverrides — kept as fallback */
  llmProvider?: LLMProvider
  /** Per-conversation routing overrides (Phase 1 addition) */
  routingOverrides?: Partial<ModelRoleMap>
  mcpOverrides?: Record<string, boolean>
  communicationTone?: CommunicationTone | null
  /** Audit run ID that sourced this conversation (Audit → Chat handoff) */
  sourceAuditRunId?: string
  /** Explicit branch name override — user-selected from branch picker at creation */
  branchName?: string
  /** When true, auto-create a branch from the title (overrides workspace gitAutoBranch setting) */
  autoBranch?: boolean
}): Promise<ReturnType<typeof conversationRepository.create>> {
  const ch = IPC_CHANNELS.CHAT_CREATE_CONVERSATION
  const {
    workspaceId,
    title,
    mode,
    personaSpecialistId,
    llmProvider,
    routingOverrides,
    mcpOverrides,
    communicationTone,
    sourceAuditRunId,
    branchName: explicitBranchName,
    autoBranch
  } = args

  if (title !== undefined && title.length > 500) {
    throw new Error(`${ch}: title too long (max 500 chars)`)
  }

  const validModes = ['plan', 'build', 'danger']
  if (mode !== undefined && !validModes.includes(mode)) {
    throw new Error(`${ch}: mode must be 'plan', 'build', or 'danger'`)
  }

  if (
    communicationTone !== undefined &&
    communicationTone !== null &&
    !VALID_COMMUNICATION_TONES.includes(
      communicationTone as (typeof VALID_COMMUNICATION_TONES)[number]
    )
  ) {
    throw new Error(`${ch}: invalid communication tone`)
  }

  if (personaSpecialistId) {
    const specialist = specialistRepository.findById(personaSpecialistId)
    if (!specialist) throw new Error(`${ch}: invalid persona specialist ID`)
  }

  // Build model config snapshot — frozen at creation time
  const settings = workspaceRepository.getSettings(workspaceId)
  const snapshot = buildConversationModelSnapshot(workspaceId, llmProvider, routingOverrides)

  // Per-conversation LLM provider: derived from snapshot's plan action provider.
  // snapshot.plan.provider is always defined (resolveAssignment always returns a provider).
  const resolvedProvider: LLMProvider = snapshot.plan.provider

  const conversation = conversationRepository.create(
    workspaceId,
    title,
    mode,
    personaSpecialistId,
    resolvedProvider,
    mcpOverrides,
    communicationTone,
    undefined, // type
    snapshot,
    sourceAuditRunId
  )
  conversationSpecialistRepository.initFromWorkspaceDefaults(conversation.id)

  // Auto-attach the workspace's Project Specialist (if one exists).
  try {
    const projectSpecialist = specialistRepository.findByAgentId(
      `workspace-specialist-${workspaceId}`
    )
    if (projectSpecialist) {
      conversationSpecialistRepository.upsert(conversation.id, projectSpecialist.id, {
        isActive: true
      })
    }
  } catch (e) {
    log.warn('Project Specialist auto-attach failed:', e)
  }

  // Git setup: capture source branch + optionally create auto-branch
  const wsRow = workspaceRepository.findById(workspaceId)
  if (wsRow?.repoPath) {
    try {
      const git = simpleGit(wsRow.repoPath)
      const isRepo = await git.checkIsRepo()
      if (isRepo) {
        // Capture the source branch at conversation creation time (always, not just gitAutoBranch)
        try {
          const sourceBranch = await git.revparse(['--abbrev-ref', 'HEAD'])
          conversationRepository.updateSourceBranch(conversation.id, sourceBranch)
          conversation.sourceBranch = sourceBranch
        } catch (e) {
          log.warn('Source branch capture failed (non-fatal):', e)
        }

        // Branch-per-conversation: create/checkout branch if explicitly requested, auto-branch selected, or gitAutoBranch enabled
        if (explicitBranchName || autoBranch === true || (autoBranch !== false && settings.gitAutoBranch)) {
          try {
            let branchName: string
            if (explicitBranchName) {
              // User provided an explicit branch name from the branch picker
              branchName = explicitBranchName
            } else {
              // Auto-generate branch name from conversation title
              const branchTitle = conversation.title || 'new-conversation'
              const slug = branchTitle
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 50)
              branchName = `chat/${slug}-${conversation.id.slice(0, 8)}`
            }

            // Smart checkout: check if branch exists, then checkout vs create
            const localBranches = await git.branchLocal()
            if (localBranches.all.includes(branchName)) {
              await git.checkout(branchName)
              log.info(`Checked out existing branch: ${branchName}`)
            } else {
              await git.checkoutLocalBranch(branchName)
              log.info(`Created and checked out new branch: ${branchName}`)
            }

            conversationRepository.updateBranchName(conversation.id, branchName)
            conversation.branchName = branchName
          } catch (e) {
            log.warn('Branch creation/checkout failed (non-fatal):', e)
          }
        }
      }
    } catch (e) {
      log.warn('Git initialization for conversation failed (non-fatal):', e)
    }
  }

  return conversation
}

async function handleSwitchBranch(
  conversationId: string
): Promise<{ switched: boolean; branch: string | null }> {
  const conversation = conversationRepository.findById(conversationId)
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Conversation CRUD — create, delete, rename, reorder, list, get messages
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function registerConversationCrudIpc(): void {
  ipcMain.handle(IPC_CHANNELS.CHAT_GET_CONVERSATIONS, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_GET_CONVERSATIONS
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)

    return conversationRepository.findByWorkspace(workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_CREATE_CONVERSATION, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_CREATE_CONVERSATION
    const args = requireObject(rawArgs, ch)
    return handleCreateConversation({
      workspaceId: requireString(args, 'workspaceId', ch),
      title: optionalString(args, 'title', ch),
      mode: optionalString(args, 'mode', ch) as ConversationMode | undefined,
      personaSpecialistId: optionalString(args, 'personaSpecialistId', ch),
      llmProvider: optionalString(args, 'llmProvider', ch) as LLMProvider | undefined,
      routingOverrides: args.routingOverrides as Partial<ModelRoleMap> | undefined,
      mcpOverrides: args.mcpOverrides as Record<string, boolean> | undefined,
      communicationTone: args.communicationTone as CommunicationTone | null | undefined,
      sourceAuditRunId: optionalString(args, 'sourceAuditRunId', ch),
      branchName: optionalString(args, 'branchName', ch),
      autoBranch: typeof args.autoBranch === 'boolean' ? args.autoBranch : undefined
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_GET_MESSAGES, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_GET_MESSAGES
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)

    return messageRepository.findByConversation(conversationId)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_GET_TODOS, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_GET_TODOS
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)
    return todoRepository.findByConversation(conversationId)
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_SET_PLAN_ACTION, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_SET_PLAN_ACTION
    const args = requireObject(rawArgs, ch)
    const messageId = requireString(args, 'messageId', ch)
    const action = requireString(args, 'action', ch)
    messageRepository.updatePlanAction(messageId, action)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_DELETE_CONVERSATION, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_DELETE_CONVERSATION
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)

    // CONV-DEL-RACE-01: Abort active stream before cascade-delete to prevent
    // FK violations when finalizeStreamMessage() races with conversation deletion.
    if (lifecycleRegistry.isStreaming(conversationId)) {
      // CHAT-METRICS-ABORT-ORPHAN-01: Clean up metrics before abort to prevent leak.
      completeStreamMetrics(conversationId, 'aborted')
      lifecycleRegistry.abort(conversationId, 'conversation-deleted')
    }

    chatAgentService.clearSession(conversationId)
    // N1-FIX: Clear per-conversation memory dedupe state so facts can be
    // re-injected in future conversations about the same topics.
    chatStreamService.clearConversationMemoryState(conversationId)

    conversationRepository.delete(conversationId)

    // Clean up clipboard images for this conversation
    try {
      const imageDir = join(app.getPath('userData'), 'chat-images', conversationId)
      rmSync(imageDir, { recursive: true, force: true })
    } catch {
      /* best effort — directory may not exist */
    }
  })

  ipcMain.handle(IPC_CHANNELS.CHAT_RENAME, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_RENAME
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)
    const title = requireString(args, 'title', ch)

    if (title.length > 500) {
      throw new Error(`${ch}: title too long (max 500 chars)`)
    }

    const updated = conversationRepository.updateTitle(conversationId, title.trim())
    if (!updated) throw new Error('Conversation not found')
    return updated
  })

  // ── Get file changes from git status for a conversation's workspace ──
  ipcMain.handle(IPC_CHANNELS.CHAT_GET_FILE_CHANGES, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_GET_FILE_CHANGES
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)

    const conversation = conversationRepository.findById(conversationId)
    if (!conversation) throw new Error('Conversation not found')
    const workspace = workspaceRepository.findById(conversation.workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    return repoService.getUncommittedFileDetails(workspace.repoPath)
  })

  // ── Switch git branch for a conversation ──
  ipcMain.handle(IPC_CHANNELS.CHAT_SWITCH_BRANCH, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_SWITCH_BRANCH
    const args = requireObject(rawArgs, ch)
    return handleSwitchBranch(requireString(args, 'conversationId', ch))
  })

  // ── Reorder conversations ──
  ipcMain.handle(IPC_CHANNELS.CONVERSATION_REORDER, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CONVERSATION_REORDER
    const args = requireObject(rawArgs, ch)
    const orderedIds = requireStringArray(args, 'orderedIds', ch)
    conversationRepository.reorderConversations(orderedIds)
  })

  // ── Resume at checkpoint — undo to a specific message point ──
  ipcMain.handle(IPC_CHANNELS.CHAT_RESUME_AT, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_RESUME_AT
    const args = requireObject(rawArgs, ch)
    const messageId = requireString(args, 'messageId', ch)
    const conversationId = requireString(args, 'conversationId', ch)

    // RESUME-ORPHAN-01: Look up the message to get its timestamp for truncation
    const message = messageRepository.findById(messageId)
    if (!message) throw new Error(`${ch}: message not found`)

    await chatAgentService.resumeAt(messageId)

    // Clean up all post-resume database state (mirroring CHECKPOINT_REWIND)
    try {
      messageRepository.truncateAfterTimestamp(conversationId, message.createdAt)
    } catch (err) {
      log.error(`[resumeAt] Message truncation failed:`, err)
    }

    // RESUME-PENDING-STATE-01: Clear pending compaction/context and stale session ID
    chatAgentService.clearConversationPendingState(conversationId)
    try {
      conversationRepository.updateSessionId(conversationId, '')
    } catch (err) {
      log.error(`[resumeAt] Session ID clear failed:`, err)
    }
  })

  // ── Update per-conversation external MCP overrides ──
  ipcMain.handle(IPC_CHANNELS.CHAT_UPDATE_MCP_OVERRIDES, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_UPDATE_MCP_OVERRIDES
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)
    const overrides = requirePlainObject(args, 'overrides', ch) as Record<string, boolean>
    const updated = conversationRepository.updateMcpOverrides(conversationId, overrides)
    if (!updated) throw new Error('Conversation not found')
    return updated
  })

  // ── Update per-conversation model routing (per-chat model switching) ──
  ipcMain.handle(IPC_CHANNELS.CHAT_UPDATE_ROUTING, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_UPDATE_ROUTING
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)
    const workspaceId = requireString(args, 'workspaceId', ch)

    // Optional: explicit provider override; otherwise uses workspace default.
    // NOTE (audit finding #2): Passing llmProvider alone (without routingOverrides)
    // is a no-op when the conversation already has a snapshot — the seeded role
    // entries below have highest resolution priority and mask the provider switch.
    // To change the provider, callers must also send explicit routingOverrides.
    const llmProvider = optionalString(args, 'llmProvider', ch) as LLMProvider | undefined
    const routingOverrides = args.routingOverrides as Partial<ModelRoleMap> | undefined

    // Seed overrides from the existing snapshot so untouched roles are preserved
    // (prevents silent re-resolution if workspace defaults changed since creation)
    const existing = conversationRepository.findById(conversationId)?.modelConfigSnapshot
    const seeded: Partial<ModelRoleMap> = existing
      ? {
          'specialist:plan': {
            provider: existing.plan.provider,
            modelId: existing.plan.modelId,
            localBackend: existing.plan.localBackend
          },
          'specialist:build': {
            provider: existing.build.provider,
            modelId: existing.build.modelId,
            localBackend: existing.build.localBackend
          },
          haiku: {
            provider: existing.background.provider,
            modelId: existing.background.modelId,
            localBackend: existing.background.localBackend
          }
        }
      : {}

    // Build a new snapshot seeded from existing + user overrides (does NOT affect other chats)
    const snapshot: ConversationModelSnapshot = buildConversationModelSnapshot(
      workspaceId,
      llmProvider,
      { ...seeded, ...routingOverrides }
    )

    // Persist snapshot + derived provider to this conversation only
    const resolvedProvider: LLMProvider = snapshot.plan.provider
    const updated = conversationRepository.updateModelSnapshot(
      conversationId,
      snapshot,
      resolvedProvider
    )
    if (!updated) throw new Error('Conversation not found')

    log.info(
      `[CHAT_UPDATE_ROUTING] conversationId=${conversationId} ` +
        `provider=${resolvedProvider} plan=${snapshot.plan.modelId} build=${snapshot.build.modelId}`
    )
    return updated
  })

  // ── Update per-conversation communication tone ──
  ipcMain.handle(IPC_CHANNELS.CHAT_UPDATE_TONE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_UPDATE_TONE
    const args = requireObject(rawArgs, ch)
    const conversationId = requireString(args, 'conversationId', ch)
    // Validate tone: must be a valid tone or null (use workspace default)
    const communicationTone = args.communicationTone as CommunicationTone | null
    if (
      communicationTone !== null &&
      !VALID_COMMUNICATION_TONES.includes(
        communicationTone as (typeof VALID_COMMUNICATION_TONES)[number]
      )
    ) {
      throw new Error(`${ch}: invalid communication tone`)
    }
    const updated = conversationRepository.updateTone(conversationId, communicationTone)
    if (!updated) throw new Error('Conversation not found')
    return updated
  })
}
