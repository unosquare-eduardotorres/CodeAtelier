/**
 * Track types — a track is one unit of parallel work.
 *
 * One branch, one git worktree, one owner. The owner is a chat, a blueprint
 * run, an MPA campaign, or nobody at all once the work is retained.
 *
 * Background: every chat, blueprint and background task in a workspace used to
 * run its CLI with the same `cwd` (the workspace root). That directory has
 * exactly one HEAD, but `MAX_CONCURRENT_STREAMS = 3` allows three agents to
 * write into it at once, and `conversations.branch_name` recorded a branch per
 * chat that nothing enforced on disk. The result was silent cross-contamination:
 * work started on one branch could be committed to another.
 *
 * A track gives its owner its own directory and its own HEAD, so "chat A is on
 * feat-a" becomes a filesystem fact rather than a database note.
 *
 * Git constraints that shape these types:
 *  - A branch can be checked out in at most ONE worktree at a time (repo-wide).
 *    Hence the (workspaceId, branchName) uniqueness, not just per-owner.
 *  - The primary working tree cannot be removed, only added ones. Owners with
 *    no branch keep running in the primary tree — see `isolated`.
 */

/**
 * What kind of thing owns a track.
 *
 * Deliberately not a foreign key. `chat` owners are conversation rows, but
 * `blueprint` and `campaign` owners are synthetic run ids that exist only in
 * memory and in log lines, and `manual` tracks have no owner row at all. The
 * previous schema keyed this table to `conversations(id)`, which made every
 * non-chat writer unrepresentable — and those are exactly the writers that
 * were scribbling on the user's own checkout.
 */
export type TrackOwnerKind = 'chat' | 'blueprint' | 'campaign' | 'manual'

/**
 * How a track's work gets back to the mainline.
 *
 * `independent` — the track lands as its own branch/PR. This is the default and
 * matches what `/complete` already does.
 * `integration` — the track merges into a shared cumulative branch held by a
 * dedicated integration worktree, so landing never disturbs the user's checkout.
 *
 * Null on a track means "inherit the workspace default".
 */
export type TrackLandingMode = 'independent' | 'integration'

/**
 * Lifecycle of a track row.
 *
 * `removing` exists because deletion is two-step (git worktree remove, then row
 * delete) and the process can die between them. A row stuck in `removing` is a
 * reaper target, whereas an `active` row with a missing directory is a
 * different failure (user deleted it manually) that needs recreation.
 *
 * `conflicted` is landing's version of `retained`: a merge hit a real conflict,
 * so BOTH branches are preserved exactly as they were, nothing was
 * auto-resolved, and the user's primary checkout was never involved. Like
 * `retained`, it is a visible state rather than a silent failure — and unlike a
 * half-finished merge, there is nothing to clean up before retrying.
 *
 * `retained` is the "never lose work" state. Teardown used to run
 * `git worktree remove --force`, which discards uncommitted changes. That is
 * fine after `/complete` (the commit already happened) but on chat close or
 * chat delete it silently destroyed whatever the agent produced and never
 * committed. A dirty tree now becomes `retained` instead: the directory and its
 * branch stay on disk, nothing routes work to it, and only an explicit discard
 * removes it. Retained rows are deliberately detached from their owner
 * (`ownerId === null`) so they survive the owner's deletion.
 */
export type TrackStatus = 'active' | 'removing' | 'retained' | 'conflicted'

/**
 * What a landing attempt did.
 *
 * `conflicted` is not an error: the merge was refused, both branches survive
 * untouched, and the user decides. `nothing-to-land` covers the case where the
 * track has no commits its base does not already have — landing it would create
 * an empty PR.
 */
export type LandingOutcome = 'landed' | 'conflicted' | 'nothing-to-land'

/** The result of landing one track. */
export interface LandingResult {
  outcome: LandingOutcome
  /** Branch that was landed. */
  branch: string
  /** Where it went — the integration branch, or the PR's base. Null when nothing landed. */
  landedInto: string | null
  /** HEAD of the track after committing, when a commit happened. */
  commitHash?: string
  /** Set when a PR was opened (independent mode with GitHub configured). */
  prUrl?: string
  prNumber?: number
  /** Files git reported as conflicting. Only set for `conflicted`. */
  conflictedFiles?: string[]
}

/** One unit of parallel work: a branch, a worktree and an owner. */
export interface WorkTrack {
  id: string
  workspaceId: string
  ownerKind: TrackOwnerKind
  /**
   * Owning chat / blueprint run / campaign. One track per owner, enforced
   * UNIQUE(owner_kind, owner_id). Null once the track is `retained`: the work
   * outlived whatever produced it.
   */
  ownerId: string | null
  /** Branch checked out in this track's worktree. Unique within the workspace. */
  branchName: string
  /** Absolute path to the worktree directory. */
  path: string
  /** Branch this track was forked from, needed to compute the merge base. */
  baseBranch: string
  status: TrackStatus
  /** Per-track override; null means "inherit the workspace default". */
  landingMode: TrackLandingMode | null
  /** When this track was merged into its target, if it has been. */
  landedAt: string | null
  /** Branch this track was merged into. */
  landedInto: string | null
  createdAt: string
  /** Touched on every turn; drives idle reaping. Null until first use. */
  lastUsedAt: string | null
}

/** Identifies a track by its owner rather than its row id. */
export interface TrackOwner {
  ownerKind: TrackOwnerKind
  ownerId: string
}

/**
 * What teardown actually did.
 *
 * `retained` is not a failure — it is the safety rule working. Callers that
 * delete branches or owner rows afterwards must check for it, because a
 * retained track still holds its branch checked out.
 */
export type ReleaseOutcome = 'absent' | 'removed' | 'retained'

/**
 * Where an owner's work actually happens.
 *
 * This is the contract every execution path resolves before spawning a CLI or
 * running a git command. Returning the primary tree is a valid, expected
 * outcome — not a fallback error — because owners without a branch have
 * nothing to isolate.
 */
export interface ExecutionTarget {
  /** Absolute cwd for the agent CLI and all git operations for this owner. */
  path: string
  /** Branch checked out at `path`, or null when the primary tree's HEAD is unknown. */
  branchName: string | null
  /** True when `path` is a dedicated worktree; false when it is the primary tree. */
  isolated: boolean
}

/**
 * A track as the Tracks list renders it.
 *
 * `dirty` and `diskBytes` are filesystem facts, recomputed on every list call —
 * the row records intent, git owns the truth — so they are separate from
 * `WorkTrack` rather than columns on it.
 */
export interface TrackSummary extends WorkTrack {
  /** False when the directory is gone: the row outlived its tree. */
  exists: boolean
  /** Uncommitted changes that a forced delete would destroy. */
  dirty: boolean
  /** Size on disk in bytes, excluding the node_modules symlink. */
  diskBytes: number
  /** Owner's display name when it can still be resolved (chat title, etc.). */
  ownerLabel: string | null
  /**
   * Files another live track is also editing.
   *
   * Prediction, never a block: it turns a merge-time surprise into something
   * visible while both tracks are still running and one of them can be steered.
   * Empty when nothing collides, or when claim data has not been recorded yet.
   */
  conflicts: PredictedTrackConflict[]
}

/** One file this track shares with at least one other live track. */
export interface PredictedTrackConflict {
  filePath: string
  /** The other tracks touching it — named, because a count is not actionable. */
  others: Array<{ trackId: string; branchName: string }>
}

/**
 * Payload behind the Tracks list.
 *
 * The budget travels with the data because the warning is advisory: the tracks
 * pushing a workspace over the line are usually the dirty ones the reaper is
 * forbidden to touch, so the only honest response is to tell the user and let
 * them choose.
 */
export interface TrackListResult {
  tracks: TrackSummary[]
  /** Sum of `diskBytes` across the workspace's tracks. */
  totalBytes: number
  /** Threshold above which the UI warns. Never enforced automatically. */
  budgetBytes: number
}
