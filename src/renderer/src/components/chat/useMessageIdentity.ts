/**
 * useMessageIdentity — resolves display identity (name, subtitle, avatar, color)
 * for a message based on role, agentId, and workspace specialist state.
 *
 * Extracted from MessageBubble to reduce component complexity.
 */

import { useMemo } from 'react'
import type { Message } from '../../../../shared/types'
import { useSpecialistStore, useChatStore, useWorkspaceStore } from '@renderer/store'
import { CORE_AGENT_DEFAULTS, USER_AVATAR_KEY } from '@renderer/utils/agentIdentity'
import { getWorkspaceMannequin } from '@renderer/utils/workspaceMannequin'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'

export interface MessageIdentity {
  displayName: string
  subtitle: string | null
  avatarKey: string
  accentColor: string
}

/**
 * Resolves the display identity (name, subtitle, avatar, color) for a message.
 *
 * Visual identity is driven by the message's role + agentId.
 * When the workspace has a ready specialist, all non-user messages show
 * the specialist's identity. Otherwise, falls back to the core agent defaults.
 */
export function useMessageIdentity(message: Message): MessageIdentity {
  const specialists = useSpecialistStore((s) => s.specialists)
  const activeConversation = useChatStore((s) => s.activeConversation)
  const workspaces = useWorkspaceStore((s) => s.workspaces)

  // Resolve the workspace's project specialist (if any) for identity override
  const workspaceId = activeConversation?.workspaceId
  const projectSpecialist = useProjectSpecialistStore((s) =>
    workspaceId ? s.byWorkspace[workspaceId] : null
  )

  return useMemo(() => {
    const mannequinKey = workspaceId
      ? getWorkspaceMannequin(workspaceId, workspaces)
      : 'mannequin-main'

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
    // When the workspace has a ready specialist, show its identity.
    if (message.role === 'specialist' && projectSpecialist?.buildStatus === 'ready') {
      return {
        displayName: projectSpecialist.displayName,
        subtitle: null,
        avatarKey: mannequinKey,
        accentColor: projectSpecialist.color ?? '#F59E0B'
      }
    }

    // Specialist without a ready specialist row — use core agent defaults
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

    // Unknown specialist — still show the workspace mannequin
    return {
      displayName: message.agentId ?? message.role,
      subtitle: null,
      avatarKey: mannequinKey,
      accentColor: '#6366F1'
    }
  }, [message.role, message.agentId, specialists, workspaces, workspaceId, projectSpecialist])
}
