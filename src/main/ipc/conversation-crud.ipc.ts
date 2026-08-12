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
import type {
  CommunicationTone,
  ConversationMode,
  LLMProvider,
  ModelRoleMap,
  ConversationModelSnapshot
} from '../../shared/types'
import { buildConversationModelSnapshot } from '../services/model-config.service'
import { trackService } from '../services/track.service'
import { trackRepository } from '../db/repositories/track.repository'
import { loadBranchOptions } from './load-branch-options'
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
  /**
   * Take the selected branch from whatever holds it right now.
   *
   * Only ever set by an explicit confirmation in the picker: seizing another
   * chat's or blueprint's working tree silently is exactly the surprise the
   * track system exists to prevent.
   */
  takeover?: boolean
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
    autoBranch,
    takeover
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

        // Branch-per-conversation is the DEFAULT, not an opt-in.
        //
        // Isolation only engages for conversations that own a branch (see
        // WorktreeService.ensure). While `gitAutoBranch` defaulted to off, the
        // common case was branchName = null → every chat executed in the shared
        // primary tree, which is exactly the cross-contamination worktrees
        // exist to prevent. So `undefined` now means yes; only an explicit
        // `false` — the user picking "work on the current branch", or the
        // workspace setting turned off deliberately — opts out.
        const workspaceOptedOut = settings.gitAutoBranch === false
        if (
          explicitBranchName ||
          autoBranch === true ||
          (autoBranch !== false && !workspaceOptedOut)
        ) {
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

            // Create the ref, never check it out.
            //
            // `git.checkout`/`checkoutLocalBranch` used to run here against the
            // workspace root. That moved a HEAD shared by every conversation:
            // creating a chat while another chat was mid-turn redirected the
            // running agent's writes onto the new branch. It also defeated
            // isolation outright — with the primary tree sitting on the new
            // branch, `ensure()` took its "primary already holds this branch"
            // path and returned isolated: false, so the chats most likely to
            // need a worktree were the ones that never got one.
            //
            // The branch is checked out later, in this conversation's own
            // worktree, by `git worktree add`.
            const localBranches = await git.branchLocal()
            if (localBranches.all.includes(branchName)) {
              log.info(`Reusing existing branch: ${branchName}`)
            } else {
              await git.raw(['branch', branchName])
              log.info(`Created branch (not checked out): ${branchName}`)
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

  if (takeover && conversation.branchName) {
    takeOverHeldBranch(conversation.id, workspaceId, conversation.branchName)
  }

  return conversation
}

/**
 * Hand a branch — and the directory it is checked out in — to a new chat.
 *
 * The blueprint side of this has existed since blueprints got worktrees
 * (`blueprint-track.ts`); chats had no way back. A finished blueprint holds its
 * branch forever, so "continue this work in a chat" meant either a fork of the
 * code or a hard refusal from the lent-branch guard.
 *
 * `transferOwner` moves the owner columns only: the worktree is not recreated
 * and nothing is copied, so the chat opens on exactly the files the previous
 * owner left, uncommitted ones included, with `node_modules` still linked.
 *
 * Not caught here: a busy holder must reach the user. Being told "the blueprint
 * is still running" is the entire reason the busy probe exists, and silently
 * degrading to a fresh worktree would put the chat somewhere other than where
 * the user asked for.
 */
function takeOverHeldBranch(conversationId: string, workspaceId: string, branchName: string): void {
  const holder = trackRepository.findByBranch(workspaceId, branchName)
  if (!holder || holder.ownerId === conversationId) return

  const outcome = trackService.transferOwner(holder.id, {
    ownerKind: 'chat',
    ownerId: conversationId
  })

  if (outcome.ok) {
    log.info(
      `[takeover] chat ${conversationId} took ${branchName} from ` +
        `${holder.ownerKind}:${holder.ownerId ?? '—'} at ${outcome.track.path}`
    )
    return
  }

  if (outcome.reason === 'busy') {
    const who = outcome.holder.label ?? outcome.holder.ownerId ?? 'other work'
    // The chat was created moments ago, in this call, and nothing references it
    // yet. Leaving it behind would put a chat in the sidebar that failed to get
    // the one thing it was created for.
    try {
      conversationRepository.delete(conversationId)
    } catch (e) {
      log.warn('[takeover] could not roll back the new conversation:', e)
    }
    throw new Error(
      `${who} is using "${branchName}" right now — ${outcome.because}. ` +
        `Try again once it is idle, or pick another branch.`
    )
  }

  // 'no-tree' or 'absent': the bookkeeping outlived the directory. Nothing to
  // hand over, so the first turn's ensureTrack builds a fresh worktree on the
  // branch — which is the right outcome, not a failure.
  log.info(
    `[takeover] chat ${conversationId} could not inherit ${branchName} ` +
      `(${outcome.reason}) — a new working tree will be created for it`
  )
}

/**
 * Report which branch a conversation works on. Deliberately does not touch git.
 *
 * This used to WIP-commit the working tree and `git checkout` the chat's
 * branch. Both behaviours were unsafe once more than one conversation could
 * stream at a time:
 *
 *  - The checkout moved a HEAD shared by every running agent. Selecting chat B
 *    while chat A was mid-turn redirected A's remaining writes onto B's branch.
 *  - The WIP commit ran `git add` over `status.not_added`, i.e. untracked
 *    files. Anything not covered by .gitignore — .env files, dumps, keys — was
 *    committed without the user asking, and `/complete` would then push it.
 *
 * Isolation now comes from a per-conversation worktree created at turn start,
 * so the branch a chat owns is already checked out in its own directory and
 * selecting a chat is a pure UI action.
 */
async function handleSwitchBranch(
  conversationId: string
): Promise<{ switched: boolean; branch: string | null }> {
  const conversation = conversationRepository.findById(conversationId)
  if (!conversation?.branchName) return { switched: false, branch: null }

  const workspace = workspaceRepository.findById(conversation.workspaceId)
  if (!workspace) throw new Error('Workspace not found')

  // `switched` stays false: nothing on disk moved. The branch is reported so
  // the status bar can show where this chat's work goes.
  return { switched: false, branch: conversation.branchName }
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
      autoBranch: typeof args.autoBranch === 'boolean' ? args.autoBranch : undefined,
      takeover: args.takeover === true
    })
  })

  // ── Branches a new chat may pick from, and who holds each one ──
  ipcMain.handle(IPC_CHANNELS.CHAT_BRANCH_OPTIONS, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.CHAT_BRANCH_OPTIONS
    const args = requireObject(rawArgs, ch)
    return loadBranchOptions(requireString(args, 'workspaceId', ch))
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

    // Released before the row disappears, so the outcome is known while the
    // chat still exists: a `retained` result has to suppress the branch cleanup
    // below, and there is nothing left to ask once the conversation is gone.
    //
    // Deleting a chat does not authorise deleting its uncommitted work. A dirty
    // tree comes back `retained` — kept on disk and detached from this row, so
    // it outlives the chat rather than disappearing with it.
    try {
      const outcome = await trackService.release(conversationId)
      if (outcome === 'retained') {
        log.info(
          `[chat:delete] conversation ${conversationId} had uncommitted changes — ` +
            `its working tree was retained rather than deleted`
        )
      }
    } catch (e) {
      log.warn('Worktree release during delete failed (non-fatal):', e)
    }

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
