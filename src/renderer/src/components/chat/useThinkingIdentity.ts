import { useMemo } from 'react'
import { useChatStore, useSpecialistStore, useWorkspaceStore } from '@renderer/store'
import { CORE_AGENT_DEFAULTS } from '@renderer/utils/agentIdentity'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'
import { getWorkspaceMannequin } from '@renderer/utils/workspaceMannequin'

interface ThinkingIdentity {
  name: string
  avatarKey: string
  accentColor: string
}

/**
 * Resolves the current streaming identity for the thinking indicator.
 * Checks (in order): explicit streaming specialist → specialist by ID →
 * project specialist → default specialist fallback.
 */
export function useThinkingIdentity(): ThinkingIdentity {
  const streamingRole = useChatStore((s) => s.streamingRole)
  const streamingSpecialist = useChatStore((s) => s.streamingSpecialist)

  const defaultSpec = useSpecialistStore(
    (s) => s.specialists.find((sp) => sp.agentId === 'specialist') ?? null
  )
  const defaultAlias =
    defaultSpec?.alias ??
    defaultSpec?.displayName ??
    CORE_AGENT_DEFAULTS['specialist'].displayName
  const thinkingAvatarKey = CORE_AGENT_DEFAULTS['specialist'].avatarKey
  const thinkingAccentColor = defaultSpec?.color ?? CORE_AGENT_DEFAULTS['specialist'].color

  const streamingSpecialistData = useSpecialistStore((s) =>
    streamingSpecialist
      ? (s.specialists.find((sp) => sp.agentId === streamingSpecialist) ?? null)
      : null
  )

  const activeConversationWorkspaceId = useChatStore(
    (s) => s.activeConversation?.workspaceId ?? null
  )
  const workspaces = useWorkspaceStore((s) => s.workspaces)

  const projectSpecialist = useProjectSpecialistStore((s) =>
    activeConversationWorkspaceId ? s.byWorkspace[activeConversationWorkspaceId] : null
  )
  const specialistMannequinKey = useMemo(
    () =>
      activeConversationWorkspaceId
        ? getWorkspaceMannequin(activeConversationWorkspaceId, workspaces)
        : 'mannequin-main',
    [activeConversationWorkspaceId, workspaces]
  )

  return useMemo(() => {
    if (streamingRole === 'specialist' && streamingSpecialistData) {
      return {
        name: streamingSpecialistData.alias ?? streamingSpecialistData.displayName,
        avatarKey: specialistMannequinKey,
        accentColor: streamingSpecialistData.color ?? '#F59E0B'
      }
    }
    if (streamingRole === 'specialist' && streamingSpecialist) {
      return {
        name: streamingSpecialist,
        avatarKey: specialistMannequinKey,
        accentColor: '#F59E0B'
      }
    }
    if (projectSpecialist?.buildStatus === 'ready') {
      return {
        name: projectSpecialist.displayName,
        avatarKey: specialistMannequinKey,
        accentColor: projectSpecialist.color ?? '#F59E0B'
      }
    }
    return {
      name: defaultAlias,
      avatarKey: thinkingAvatarKey,
      accentColor: thinkingAccentColor
    }
  }, [
    streamingRole,
    streamingSpecialistData,
    streamingSpecialist,
    specialistMannequinKey,
    defaultAlias,
    thinkingAvatarKey,
    thinkingAccentColor,
    projectSpecialist
  ])
}
