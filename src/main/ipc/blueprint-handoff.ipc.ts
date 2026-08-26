/**
 * Blueprint → Chat handoff.
 *
 * Joins the two halves that already existed separately: the track system could
 * move a blueprint's branch (and the worktree it is checked out in) to a chat,
 * and the Unified Handoff Protocol could describe what the blueprint did — but
 * nothing called the second one and nothing called them together.
 *
 * What crosses the boundary is deliberately *pointers*, not content. A finished
 * blueprint's spec, plan, tasks and output are files in the worktree the chat is
 * about to inherit; inlining them into the first message would be lossy (the
 * standard render truncates) and redundant (the agent can read them).
 *
 * Nothing here sends anything. The composed message goes back to the renderer
 * and is staged in the chat's composer, because two of the four intents commit
 * and push code and none of them should start without the user pressing Send.
 */

import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import { requireObject, requireString, optionalString } from './validate-args'
import { blueprintService } from '../services/blueprint.service'
import { blueprintAdapter } from '../services/handoff-adapters/blueprint.adapter'
import { handoffService } from '../services/handoff.service'
import { handoffRepository } from '../db/repositories/handoff.repository'
import { trackRepository } from '../db/repositories/track.repository'
import { trackService } from '../services/track.service'
import { conversationRepository } from '../db/repositories'
import { handleCreateConversation } from './conversation-crud.ipc'
import type { BranchTakeoverResult } from './conversation-crud.ipc'
import { readBranchChoice, blueprintTrackBranch } from '../services/blueprint-track'
import { readBlueprintBranchName, readJiraIssueKey } from '../../shared/blueprint-branch-name'
import {
  resolveHandoffIntent,
  isBlueprintHandoffIntent,
  isBlueprintBranchMode
} from '../../shared/blueprint-handoff'
import type { BlueprintBranchMode, BlueprintHandoffOptions } from '../../shared/blueprint-handoff'
import { composeHandoffMessage } from '../services/blueprint-handoff-message'
import type { BlueprintWithDetails } from '../../shared/blueprint-types'
import electronLog from 'electron-log'

const log = electronLog.scope('blueprint-handoff')

// ── Result ───────────────────────────────────────────────────────────

export interface BlueprintHandoffResult {
  conversationId: string
  title: string
  /** The branch the chat works on, or null when it works in the workspace checkout. */
  branchName: string | null
  /** True only when a working tree actually changed hands. */
  inheritedTrack: boolean
  /** Composed first message — staged in the composer, never auto-sent. */
  stagedMessage: string
}

// ── Branch resolution ────────────────────────────────────────────────

/**
 * The branch a blueprint works on, independent of who currently owns it.
 *
 * Ownership is the wrong question after the first handoff: `transferOwner`
 * reassigns the track row to the chat, so `findByOwner('blueprint', id)` goes
 * empty and a second handoff would conclude the blueprint never had a branch —
 * then drop the user in the workspace checkout and tell them the output is
 * there. It is not; it is on the branch the first chat now holds.
 *
 * Mirrors the naming in `ensureBlueprintTrack` so the two agree on what a given
 * blueprint's branch is called.
 */
export function blueprintBranchCandidate(blueprint: BlueprintWithDetails): string {
  const choice = readBranchChoice(blueprint.settingsJson ?? {})
  if (choice.mode === 'takeover' && choice.branch) return choice.branch
  // The name reserved when the run started, if it got that far — recomputing it
  // from a title Specify has since rewritten would name a branch nobody has.
  const reserved = readBlueprintBranchName(blueprint.settingsJson)
  if (reserved) return reserved
  if (choice.mode === 'fork' && choice.name) return choice.name
  return blueprintTrackBranch(blueprint.id, blueprint.title)
}

function loadBlueprintForWorkspace(workspaceId: string, blueprintId: string): BlueprintWithDetails {
  const blueprint = blueprintService.getBlueprintWithDetails(blueprintId)
  if (!blueprint) throw new Error(`Blueprint '${blueprintId}' not found`)
  if (blueprint.workspaceId !== workspaceId) {
    throw new Error(`Blueprint '${blueprintId}' does not belong to workspace '${workspaceId}'`)
  }
  return blueprint
}

/**
 * What the UI needs to offer a truthful choice, resolved before anything exists.
 *
 * A branch is only reported when a track row evidences it. Naming a branch we
 * cannot prove exists would make `handleCreateConversation` create the ref, and
 * a stray empty branch is worse than working in the checkout.
 */
export function getHandoffOptions(
  workspaceId: string,
  blueprintId: string
): BlueprintHandoffOptions {
  const blueprint = loadBlueprintForWorkspace(workspaceId, blueprintId)

  const priorHandoffs = handoffRepository
    .getBySourceSession(blueprintId)
    .filter((r) => r.target === 'chat' && r.targetSessionId)
    .map((r) => ({
      conversationId: r.targetSessionId as string,
      intent: r.intent,
      createdAt: r.createdAt
    }))

  const candidate = blueprintBranchCandidate(blueprint)
  const track =
    trackRepository.findByOwner('blueprint', blueprintId) ??
    trackRepository.findByBranch(workspaceId, candidate)

  if (!track) {
    return { branchName: null, holder: null, busyReason: null, priorHandoffs }
  }

  const heldByBlueprint = track.ownerKind === 'blueprint' && track.ownerId === blueprintId
  const holderConversation =
    track.ownerKind === 'chat' && track.ownerId
      ? conversationRepository.findById(track.ownerId)
      : null

  return {
    branchName: track.branchName,
    holder: heldByBlueprint
      ? null
      : {
          kind: track.ownerKind,
          ownerId: track.ownerId,
          label: holderConversation?.title ?? track.ownerId,
          conversationId: holderConversation?.id ?? null
        },
    busyReason: trackService.busyReasonFor(track),
    priorHandoffs
  }
}

// ── Execution ────────────────────────────────────────────────────────

/**
 * Exported for tests — the IPC handler is a thin validation wrapper over this.
 */
export async function executeBlueprintHandoffToChat(args: {
  workspaceId: string
  blueprintId: string
  intent?: string
  /** Defaults to taking the branch — the common case, and what the card offers. */
  branchMode?: BlueprintBranchMode
}): Promise<BlueprintHandoffResult> {
  const { workspaceId, blueprintId } = args
  const branchMode: BlueprintBranchMode = args.branchMode ?? 'take'

  const blueprint = loadBlueprintForWorkspace(workspaceId, blueprintId)
  const spec = resolveHandoffIntent(args.intent)

  const envelope = blueprintAdapter.toEnvelope(
    { blueprint, intentSpec: spec },
    {
      workspaceId,
      target: 'chat',
      sourceSessionId: blueprintId,
      createdBy: 'user'
    }
  )

  const { record, action } = handoffService.executeHandoff(envelope)
  if (action.type !== 'chat') {
    throw new Error(`Expected a chat target action, got '${action.type}'`)
  }

  const options = getHandoffOptions(workspaceId, blueprintId)
  const branchName = branchMode === 'take' ? options.branchName : null

  const title = `${spec.titlePrefix}: ${blueprint.title}`.slice(0, 500)

  const jiraIssueKey = readJiraIssueKey(blueprint.settingsJson)

  // Derived from what the transfer actually did, never inferred from the branch
  // name surviving: a track row that outlived its directory reuses the ref and
  // builds a fresh tree, which is emphatically not "the files are already here".
  let takeover: BranchTakeoverResult | null = null

  let conversation: Awaited<ReturnType<typeof handleCreateConversation>>
  try {
    conversation = await handleCreateConversation({
      workspaceId,
      title,
      mode: spec.mode,
      // A chat that exists because of a ticket should be able to answer to it.
      // Safe unconditionally: the executor ANDs this with the workspace toggle
      // and skips the mount when credentials are incomplete. Gated on the key
      // only so non-Jira blueprints do not carry the tool schemas.
      mcpOverrides: jiraIssueKey ? { jira: true } : undefined,
      branchName: branchName ?? undefined,
      // No branch means the chat belongs in the workspace checkout, which is
      // where a blueprint without a track left its output.
      autoBranch: branchName ? undefined : false,
      takeover: branchName ? true : undefined,
      onTakeover: (outcome) => {
        takeover = outcome
      }
    })
  } catch (err) {
    // A busy holder reaches the user as an error, and the half-made conversation
    // was already rolled back. The handoff record must not be left pending.
    handoffService.reject(record.id, (err as Error).message)
    throw err
  }

  const inheritedTrack = (takeover as BranchTakeoverResult | null)?.kind === 'transferred'

  const stagedMessage = composeHandoffMessage({
    contextMarkdown: action.contextMarkdown,
    spec,
    branchName: conversation.branchName ?? null,
    inheritedTrack,
    unclaimedBranch: conversation.branchName ? null : options.branchName,
    jiraIssueKey
  })

  conversationRepository.updateHandoffContext(conversation.id, action.handoffContextCompact)
  handoffService.accept(record.id, conversation.id)

  log.info(
    `[blueprint:handoff] ${blueprintId} → chat ${conversation.id} ` +
      `(intent=${spec.id}, mode=${branchMode}, branch=${conversation.branchName ?? '—'}, ` +
      `inherited=${inheritedTrack})`
  )

  return {
    conversationId: conversation.id,
    title: conversation.title ?? title,
    branchName: conversation.branchName ?? null,
    inheritedTrack,
    stagedMessage
  }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerBlueprintHandoffIpc(): void {
  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_HANDOFF_OPTIONS, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_HANDOFF_OPTIONS
    const args = requireObject(rawArgs, ch)

    return getHandoffOptions(
      requireString(args, 'workspaceId', ch),
      requireString(args, 'blueprintId', ch)
    )
  })

  ipcMain.handle(IPC_CHANNELS.BLUEPRINT_HANDOFF_TO_CHAT, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.BLUEPRINT_HANDOFF_TO_CHAT
    const args = requireObject(rawArgs, ch)

    // Reject an unrecognised intent rather than quietly defaulting to
    // 'continue': the user clicked a specific button, and shipping them a
    // read-only planning chat when they asked to push a PR is the kind of
    // wrong that looks like it worked.
    const intent = optionalString(args, 'intent', ch)
    if (intent !== undefined && !isBlueprintHandoffIntent(intent)) {
      throw new Error(`${ch}: unknown handoff intent '${intent}'`)
    }

    const branchMode = optionalString(args, 'branchMode', ch)
    if (branchMode !== undefined && !isBlueprintBranchMode(branchMode)) {
      throw new Error(`${ch}: unknown branch mode '${branchMode}'`)
    }

    return executeBlueprintHandoffToChat({
      workspaceId: requireString(args, 'workspaceId', ch),
      blueprintId: requireString(args, 'blueprintId', ch),
      intent,
      branchMode
    })
  })

  log.info('Registered blueprint handoff IPC handlers')
}
