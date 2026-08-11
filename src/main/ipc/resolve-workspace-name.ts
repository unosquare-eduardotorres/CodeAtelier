/**
 * Shared utility for resolving a workspace name from its ID.
 *
 * Imports the workspace repository module directly (not the `db/repositories`
 * barrel) to keep the import surface minimal. This used to be a lazy
 * `require('../db/repositories')`, which resolved to a non-existent
 * `out/db/repositories` in packaged builds — the require threw
 * MODULE_NOT_FOUND into a silent catch, so *every* notification fell back to
 * the 8-hex ID prefix in production while working fine in dev.
 *
 * Falls back to the first 8 characters of the workspace ID.
 */

import { workspaceRepository } from '../db/repositories/workspace.repository'
import { mainLogger } from '../logger'

export function resolveWorkspaceName(workspaceId: string): string {
  try {
    const ws = workspaceRepository.findById(workspaceId)
    return ws?.name ?? workspaceId.slice(0, 8)
  } catch (error) {
    // Never silent — a swallowed failure here is invisible in logs and
    // degrades every notification title.
    mainLogger.warn(`[resolveWorkspaceName] Lookup failed for ${workspaceId}:`, error)
    return workspaceId.slice(0, 8)
  }
}
