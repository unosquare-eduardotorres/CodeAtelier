/**
 * useMessageIdentity — resolves display identity (name, subtitle, avatar, color)
 * for a message based on role, agentId, and workspace specialist state.
 *
 * Extracted from MessageBubble to reduce component complexity. The resolution
 * rules themselves live in `resolveMessageIdentity` (pure, unit-tested); this
 * hook only supplies them with store state.
 */

import { useMemo } from 'react'
import type { Message } from '../../../../shared/types'
import { useSpecialistStore, useChatStore, useWorkspaceStore } from '@renderer/store'
import { getWorkspaceMannequin } from '@renderer/utils/workspaceMannequin'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'
import { resolveMessageIdentity } from './resolveMessageIdentity'
import type { MessageIdentity } from './resolveMessageIdentity'

export type { MessageIdentity }

export function useMessageIdentity(message: Message): MessageIdentity {
  const specialists = useSpecialistStore((s) => s.specialists)
  const activeConversation = useChatStore((s) => s.activeConversation)
  const workspaces = useWorkspaceStore((s) => s.workspaces)

  // Resolve the workspace's project specialist (if any) for identity override
  const workspaceId = activeConversation?.workspaceId
  const projectSpecialist = useProjectSpecialistStore((s) =>
    workspaceId ? s.byWorkspace[workspaceId] : null
  )

  // Destructured so a fresh `message` object identity per render does not
  // re-run the resolution — only the two fields it reads matter.
  const { role, agentId } = message

  return useMemo(
    () =>
      resolveMessageIdentity({
        message: { role, agentId },
        specialists,
        workspaces,
        workspaceId,
        projectSpecialist: projectSpecialist ?? null,
        mannequinKey: workspaceId
          ? getWorkspaceMannequin(workspaceId, workspaces)
          : 'mannequin-main'
      }),
    [role, agentId, specialists, workspaces, workspaceId, projectSpecialist]
  )
}
