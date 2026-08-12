/**
 * Cross-track conflict prediction.
 *
 * Blueprint's wave scheduler already refuses to dispatch two tasks that touch
 * the same file — `filesOverlap()` — and that guard is why parallel BUILD is
 * safe. It is also scoped to one wave of one run: it does not know that chats,
 * other blueprints and campaigns exist. Two *tracks* editing the same file is
 * therefore invisible until one of them lands and hits a merge conflict, by
 * which point both sets of work already exist and somebody has to redo one.
 *
 * This is the cheap generalisation of that guard from within-a-wave to
 * across-the-workspace. It converts a merge-time surprise into a live signal.
 *
 * Advisory only. Nothing here blocks a turn, and every failure path degrades to
 * "no warning" — a missed prediction costs a merge conflict the user would have
 * had anyway, while a false block would stop work that was perfectly fine.
 */

import simpleGit from 'simple-git'
import log from 'electron-log'
import { trackRepository } from '../db/repositories/track.repository'
import {
  trackFileClaimRepository,
  type TrackFileOverlap
} from '../db/repositories/track-file-claim.repository'

const claimLog = log.scope('track-claims')

/** Bound on recorded paths per turn, so a sweeping refactor can't bloat the table. */
const MAX_CLAIMED_FILES = 500

/** One predicted collision, resolved to something a human can read. */
export interface PredictedConflict {
  filePath: string
  /** The other tracks touching this file, excluding the one being asked about. */
  others: Array<{ trackId: string; branchName: string; ownerKind: string; ownerId: string | null }>
}

class TrackClaimsService {
  /**
   * Record which files a track has touched, at the end of a turn.
   *
   * Two sources, deliberately: committed work (`<base>...HEAD`) and work still
   * sitting in the tree (`status --porcelain`). Either alone misses half the
   * collisions — an agent that commits every turn and one that never commits
   * are both common.
   */
  async recordForTrack(trackId: string): Promise<number> {
    const track = trackRepository.findById(trackId)
    if (!track) return 0

    const files = await this.changedFiles(track.path, track.baseBranch)
    if (files.length === 0) return 0

    try {
      trackFileClaimRepository.record(trackId, files)
    } catch (err) {
      claimLog.warn(`[record] could not store claims for ${trackId}: ${(err as Error).message}`)
      return 0
    }
    return files.length
  }

  /** Record for whichever track an owner holds. No-op when it has none. */
  async recordForOwner(
    ownerKind: 'chat' | 'blueprint' | 'campaign' | 'manual',
    ownerId: string
  ): Promise<number> {
    const row = trackRepository.findByOwner(ownerKind, ownerId)
    if (!row) return 0
    return this.recordForTrack(row.id)
  }

  /** Every file two or more live tracks are both touching, workspace-wide. */
  overlaps(workspaceId: string): TrackFileOverlap[] {
    try {
      return trackFileClaimRepository.findOverlaps(workspaceId)
    } catch (err) {
      claimLog.warn(`[overlaps] lookup failed: ${(err as Error).message}`)
      return []
    }
  }

  /**
   * What a specific track is about to collide with, named rather than counted.
   *
   * "3 files conflict" is not actionable; "src/app.ts is also being edited on
   * chat/add-retry" is.
   */
  conflictsFor(workspaceId: string, trackId: string): PredictedConflict[] {
    const out: PredictedConflict[] = []
    for (const overlap of this.overlaps(workspaceId)) {
      if (!overlap.trackIds.includes(trackId)) continue
      const others = overlap.trackIds
        .filter((id) => id !== trackId)
        .map((id) => trackRepository.findById(id))
        .filter((t): t is NonNullable<typeof t> => t != null)
        .map((t) => ({
          trackId: t.id,
          branchName: t.branchName,
          ownerKind: t.ownerKind,
          ownerId: t.ownerId
        }))
      if (others.length > 0) out.push({ filePath: overlap.filePath, others })
    }
    return out
  }

  /** Drop a track's claims once its work has landed — it can no longer collide. */
  clear(trackId: string): void {
    try {
      trackFileClaimRepository.clearTrack(trackId)
    } catch (err) {
      claimLog.warn(`[clear] failed for ${trackId}: ${(err as Error).message}`)
    }
  }

  // ── Internals ─────────────────────────────────────────────────────

  /**
   * Workspace-relative paths this tree has changed relative to its base.
   *
   * Relative, not absolute: every track lives in a different directory, so
   * absolute paths would never match between two of them and the whole table
   * would report zero overlaps forever.
   */
  private async changedFiles(path: string, baseBranch: string): Promise<string[]> {
    const git = simpleGit(path)
    const files = new Set<string>()

    // Committed on this branch since it forked.
    try {
      const out = await git.raw(['diff', '--name-only', `${baseBranch}...HEAD`])
      for (const line of out.split('\n')) {
        const p = line.trim()
        if (p) files.add(p)
      }
    } catch (err) {
      // An unknown base (renamed, never fetched) is not worth failing a turn
      // over — the porcelain pass below still catches in-flight work.
      claimLog.warn(
        `[changedFiles] diff against ${baseBranch} failed in ${path}: ${(err as Error).message}`
      )
    }

    // Uncommitted, including untracked. Porcelain v1 lines are `XY <path>`,
    // with renames written as `old -> new`; only the destination is a claim.
    try {
      const out = await git.raw(['status', '--porcelain'])
      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        const raw = line.slice(3).trim()
        const p = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw
        const unquoted = p.replace(/^"|"$/g, '')
        // The symlink this service's own worktrees create, not the agent's work.
        if (!unquoted || unquoted === 'node_modules' || unquoted === 'node_modules/') continue
        files.add(unquoted)
      }
    } catch (err) {
      claimLog.warn(`[changedFiles] status failed in ${path}: ${(err as Error).message}`)
    }

    const list = [...files]
    if (list.length > MAX_CLAIMED_FILES) {
      claimLog.info(
        `[changedFiles] ${list.length} changed paths in ${path} — recording the first ${MAX_CLAIMED_FILES}`
      )
      return list.slice(0, MAX_CLAIMED_FILES)
    }
    return list
  }
}

export const trackClaimsService = new TrackClaimsService()
