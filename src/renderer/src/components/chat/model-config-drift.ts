/**
 * Pure helpers for ModelConfigPopover.
 *
 * Kept out of the .tsx so they can be unit-tested without a renderer harness
 * (and so react-refresh's component-only-export rule stays satisfied).
 */

import type { ConversationModelSnapshot, ModelRoleMap } from '../../../../shared/types'

/** Snapshot row → the workspace ModelAction that feeds it (see resolveFromSnapshot). */
const ROW_ACTIONS = {
  plan: 'specialist:plan',
  build: 'specialist:build',
  background: 'haiku'
} as const satisfies Record<'plan' | 'build' | 'background', keyof ModelRoleMap>

export type SnapshotRow = keyof typeof ROW_ACTIONS

/**
 * Which snapshot rows have drifted from the workspace's live model roles.
 *
 * The snapshot is deliberately frozen at conversation creation (migration 111),
 * but `(default)` reads as "this is your current default" once Settings has moved
 * on. A row drifts only when the workspace has an EXPLICIT live assignment that
 * names a different model — an absent role means "no opinion", not a change.
 *
 * Returns the live model id per drifted row.
 */
export function resolveDrift(
  snapshot: ConversationModelSnapshot | null,
  liveRoles: ModelRoleMap
): Partial<Record<SnapshotRow, string>> {
  if (!snapshot) return {}
  const drift: Partial<Record<SnapshotRow, string>> = {}
  for (const row of Object.keys(ROW_ACTIONS) as SnapshotRow[]) {
    const live = liveRoles[ROW_ACTIONS[row]]?.modelId
    if (live && live !== snapshot[row].modelId) drift[row] = live
  }
  return drift
}

/** Compact window label for the popover footer — "1M" / "200K". */
export function formatContextWindow(size: number | undefined): string | null {
  if (!size || size <= 0) return null
  if (size >= 1_000_000) return `${Math.round(size / 1_000_000)}M`
  return `${Math.round(size / 1000)}K`
}
