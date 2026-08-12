/**
 * A chat whose branch is currently held by somebody else.
 *
 * A blueprint can take a chat's branch over (`trackService.transferOwner`), and
 * the chat keeps its `branch_name` throughout — that is precisely what makes
 * handing it back possible later. So "lent" is a derived fact, not stored
 * state: a chat has lent its branch away exactly when its `branch_name`
 * resolves to a track owned by somebody other than itself. No column, nothing
 * to keep in sync, and it self-heals the moment ownership comes back.
 *
 * These two functions are the whole decision, deliberately separated from the
 * database read that feeds them: the read lives in ChatStreamService, which is
 * a circular-import participant and effectively undrivable in a unit test. The
 * rules below are the part that can be got wrong — whether a retained track
 * counts as lent, whether a plan turn may proceed, which holder gets a
 * `blockedBy:` tag — so they live where a test can reach them directly.
 */

import type { ConversationMode } from '../../shared/types'
import type { TrackOwnerKind } from '../../shared/track-types'

/** Who is holding a chat's branch, and how to describe them to the user. */
export interface LentBranchHolder {
  branchName: string
  ownerKind: TrackOwnerKind
  ownerId: string
  /** Human-facing subject of the refusal sentence. */
  label: string
}

/** The fields of a `work_tracks` row this decision reads. */
export interface HeldTrackRow {
  ownerKind: TrackOwnerKind
  ownerId: string | null
}

/**
 * How each kind of holder is named in the refusal.
 *
 * Exhaustive over `TrackOwnerKind` on purpose. This started as
 * `kind === 'blueprint' ? 'A blueprint' : 'Another chat'`, which told a user
 * whose branch an MPA campaign had taken to go looking for a chat that was
 * never involved.
 */
const HOLDER_LABELS: Record<TrackOwnerKind, string> = {
  chat: 'Another chat',
  blueprint: 'A blueprint',
  campaign: 'A campaign',
  manual: 'Other work'
}

/**
 * Is this chat's branch held by other work?
 *
 * Returns null — meaning "not lent" — in three distinct cases that are worth
 * keeping straight:
 *
 * - the chat has no branch at all, so there is nothing to lend;
 * - no track holds the branch;
 * - the track holds it with no owner, which is a *retained* track. Retention
 *   means the work outlived whatever produced it and nobody is writing to that
 *   tree. Treating it as lent would permanently wedge every chat whose branch
 *   was ever retained, which is the common case after a chat is closed.
 *
 * And the identity case: a track owned by this very chat is the normal state,
 * not a loan.
 */
export function resolveLentHolder(
  conv: { id: string; branchName?: string | null },
  held: HeldTrackRow | null | undefined
): LentBranchHolder | null {
  if (!conv.branchName) return null
  if (!held?.ownerId) return null
  if (held.ownerKind === 'chat' && held.ownerId === conv.id) return null

  return {
    branchName: conv.branchName,
    ownerKind: held.ownerKind,
    ownerId: held.ownerId,
    label: HOLDER_LABELS[held.ownerKind] ?? 'Other work'
  }
}

/**
 * Why this turn cannot run, or null to let it through.
 *
 * Only *write* turns are refused. A plan turn reads the repository and writes
 * nothing, so it can carry on in the shared checkout while the branch is away —
 * refusing it too would mean lending a branch to a blueprint silently disables
 * the chat entirely, including the conversation the user would have while they
 * wait. `mode` is optional on a conversation row and older rows predate it;
 * absent means `plan`, matching the rest of the pipeline.
 *
 * Only a chat holder gets the `blockedBy:` tag. The renderer resolves that id
 * to a conversation title, so tagging a blueprint id would send the user
 * hunting through their chat list for something that is not there.
 */
export function lentBranchRefusal(
  lent: LentBranchHolder | null,
  mode: ConversationMode | null | undefined
): string | null {
  if (!lent) return null
  if ((mode ?? 'plan') === 'plan') return null

  const tag = lent.ownerKind === 'chat' ? ` (blockedBy:${lent.ownerId})` : ''
  return (
    `${lent.label} is working on "${lent.branchName}" right now. A branch can only ` +
    `be checked out in one place, so this chat cannot write to it until it is ` +
    `handed back. Planning still works.${tag}`
  )
}
