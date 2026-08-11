import { BaseRepository } from '../base-repository'

interface ClaimRow {
  track_id: string
  file_path: string
  first_seen_at: string
  last_seen_at: string
}

/** One file a track has touched, and when it first and last did. */
export interface TrackFileClaim {
  trackId: string
  filePath: string
  firstSeenAt: string
  lastSeenAt: string
}

/** Two active tracks that have both touched the same file. */
export interface TrackFileOverlap {
  filePath: string
  trackIds: string[]
}

function toModel(row: ClaimRow): TrackFileClaim {
  return {
    trackId: row.track_id,
    filePath: row.file_path,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at
  }
}

/**
 * What each track has touched.
 *
 * Advisory data, never a gate: it exists to turn a merge-time surprise into a
 * live signal, and a stale or missing row costs a warning that did not appear —
 * never a blocked turn.
 */
export class TrackFileClaimRepository extends BaseRepository<ClaimRow, TrackFileClaim> {
  protected readonly tableName = 'track_file_claims'
  protected mapRow(row: ClaimRow): TrackFileClaim {
    return toModel(row)
  }

  /**
   * Record the files a track touched this turn.
   *
   * Upsert rather than replace: `first_seen_at` is deliberately preserved, so
   * "who got here first" survives a track re-touching a file on every turn.
   * Paths are workspace-relative — comparing absolute paths across worktrees
   * would never match, which is the whole point of the table.
   */
  record(trackId: string, filePaths: string[]): void {
    if (filePaths.length === 0) return
    const stmt = this.db().prepare(
      `INSERT INTO track_file_claims (track_id, file_path)
       VALUES (?, ?)
       ON CONFLICT(track_id, file_path)
       DO UPDATE SET last_seen_at = datetime('now')`
    )
    const tx = this.db().transaction((paths: string[]) => {
      for (const p of paths) stmt.run(trackId, p)
    })
    tx([...new Set(filePaths)])
  }

  findByTrack(trackId: string): TrackFileClaim[] {
    return this.findManyBy('track_id', trackId, { orderBy: 'file_path ASC' })
  }

  /** Forget everything a track claimed — used when its work has landed. */
  clearTrack(trackId: string): number {
    return this.db().prepare('DELETE FROM track_file_claims WHERE track_id = ?').run(trackId)
      .changes
  }

  /**
   * Files claimed by more than one live track in a workspace.
   *
   * Restricted to `active` tracks on purpose: a retained tree is parked and a
   * landed one is done, so neither is about to collide with anything, and
   * counting them would produce warnings the user can do nothing about.
   */
  findOverlaps(workspaceId: string): TrackFileOverlap[] {
    const rows = this.db()
      .prepare(
        `SELECT c.file_path AS file_path, c.track_id AS track_id
           FROM track_file_claims c
           JOIN work_tracks t ON t.id = c.track_id
          WHERE t.workspace_id = ?
            AND t.status = 'active'
            AND t.landed_at IS NULL
            AND c.file_path IN (
              SELECT c2.file_path
                FROM track_file_claims c2
                JOIN work_tracks t2 ON t2.id = c2.track_id
               WHERE t2.workspace_id = ?
                 AND t2.status = 'active'
                 AND t2.landed_at IS NULL
               GROUP BY c2.file_path
              HAVING COUNT(DISTINCT c2.track_id) > 1
            )
          ORDER BY c.file_path ASC, c.first_seen_at ASC`
      )
      .all(workspaceId, workspaceId) as Array<{ file_path: string; track_id: string }>

    const byPath = new Map<string, string[]>()
    for (const row of rows) {
      const list = byPath.get(row.file_path)
      if (list) list.push(row.track_id)
      else byPath.set(row.file_path, [row.track_id])
    }
    return [...byPath.entries()].map(([filePath, trackIds]) => ({ filePath, trackIds }))
  }
}

export const trackFileClaimRepository = new TrackFileClaimRepository()
