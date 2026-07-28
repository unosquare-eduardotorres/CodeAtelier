/**
 * Shared utility for resolving a workspace name from its ID.
 *
 * Uses lazy require() to avoid circular dependency with db/repositories.
 * Falls back to the first 8 characters of the workspace ID.
 */

export function resolveWorkspaceName(workspaceId: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { workspaceRepository } = require('../db/repositories')
    const ws = workspaceRepository.findById(workspaceId)
    return ws?.name ?? workspaceId.slice(0, 8)
  } catch {
    return workspaceId.slice(0, 8)
  }
}
