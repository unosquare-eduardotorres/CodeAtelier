/**
 * The snapshot-merge rule behind memory.store's `loadBootstrapSnapshot`.
 *
 * `bootstrap` lives in a module-level store that survives navigation, and the
 * snapshot is not its only writer — live progress events write it too. So the
 * snapshot has to be able to *clear* it: without that, a finished run stays
 * pinned open, and switching to a workspace with no run leaves the previous
 * workspace's progress (and its runId, which drives the item list) on screen.
 *
 * Snapshots also arrive for background workspaces, which must never repaint the
 * page the user is actually looking at.
 *
 * Extracted from the store so it can be tested without a renderer.
 */

import type { BootstrapProgress, BootstrapRunSummary } from '../../../shared/types'

export interface BootstrapSnapshot {
  progress: BootstrapProgress | null
  latestRun: BootstrapRunSummary | null
  resumableRunId: string | null
}

export interface BootstrapSnapshotPatch {
  bootstrap: BootstrapProgress | null
  bootstrapLatestRun: BootstrapRunSummary | null
  bootstrapResumableRunId: string | null
}

/**
 * Page-level state for a snapshot, or null when the snapshot belongs to a
 * workspace other than the one on screen.
 */
export function bootstrapSnapshotPatch(
  snap: BootstrapSnapshot,
  workspaceId: string,
  viewedWorkspaceId: string | null
): BootstrapSnapshotPatch | null {
  if (workspaceId !== viewedWorkspaceId) return null
  return {
    bootstrap: snap.progress ?? null,
    bootstrapLatestRun: snap.latestRun,
    bootstrapResumableRunId: snap.resumableRunId
  }
}
