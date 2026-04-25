import { MANNEQUIN_ROTATION, type AvatarKey } from '@renderer/assets/avatars'
import type { Workspace } from '../../../shared/types'

/**
 * Assigns a mannequin avatar key to a workspace based on its position in
 * the user's workspaces list (sorted ASC by createdAt). First workspace gets
 * 'mannequin-main', second gets 'mannequin-2', …, sixth loops back to
 * 'mannequin-main'. Deterministic and stable for a given workspace set.
 */
export function getWorkspaceMannequin(workspaceId: string, workspaces: Workspace[]): AvatarKey {
  if (workspaces.length === 0) return MANNEQUIN_ROTATION[0]
  const sorted = [...workspaces].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const idx = sorted.findIndex((w) => w.id === workspaceId)
  if (idx < 0) return MANNEQUIN_ROTATION[0]
  return MANNEQUIN_ROTATION[idx % MANNEQUIN_ROTATION.length]
}
