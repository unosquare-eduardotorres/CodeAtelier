/**
 * Pure identity resolution for a chat message — the logic behind
 * `useMessageIdentity`, kept free of React and store imports so it can be tested
 * directly.
 *
 * Ordering matters: the workspace's Project Specialist wins over the core agent
 * defaults, and the raw agent id is never rendered.
 */

import type { Message, Specialist } from '../../../../shared/types'
import { CORE_AGENT_DEFAULTS, USER_AVATAR_KEY, humaniseAgentId } from '../../utils/agentIdentity'

export interface MessageIdentity {
  displayName: string
  subtitle: string | null
  avatarKey: string
  accentColor: string
}

/** The fields of the Project Specialist row that identity resolution reads. */
export interface IdentityProjectSpecialist {
  displayName: string
  color: string | null
  buildStatus: 'pending' | 'building' | 'ready' | 'failed'
}

export interface MessageIdentityInput {
  message: Pick<Message, 'role' | 'agentId'>
  /** Core agents ('user', 'specialist', …) plus any registered specialists. */
  specialists: Pick<Specialist, 'agentId' | 'displayName' | 'alias' | 'color'>[]
  /** Workspaces, used to name a workspace specialist when its row is unavailable. */
  workspaces: { id: string; name: string }[]
  workspaceId: string | undefined
  projectSpecialist: IdentityProjectSpecialist | null
  /** Avatar key for this workspace, resolved by the caller. */
  mannequinKey: string
}

export function resolveMessageIdentity({
  message,
  specialists,
  workspaces,
  workspaceId,
  projectSpecialist,
  mannequinKey
}: MessageIdentityInput): MessageIdentity {
  if (message.role === 'user') {
    const userSpec = specialists.find((s) => s.agentId === 'user')
    return {
      displayName: userSpec?.alias ?? userSpec?.displayName ?? 'You',
      subtitle: null,
      avatarKey: USER_AVATAR_KEY,
      accentColor: 'var(--color-primary, #6366F1)'
    }
  }

  // ── Specialist resolution ──
  // The workspace's specialist row carries a real name ("<Project> Specialist")
  // from the moment the workspace is created, well before its prompt is built.
  // Gating this on `ready` sent freshly-created projects down to the last-resort
  // branch below, which printed the raw `workspace-specialist-<id>` agent id.
  if (message.role === 'specialist' && projectSpecialist) {
    return {
      displayName: projectSpecialist.displayName,
      subtitle: projectSpecialist.buildStatus === 'ready' ? null : 'Not built yet',
      avatarKey: mannequinKey,
      accentColor: projectSpecialist.color ?? '#F59E0B'
    }
  }

  // Specialist without a workspace specialist row — use core agent defaults
  if (message.role === 'specialist' && !message.agentId) {
    const coreSpec = specialists.find((s) => s.agentId === 'specialist')
    const defaults = CORE_AGENT_DEFAULTS['specialist']
    return {
      displayName: coreSpec?.alias ?? coreSpec?.displayName ?? defaults.displayName,
      subtitle: coreSpec?.alias ? (coreSpec.displayName ?? defaults.displayName) : null,
      avatarKey: defaults.avatarKey,
      accentColor: coreSpec?.color ?? defaults.color
    }
  }

  // Specialist with agentId — resolve by agentId
  if (message.agentId) {
    const specialist = specialists.find((s) => s.agentId === message.agentId)
    if (specialist) {
      return {
        displayName: specialist.alias ?? specialist.displayName,
        subtitle: specialist.alias ? specialist.displayName : null,
        avatarKey: mannequinKey,
        accentColor: specialist.color ?? '#F59E0B'
      }
    }
  }

  // ── Last resort ──
  // Nothing matched. An agent id is an internal identifier, so it is never
  // rendered verbatim: a workspace specialist id resolves to the workspace name
  // it encodes, and anything else is humanised.
  if (message.agentId && workspaceId && message.agentId === `workspace-specialist-${workspaceId}`) {
    const workspaceName = workspaces.find((w) => w.id === workspaceId)?.name
    if (workspaceName) {
      return {
        displayName: `${workspaceName} Specialist`,
        subtitle: null,
        avatarKey: mannequinKey,
        accentColor: '#6366F1'
      }
    }
  }

  return {
    displayName: (message.agentId ? humaniseAgentId(message.agentId) : null) ?? message.role,
    subtitle: null,
    avatarKey: mannequinKey,
    accentColor: '#6366F1'
  }
}
