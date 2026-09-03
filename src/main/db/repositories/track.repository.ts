import { BaseRepository } from '../base-repository'
import type {
  WorkTrack,
  TrackOwnerKind,
  TrackStatus,
  TrackLandingMode,
  TrackBaseSource
} from '../../../shared/track-types'

interface TrackRow {
  id: string
  workspace_id: string
  owner_kind: string
  /** Null once the track is retained — the work outlived its owner. */
  owner_id: string | null
  branch_name: string
  path: string
  base_branch: string
  base_source: string | null
  base_commit: string | null
  status: string
  landing_mode: string | null
  landed_at: string | null
  landed_into: string | null
  created_at: string
  last_used_at: string | null
}

function toModel(row: TrackRow): WorkTrack {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    ownerKind: row.owner_kind as TrackOwnerKind,
    ownerId: row.owner_id,
    branchName: row.branch_name,
    path: row.path,
    baseBranch: row.base_branch,
    baseSource: row.base_source as TrackBaseSource | null,
    baseCommit: row.base_commit,
    status: row.status as TrackStatus,
    landingMode: row.landing_mode as TrackLandingMode | null,
    landedAt: row.landed_at,
    landedInto: row.landed_into,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  }
}

export interface CreateTrackInput {
  workspaceId: string
  ownerKind: TrackOwnerKind
  ownerId: string
  branchName: string
  path: string
  baseBranch: string
  /** Which rule supplied `baseBranch`. Omitted by callers that do not resolve one. */
  baseSource?: TrackBaseSource
  /** Commit `baseBranch` pointed at. Omitted when the caller cannot vouch for it. */
  baseCommit?: string
  landingMode?: TrackLandingMode
}

/**
 * Bookkeeping for work tracks — one branch + one git worktree + one owner.
 *
 * This table is a *record* of what should exist on disk, never the source of
 * truth for what does. Git owns the filesystem; a row can outlive its directory
 * (crash between `git worktree remove` and the row delete, or a user deleting
 * the folder by hand). Callers that need certainty must stat the path — see
 * TrackService.
 */
export class TrackRepository extends BaseRepository<TrackRow, WorkTrack> {
  protected readonly tableName = 'work_tracks'
  protected mapRow(row: TrackRow): WorkTrack {
    return toModel(row)
  }

  /**
   * Insert a track record.
   *
   * Throws on UNIQUE violation — either the owner already has a track, or the
   * branch is already checked out elsewhere in this workspace. Both are real
   * conflicts the caller must surface rather than paper over, because git would
   * reject the corresponding `worktree add` for the same reason.
   */
  create(input: CreateTrackInput): WorkTrack {
    const row = this.db()
      .prepare(
        `INSERT INTO work_tracks
           (workspace_id, owner_kind, owner_id, branch_name, path, base_branch, base_source,
            base_commit, status, landing_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
         RETURNING *`
      )
      .get(
        input.workspaceId,
        input.ownerKind,
        input.ownerId,
        input.branchName,
        input.path,
        input.baseBranch,
        input.baseSource ?? null,
        input.baseCommit ?? null,
        input.landingMode ?? null
      ) as TrackRow
    return toModel(row)
  }

  findByOwner(ownerKind: TrackOwnerKind, ownerId: string): WorkTrack | undefined {
    const row = this.db()
      .prepare('SELECT * FROM work_tracks WHERE owner_kind = ? AND owner_id = ?')
      .get(ownerKind, ownerId) as TrackRow | undefined
    return row ? toModel(row) : undefined
  }

  findByWorkspace(workspaceId: string): WorkTrack[] {
    return this.findManyBy('workspace_id', workspaceId, { orderBy: 'created_at ASC' })
  }

  /** Find the track holding a branch, if any. Mirrors git's repo-wide rule. */
  findByBranch(workspaceId: string, branchName: string): WorkTrack | undefined {
    const row = this.db()
      .prepare('SELECT * FROM work_tracks WHERE workspace_id = ? AND branch_name = ?')
      .get(workspaceId, branchName) as TrackRow | undefined
    return row ? toModel(row) : undefined
  }

  /** Every row across all workspaces — the boot-time reaper's input. */
  findAll(): WorkTrack[] {
    const rows = this.db()
      .prepare('SELECT * FROM work_tracks ORDER BY created_at ASC')
      .all() as TrackRow[]
    return rows.map(toModel)
  }

  /**
   * Mark a track as being torn down.
   *
   * Written *before* `git worktree remove` so a crash mid-removal leaves an
   * unambiguous tombstone: `removing` means "nobody should route work here,
   * and the reaper should finish the job".
   */
  markRemoving(id: string): void {
    this.db().prepare("UPDATE work_tracks SET status = 'removing' WHERE id = ?").run(id)
  }

  /**
   * Park a track that still holds uncommitted work.
   *
   * The owner link is dropped in the same statement, and that is not
   * incidental: every caller of `release()` deletes the owning row immediately
   * afterwards, and (owner_kind, owner_id) is UNIQUE. Leaving it set would
   * collide when the same owner is rebuilt by `ensureTrack()`. Retained work
   * belongs to the user, not to whatever produced it.
   */
  markRetained(id: string): void {
    this.db()
      .prepare("UPDATE work_tracks SET status = 'retained', owner_id = NULL WHERE id = ?")
      .run(id)
  }

  /**
   * Hand a retained track to a new owner and put it back in service.
   *
   * The counterpart to `markRetained`: parked work is picked up by a fresh chat
   * rather than being copied or re-cloned, so the uncommitted changes on disk
   * are the ones the new owner sees.
   */
  adoptOwner(id: string, ownerKind: TrackOwnerKind, ownerId: string): void {
    this.db()
      .prepare(
        "UPDATE work_tracks SET owner_kind = ?, owner_id = ?, status = 'active' WHERE id = ?"
      )
      .run(ownerKind, ownerId, id)
  }

  /**
   * Record a successful landing.
   *
   * `landed_at` / `landed_into` existed from migration 141 and were written by
   * nothing, so "has this work reached the mainline?" had no answer and dead
   * branches accumulated with no way to tell them from live ones. This is what
   * writes them, and what branch GC reads.
   */
  markLanded(id: string, landedInto: string): void {
    this.db()
      .prepare(
        "UPDATE work_tracks SET landed_at = datetime('now'), landed_into = ?, status = 'active' WHERE id = ?"
      )
      .run(landedInto, id)
  }

  /**
   * Park a track whose merge hit a real conflict.
   *
   * The owner link is deliberately KEPT, unlike `markRetained`: a conflicted
   * landing is a retryable state for work that still belongs to its owner, not
   * abandoned work looking for an adopter.
   */
  markConflicted(id: string): void {
    this.db().prepare("UPDATE work_tracks SET status = 'conflicted' WHERE id = ?").run(id)
  }

  /** Put a conflicted track back in service once the user has dealt with it. */
  markActive(id: string): void {
    this.db().prepare("UPDATE work_tracks SET status = 'active' WHERE id = ?").run(id)
  }

  /** Tracks whose work has already reached the mainline — branch GC's input. */
  findLanded(workspaceId: string): WorkTrack[] {
    const rows = this.db()
      .prepare(
        'SELECT * FROM work_tracks WHERE workspace_id = ? AND landed_at IS NOT NULL ORDER BY landed_at ASC'
      )
      .all(workspaceId) as TrackRow[]
    return rows.map(toModel)
  }

  /** Record use, so idle tracks can be reaped without touching busy ones. */
  touch(id: string): void {
    this.db().prepare("UPDATE work_tracks SET last_used_at = datetime('now') WHERE id = ?").run(id)
  }

  /**
   * Delete by owner.
   *
   * Callers holding a row should prefer the inherited `deleteById`: retained
   * rows have no owner id, and passing null here would match every detached row
   * of that kind at once.
   */
  deleteByOwner(ownerKind: TrackOwnerKind, ownerId: string): number {
    return this.db()
      .prepare('DELETE FROM work_tracks WHERE owner_kind = ? AND owner_id = ?')
      .run(ownerKind, ownerId).changes
  }
}

export const trackRepository = new TrackRepository()
