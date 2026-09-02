/**
 * TrackService — gives each unit of parallel work its own git working tree.
 *
 * A *track* is one branch + one worktree + one owner. The owner is a chat, a
 * blueprint run, an MPA campaign, or nobody at all once the work is retained.
 *
 * The problem this solves: every conversation used to run its CLI with
 * `cwd = workspace root`. That directory has one HEAD, but three streams can
 * run at once, so "chat A is on feat-a" was a database claim with nothing
 * behind it. Two agents on different branches wrote to the same files and the
 * loser's work was committed to the winner's branch, silently.
 *
 * Design rules, each one paid for by a failure mode:
 *
 *  1. Git owns the filesystem; the DB only records intent. Every read that
 *     matters re-checks the directory, because a row can outlive its folder.
 *
 *  2. Worktrees live OUTSIDE the repo (under userData), not in
 *     `.agent-studio/worktrees/` as the 2026 attempt did. Inside-the-repo
 *     trees get walked by every recursive scan (code-graph, embeddings,
 *     ripgrep) so N tracks meant N full copies indexed, and `git clean -xfd`
 *     in the primary tree deletes them all — they are untracked and ignored.
 *
 *  3. An owner whose branch is already checked out in the primary tree runs IN
 *     the primary tree. Git refuses the same branch in two worktrees, and this
 *     is the common case (user is sitting on the branch they're chatting
 *     about), so it must be a normal outcome, not an error.
 *
 *  4. `node_modules` is symlinked, never copied. This repo's is 1.3 GB; five
 *     worktrees would be 6.5 GB of duplication. The symlink is removed before
 *     `git worktree remove` runs so a forced delete can never reach through it
 *     into the primary tree's dependencies.
 *
 *  5. A worktree is removed only when it is CLEAN, or when the caller says
 *     discard. Teardown is a forced recursive delete; on chat close or delete
 *     that used to destroy work the agent produced but never committed. Dirty
 *     trees are parked as `retained` instead — a visible state, not a leak.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  type Dirent
} from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import simpleGit from 'simple-git'
import log from 'electron-log'
import { IPC_CHANNELS } from '../../shared/constants'
import { safeWindowSend } from '../ipc/safe-send'
import { trackRepository } from '../db/repositories/track.repository'
import { trackFileClaimRepository } from '../db/repositories/track-file-claim.repository'
import { workspaceRepository } from '../db/repositories/workspace.repository'
import { conversationRepository } from '../db/repositories/conversation.repository'
import type {
  WorkTrack,
  TrackOwnerKind,
  TrackLandingMode,
  TrackBaseSource,
  TrackSummary,
  ExecutionTarget,
  ReleaseOutcome,
  PredictedTrackConflict
} from '../../shared/track-types'

const wtLog = log.scope('track')

/**
 * How long a track may sit untouched before the reaper may reclaim it.
 *
 * Only ever applied to CLEAN trees, so the cost of being wrong is a `git
 * worktree add` on the next turn — `ensureTrack()` rebuilds anything it reaps.
 * `last_used_at` existed for this since the table was created and was read by
 * nothing, which is how branch-per-chat turned into unbounded disk growth.
 */
export const IDLE_REAP_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How often the idle reaper re-runs while the app stays open.
 *
 * The boot-time call was the only one, which quietly made retention policy a
 * function of how often you restart: leave the app running for a fortnight and
 * nothing is ever reclaimed, however idle. Daily is far finer-grained than the
 * seven-day idle threshold it enforces, and each pass is one indexed query plus
 * a `git status` per candidate row — cheap enough to be uninteresting.
 */
export const IDLE_REAP_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Total worktree bytes per workspace above which the UI warns.
 *
 * A warning, never an eviction: the tracks over the line are usually the dirty
 * ones the reaper is forbidden to touch, and silently deleting those is the
 * exact failure this whole subsystem exists to prevent.
 */
export const DISK_BUDGET_BYTES = 10 * 1024 * 1024 * 1024

/** Bound on the directory walk behind `diskBytes`, so a huge tree can't stall a list call. */
const MAX_WALK_ENTRIES = 50_000

/** Directories the nested-project walk never descends into. */
const PROJECT_WALK_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next'])

/**
 * How deep the nested-project walk looks.
 *
 * Three levels covers the shapes that actually occur — `apps/web`,
 * `packages/ui`, `connectors/isolved-odata-mcp` — without turning track
 * creation into a full-tree scan.
 */
const MAX_PROJECT_DEPTH = 3

/** Bound on the nested-project walk, so a pathological tree can't stall track creation. */
const MAX_PROJECT_DIRS = 2_000

function getElectronApp(): typeof import('electron').app {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy so this module loads without Electron (unit tests)
  return require('electron').app
}

/**
 * Root directory holding every worktree, keyed by workspace.
 *
 * Short on purpose, and that is a Windows constraint rather than taste. The
 * previous layout was
 * `%APPDATA%\code-atelier\worktrees\<32-char workspace id>\<40-char branch slug>-<8>`,
 * roughly 140 characters before a single repository file, against a 260-char
 * MAX_PATH. A repo with deep `src/renderer/src/components/...` paths blows that
 * budget and fails inside git with an error nobody can trace back to here.
 *
 * `%LOCALAPPDATA%\<app>\wt\<wsId8>\<trackSlug>` saves roughly 90 characters.
 * LOCALAPPDATA rather than APPDATA because worktrees are machine-local cache,
 * never something to sync to a roaming profile — and it is shorter. There is no
 * Electron `getPath` key for it, hence the env read with a userData fallback.
 *
 * Existing tracks are unaffected: every row stores its absolute path, and
 * `resolveTrack()` reads that path rather than recomputing it. This only
 * changes where NEW worktrees are created.
 *
 * The env override exists so tests (and the reaper's integration coverage) can
 * point this at a temp dir without an Electron app instance.
 */
export function worktreesRoot(): string {
  const override = process.env.AGENT_STUDIO_WORKTREE_ROOT
  if (override) return override

  const app = getElectronApp()
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) return join(localAppData, app.getName(), 'wt')
    wtLog.warn('[worktreesRoot] LOCALAPPDATA is unset — falling back to userData (longer paths)')
  }
  return join(app.getPath('userData'), 'wt')
}

/**
 * Rough length of the longest path a repository is likely to contain.
 *
 * Not measured — measuring means walking the whole tree on every track
 * creation. 120 characters is a deep-but-ordinary source path
 * (`src/renderer/src/components/workspace/blueprints/deliverables/...`), which
 * makes this a warning threshold rather than a prediction.
 */
const ASSUMED_REPO_PATH_DEPTH = 120

/** Windows MAX_PATH, minus the NUL terminator git and the CRT account for. */
const WINDOWS_MAX_PATH = 259

/**
 * Warn when a worktree path leaves too little room for the files inside it.
 *
 * Windows fails long paths deep inside git with errors like
 * "Filename too long" or a bare ENOENT on a file that plainly exists, neither
 * of which points back at the worktree root. Saying it once, here, at creation
 * time is the difference between a five-minute diagnosis and an afternoon.
 *
 * Never blocks: long-path support may be enabled (opt-in since Windows 10
 * 1607), git may be configured with `core.longpaths`, and the repo may be
 * shallow. Guessing wrong must not stop a track from being created.
 */
function warnOnLongPath(path: string): void {
  if (process.platform !== 'win32') return
  const headroom = WINDOWS_MAX_PATH - path.length
  if (headroom >= ASSUMED_REPO_PATH_DEPTH) return

  wtLog.warn(
    `[longPath] worktree root is ${path.length} chars, leaving ${headroom} for repository ` +
      `files (Windows MAX_PATH is ${WINDOWS_MAX_PATH + 1}). Deep paths in this repo may fail ` +
      `with "Filename too long" or a confusing ENOENT. Enable long-path support ` +
      `(Windows 10 1607+: LongPathsEnabled) and 'git config --system core.longpaths true'.`
  )
}

/** What kind of thing is holding a workspace's primary working tree. */
export type PrimaryTreeOwnerKind = 'chat' | 'blueprint' | 'campaign'

/** Who is occupying a workspace's primary working tree, and why. */
export interface PrimaryTreeHolder {
  ownerKind: PrimaryTreeOwnerKind
  /**
   * Stable identity of the claim. A conversation id for chats; a namespaced id
   * (`blueprint:<id>`, `mpa:<runId>`) for everything else, so a chat id can
   * never collide with a run id.
   */
  ownerId: string
  /** One phrase, shown verbatim to whoever gets blocked. */
  reason: string
}

/**
 * Serialises everything that WRITES to a workspace's shared primary tree.
 *
 * Originally this was chat-only, and that framing was the bug: a conversation
 * without a branch took the lock, but Blueprint BUILD (up to six parallel
 * agents), Blueprint VERIFY and MPA execute phases all ran `session.start()`
 * against `workspace.repoPath` and took nothing. Since chat creation stopped
 * moving the primary HEAD, that tree reliably sits on the branch the *user* is
 * working on — so blueprint output landed in the user's checkout, interleaved
 * with their uncommitted edits, with no interlock at all.
 *
 * Anything holding its own track never comes here; it has its own directory and
 * its own HEAD and stays fully parallel.
 *
 * In-memory on purpose. The invariant only needs to hold for the lifetime of a
 * process that can actually be running those writers; a restart clears any lock
 * whose owner died with it.
 */
class PrimaryTreeLock {
  private readonly holders = new Map<string, PrimaryTreeHolder>()

  /** Who currently occupies the workspace's primary tree, if anyone. */
  holder(workspaceId: string): PrimaryTreeHolder | undefined {
    return this.holders.get(workspaceId)
  }

  /**
   * Claim the primary tree. Re-entrant for the same `ownerId` — a retried chat
   * turn must not deadlock against its own abandoned claim, and a blueprint
   * handing BUILD off to VERIFY keeps one continuous claim under one id.
   *
   * @returns false when a different owner holds it.
   */
  acquire(workspaceId: string, owner: PrimaryTreeHolder): boolean {
    const current = this.holders.get(workspaceId)
    if (current && current.ownerId !== owner.ownerId) return false
    this.holders.set(workspaceId, owner)
    return true
  }

  /** No-op unless this owner is the current holder — a late release from a
   *  superseded turn must not free the lock out from under its successor. */
  release(workspaceId: string, ownerId: string): void {
    if (this.holders.get(workspaceId)?.ownerId === ownerId) this.holders.delete(workspaceId)
  }
}

export const primaryTreeLock = new PrimaryTreeLock()

/**
 * The error a blocked writer should throw.
 *
 * The `(blockedBy:<id>)` tag is emitted ONLY when a chat holds the lock: the
 * renderer resolves that id to a conversation title and offers "switch to it" /
 * "stop it". Tagging a blueprint or campaign id would render as "another chat is
 * still processing" and send the user hunting for a chat that does not exist, so
 * non-chat holders get a plain sentence naming what is actually running.
 */
export function primaryTreeBusyError(holder: PrimaryTreeHolder | undefined): Error {
  if (!holder) {
    // Lost a race with a release; the caller can simply retry.
    return new Error(`This workspace's main checkout is busy. Try again.`)
  }
  if (holder.ownerKind === 'chat') {
    return new Error(
      `Another chat is still working in this workspace's main checkout. ` +
        `Work without its own branch has to take turns — wait for it to finish, ` +
        `or give this one its own branch. (blockedBy:${holder.ownerId})`
    )
  }
  return new Error(
    `${holder.reason} is using this workspace's main checkout. ` +
      `Only one writer at a time is allowed there — wait for it to finish and retry.`
  )
}

/**
 * Why an owner cannot hand its track over right now — or null when it is idle.
 *
 * The string is one phrase, shown verbatim to whoever asked for the transfer.
 */
export type TrackBusyProbe = (ownerId: string) => string | null

const busyProbes = new Map<TrackOwnerKind, TrackBusyProbe>()

/**
 * Teach `transferOwner` how to tell whether an owner of this kind is busy.
 *
 * Inverted rather than imported. The authorities on "is this chat streaming?"
 * and "is this blueprint mid-pipeline?" are conversation-lifecycle and
 * blueprint.service, and blueprint.service already reaches back into this
 * module through blueprint-track — so importing it here would close an import
 * cycle, in a codebase that is already paying for one.
 *
 * An owner kind with no probe registered is treated as idle. Getting that wrong
 * costs an interrupted run whose work is still sitting on the branch; refusing
 * every transfer because a probe was never wired would make handoff unusable.
 */
export function registerTrackBusyProbe(kind: TrackOwnerKind, probe: TrackBusyProbe): void {
  busyProbes.set(kind, probe)
}

/** Who holds a track, in terms a user can act on. */
export interface TrackHolder {
  ownerKind: TrackOwnerKind
  /** Null for retained work — nobody owns it. */
  ownerId: string | null
  /** Chat title where one can be resolved; otherwise the id, or null. */
  label: string | null
}

/**
 * Result of a handoff attempt.
 *
 * A named holder rather than a boolean: "could not take the branch" is not
 * actionable, and the entire point of refusing is being able to say who to go
 * and look at.
 */
export type TransferOutcome =
  | { ok: true; track: WorkTrack }
  | { ok: false; reason: 'absent' }
  | { ok: false; reason: 'no-tree'; path: string }
  | { ok: false; reason: 'busy'; holder: TrackHolder; because: string }

/** Raised when a branch is already checked out by another track. */
export class TrackConflictError extends Error {
  constructor(
    message: string,
    readonly branchName: string,
    /** Null when a retained (ownerless) track holds the branch. */
    readonly heldByOwnerId: string | null
  ) {
    super(message)
    this.name = 'TrackConflictError'
  }
}

/**
 * Bytes a track occupies on disk.
 *
 * Symlinks are never followed — `node_modules` points into the primary tree, so
 * following it would report 1.3 GB per track and make the disk figure useless
 * for the decision it exists to support ("which of these can I let go of?").
 *
 * Bounded by MAX_WALK_ENTRIES and best-effort throughout: an unreadable subtree
 * contributes zero rather than failing the whole list call.
 */
async function directorySizeBytes(root: string): Promise<number> {
  if (!existsSync(root)) return 0

  let total = 0
  let seen = 0
  const queue = [root]

  while (queue.length > 0 && seen < MAX_WALK_ENTRIES) {
    const dir = queue.pop() as string
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (++seen >= MAX_WALK_ENTRIES) break
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }

  return total
}

/** Branch names contain `/` and other characters that cannot go in a path segment. */
function slugifyBranch(branch: string): string {
  const slug = branch
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    // 24 rather than 40: this segment is pure readability — the owner slug that
    // follows it is what makes the directory unique — and on Windows every
    // character here comes out of the budget for repository files inside it.
    .slice(0, 24)
  return slug || 'branch'
}

export interface EnsureTrackOptions {
  ownerKind: TrackOwnerKind
  /** Conversation id, or a namespaced run id for non-chat owners. */
  ownerId: string
  workspaceId: string
  /** Primary working tree (workspace.repoPath). */
  repoPath: string
  /** Branch this track owns. Null means "nothing to isolate". */
  branchName: string | null
  /** Fork point for a branch that does not exist yet. Defaults to primary HEAD. */
  baseBranch?: string
  /**
   * Which rule supplied `baseBranch`, recorded on the row for provenance.
   *
   * Overridden with `existing-branch` when the branch turns out to already
   * exist, because `worktree add` then uses its own tip and the base is never
   * consulted — storing the rule that chose an unused base would be a lie the
   * next reader has no way to detect.
   */
  baseSource?: TrackBaseSource
  /**
   * Landing mode recorded on the track at creation.
   *
   * Only read on the insert: re-`ensureTrack`ing an existing track must not
   * overwrite a mode the user has since changed by hand. Omit to inherit the
   * workspace default, which is what every chat track does.
   */
  landingMode?: TrackLandingMode
}

/** Chat-shaped options, kept so the chat call sites read the same as before. */
export interface EnsureWorktreeOptions {
  conversationId: string
  workspaceId: string
  repoPath: string
  branchName: string | null
  baseBranch?: string
}

export class TrackService {
  // ── Read path ─────────────────────────────────────────────────────

  /**
   * Where this owner should execute right now. Never creates anything.
   *
   * Sync and cheap because it sits on every execution path. Falls back to the
   * primary tree whenever isolation is absent or broken — but a *broken* track
   * (row present, directory gone) is logged at error level, because silently
   * dropping back to the shared tree is exactly the contamination this service
   * exists to prevent. `ensureTrack()` repairs it on the next turn.
   */
  resolveTrack(ownerKind: TrackOwnerKind, ownerId: string, primaryPath: string): ExecutionTarget {
    let row: WorkTrack | undefined
    try {
      row = trackRepository.findByOwner(ownerKind, ownerId)
    } catch (err) {
      // Bookkeeping is unavailable (no DB in a unit context, or a read error).
      // `ensureTrack()` already succeeded earlier this turn, so this is
      // exceptional; degrade to the primary tree rather than killing the turn.
      wtLog.error(`[resolve] lookup failed for ${ownerKind}:${ownerId}: ${(err as Error).message}`)
      return { path: primaryPath, branchName: null, isolated: false }
    }
    if (!row) return { path: primaryPath, branchName: null, isolated: false }

    if (row.status !== 'active') {
      wtLog.warn(`[resolve] ${ownerKind}:${ownerId} track is '${row.status}' — using primary tree`)
      return { path: primaryPath, branchName: null, isolated: false }
    }

    if (!existsSync(row.path)) {
      wtLog.error(
        `[resolve] ${ownerKind}:${ownerId} worktree missing at ${row.path} — ` +
          `falling back to primary tree. Work may land on the wrong branch until it is recreated.`
      )
      return { path: primaryPath, branchName: null, isolated: false }
    }

    return { path: row.path, branchName: row.branchName, isolated: true }
  }

  /** Chat-shaped wrapper. */
  resolve(conversationId: string, primaryPath: string): ExecutionTarget {
    return this.resolveTrack('chat', conversationId, primaryPath)
  }

  /**
   * Why this track's owner could not hand it over right now, or null when idle.
   *
   * The same question `transferOwner` asks itself, exposed so a UI can say "the
   * blueprint is still building" *before* offering a button that would fail.
   * Retained tracks have no owner to be busy.
   */
  busyReasonFor(track: WorkTrack): string | null {
    if (!track.ownerId) return null
    return busyProbes.get(track.ownerKind)?.(track.ownerId) ?? null
  }

  list(workspaceId: string): WorkTrack[] {
    return trackRepository.findByWorkspace(workspaceId)
  }

  get(trackId: string): WorkTrack | undefined {
    return trackRepository.findById(trackId)
  }

  /**
   * Everything the Tracks list needs, with the filesystem facts filled in.
   *
   * `dirty`, `exists` and `diskBytes` are recomputed on every call rather than
   * cached in columns: the row records intent, git owns the truth, and a stale
   * "clean" flag is the one thing that could talk a user into discarding work
   * that was still there.
   */
  async summarize(workspaceId: string): Promise<TrackSummary[]> {
    const rows = trackRepository.findByWorkspace(workspaceId)

    // One query for the whole workspace rather than one per row: overlaps are
    // inherently a cross-row question, and asking it per track would be N
    // scans of the same table.
    const conflictsByTrack = this.conflictIndex(workspaceId, rows)

    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        exists: existsSync(row.path),
        dirty: await this.hasUncommittedWork(row.path),
        diskBytes: await directorySizeBytes(row.path),
        ownerLabel: this.ownerLabel(row),
        conflicts: conflictsByTrack.get(row.id) ?? []
      }))
    )
  }

  /**
   * Predicted file collisions, keyed by track.
   *
   * Best-effort by design: the claims table is advisory, so a read failure
   * costs a warning that did not appear — never a broken Tracks list.
   */
  private conflictIndex(
    workspaceId: string,
    rows: WorkTrack[]
  ): Map<string, PredictedTrackConflict[]> {
    const index = new Map<string, PredictedTrackConflict[]>()
    let overlaps: { filePath: string; trackIds: string[] }[]
    try {
      overlaps = trackFileClaimRepository.findOverlaps(workspaceId)
    } catch (err) {
      wtLog.warn(`[summarize] conflict prediction unavailable: ${(err as Error).message}`)
      return index
    }

    const branchById = new Map(rows.map((r) => [r.id, r.branchName]))
    for (const overlap of overlaps) {
      for (const trackId of overlap.trackIds) {
        const others = overlap.trackIds
          .filter((id) => id !== trackId && branchById.has(id))
          .map((id) => ({ trackId: id, branchName: branchById.get(id) as string }))
        if (others.length === 0) continue
        const list = index.get(trackId)
        const entry = { filePath: overlap.filePath, others }
        if (list) list.push(entry)
        else index.set(trackId, [entry])
      }
    }
    return index
  }

  /**
   * Human-readable name for a track's owner, when one can still be resolved.
   *
   * Chats keep their title in the DB; blueprint and campaign owners are
   * synthetic run ids with no row to look up, so they get a kind label instead
   * of a lie.
   */
  private ownerLabel(row: WorkTrack): string | null {
    if (!row.ownerId) return null
    if (row.ownerKind !== 'chat') return row.ownerId
    try {
      return conversationRepository.findById(row.ownerId)?.title ?? null
    } catch {
      return null
    }
  }

  // ── Write path ────────────────────────────────────────────────────

  /**
   * Guarantee this owner has somewhere safe to work, and return it.
   *
   * Idempotent: calling it every turn is the intended usage, since that is what
   * makes the tree self-healing after a manual delete or a crash mid-teardown.
   */
  async ensureTrack(opts: EnsureTrackOptions): Promise<ExecutionTarget> {
    const { ownerKind, ownerId, workspaceId, repoPath, branchName } = opts

    // Rule 3: nothing to isolate.
    if (!branchName) {
      return { path: repoPath, branchName: null, isolated: false }
    }

    const git = simpleGit(repoPath)
    const primaryBranch = await this.currentBranch(git)

    // Rule 3: the primary tree already holds this branch. Use it as-is.
    if (primaryBranch === branchName) {
      const existing = trackRepository.findByOwner(ownerKind, ownerId)
      if (existing) {
        wtLog.info(
          `[ensure] branch ${branchName} moved to the primary tree — releasing track for ${ownerKind}:${ownerId}`
        )
        await this.releaseTrack(ownerKind, ownerId)
      }
      this.emitChanged(workspaceId)
      return { path: repoPath, branchName, isolated: false }
    }

    const existing = trackRepository.findByOwner(ownerKind, ownerId)
    if (existing) {
      const reusable =
        existing.status === 'active' &&
        existing.branchName === branchName &&
        existsSync(existing.path)

      if (reusable) {
        trackRepository.touch(existing.id)
        return { path: existing.path, branchName, isolated: true }
      }

      // Stale for one of three reasons: torn down halfway, the owner switched
      // branches, or somebody deleted the directory. All recover the same way.
      wtLog.warn(
        `[ensure] stale track for ${ownerKind}:${ownerId} ` +
          `(status=${existing.status}, branch=${existing.branchName}, exists=${existsSync(existing.path)}) — rebuilding`
      )
      await this.releaseTrack(ownerKind, ownerId)
    }

    // Git enforces one-worktree-per-branch repo-wide; check first so the user
    // gets "track X already owns feat-a" instead of a raw git error.
    const holder = trackRepository.findByBranch(workspaceId, branchName)
    if (holder && holder.ownerId !== ownerId) {
      // A holder with no owner is a retained track: whatever produced it is
      // gone but the uncommitted work is not. Saying "another chat" would send
      // the user looking for a chat that no longer exists.
      throw new TrackConflictError(
        holder.ownerId
          ? `Branch "${branchName}" is already checked out by other work. ` +
              `Rename this branch or finish the other one first.`
          : `Branch "${branchName}" is held by retained work at ${holder.path}. ` +
              `Commit or discard that work, or pick a different branch.`,
        branchName,
        holder.ownerId
      )
    }

    const baseBranch = opts.baseBranch ?? primaryBranch ?? 'main'
    const path = this.pathFor(workspaceId, ownerId, branchName)

    // Hoisted out of `gitAddWorktree` so the row can record that the base was
    // never consulted. Same single git call, asked one level higher.
    const branchAlreadyExists = await this.branchExists(git, branchName)

    await this.gitAddWorktree(git, path, branchName, baseBranch, branchAlreadyExists)
    // Best-effort: a worktree without dependencies is degraded, not broken, so
    // a failure here must not abort track creation. It is logged loudly instead.
    const linked = this.linkNodeModules(repoPath, path)

    const created = trackRepository.create({
      workspaceId,
      ownerKind,
      ownerId,
      branchName,
      path,
      baseBranch,
      baseSource: branchAlreadyExists ? 'existing-branch' : opts.baseSource,
      landingMode: opts.landingMode
    })
    trackRepository.touch(created.id)

    wtLog.info(
      `[ensure] created worktree ${path} for ${branchName} (base=${baseBranch}` +
        `${linked ? '' : ', dependencies NOT linked'})`
    )
    this.emitChanged(workspaceId)
    return { path, branchName, isolated: true }
  }

  /** Chat-shaped wrapper. */
  async ensure(opts: EnsureWorktreeOptions): Promise<ExecutionTarget> {
    return this.ensureTrack({
      ownerKind: 'chat',
      ownerId: opts.conversationId,
      workspaceId: opts.workspaceId,
      repoPath: opts.repoPath,
      branchName: opts.branchName,
      baseBranch: opts.baseBranch
    })
  }

  /**
   * Tear down an owner's track — unless doing so would throw work away.
   *
   * `git worktree remove --force` deletes uncommitted changes. That is correct
   * after `/complete`, where the commit and push already happened, and wrong
   * everywhere else: chat close and chat delete both called this, so closing a
   * chat destroyed whatever the agent had written but not committed. The tree
   * is now inspected first and parked as `retained` when it is dirty.
   *
   * Order matters for the removal path: the row is marked `removing` before the
   * git call, so a crash in between leaves a tombstone the reaper can finish
   * rather than an `active` row pointing at a deleted directory (which
   * `resolveTrack()` would treat as corruption).
   *
   * @param opts.discard Remove regardless of uncommitted changes. Reserved for
   *   an explicit user "discard this work" action — never a default.
   */
  async releaseTrack(
    ownerKind: TrackOwnerKind,
    ownerId: string,
    opts?: { discard?: boolean }
  ): Promise<ReleaseOutcome> {
    const row = trackRepository.findByOwner(ownerKind, ownerId)
    if (!row) return 'absent'

    if (!opts?.discard && (await this.hasUncommittedWork(row.path))) {
      trackRepository.markRetained(row.id)
      wtLog.warn(
        `[release] retained worktree ${row.path} (${row.branchName}) — uncommitted changes. ` +
          `Nothing was deleted; the tree keeps its branch until the work is committed or discarded.`
      )
      this.emitChanged(row.workspaceId)
      return 'retained'
    }

    trackRepository.markRemoving(row.id)
    await this.destroyTree(row.path, this.primaryPathFor(row.workspaceId))
    trackRepository.deleteById(row.id)
    wtLog.info(`[release] removed track for ${ownerKind}:${ownerId} (${row.branchName})`)
    this.emitChanged(row.workspaceId)
    return 'removed'
  }

  /** Chat-shaped wrapper. */
  async release(conversationId: string, opts?: { discard?: boolean }): Promise<ReleaseOutcome> {
    return this.releaseTrack('chat', conversationId, opts)
  }

  /**
   * Hand retained work to a brand-new chat.
   *
   * Retention keeps uncommitted work alive but detached — before this there was
   * no way back to it short of `git worktree list` and a manual checkout. Adopt
   * re-owns the *existing* directory rather than creating a second one, so the
   * changes the user is trying to recover are the changes the new chat sees.
   *
   * @returns the new conversation id, or null when the track is not adoptable.
   */
  adopt(trackId: string): string | null {
    const row = trackRepository.findById(trackId)
    if (!row) return null
    if (row.ownerId) {
      // Somebody still owns it; re-pointing would strand that owner on a tree
      // it believes it holds.
      wtLog.warn(`[adopt] track ${trackId} still owned by ${row.ownerKind}:${row.ownerId}`)
      return null
    }
    if (!existsSync(row.path)) {
      wtLog.warn(`[adopt] track ${trackId} has no directory at ${row.path}`)
      return null
    }

    const conversation = conversationRepository.create(row.workspaceId, `Resume ${row.branchName}`)
    conversationRepository.updateBranchName(conversation.id, row.branchName)
    trackRepository.adoptOwner(row.id, 'chat', conversation.id)
    trackRepository.touch(row.id)

    wtLog.info(`[adopt] ${row.path} (${row.branchName}) adopted by chat ${conversation.id}`)
    this.emitChanged(row.workspaceId)
    return conversation.id
  }

  /**
   * Move a track from one owner to another, directory and all.
   *
   * This is the sequential half of "share a branch": the worktree is NOT
   * recreated and nothing is copied, so the new owner sees exactly the files
   * the previous one left, including uncommitted ones. Only the owner columns
   * move.
   *
   * Refused while the current owner is busy, because a transfer mid-turn hands
   * a directory to a second writer while the first is still writing into it —
   * precisely the interleaving this subsystem exists to prevent.
   *
   * Idempotent: transferring to the current owner succeeds without touching
   * anything, so a retried take-over is not an error.
   *
   * @param opts.force Skip the busy check, for an explicit "take it anyway"
   *   once the user has been told who holds it. Never a default.
   */
  transferOwner(
    trackId: string,
    to: { ownerKind: TrackOwnerKind; ownerId: string },
    opts?: { force?: boolean }
  ): TransferOutcome {
    const row = trackRepository.findById(trackId)
    if (!row) return { ok: false, reason: 'absent' }

    if (row.ownerKind === to.ownerKind && row.ownerId === to.ownerId) {
      return { ok: true, track: row }
    }

    // The directory is the thing being handed over. Without it there is nothing
    // to transfer, and creating one here would silently produce an EMPTY tree —
    // the opposite of "you get what they left".
    if (!existsSync(row.path)) return { ok: false, reason: 'no-tree', path: row.path }

    // Retained tracks have no owner to be busy; that is what makes them adoptable.
    if (!opts?.force && row.ownerId) {
      const because = busyProbes.get(row.ownerKind)?.(row.ownerId) ?? null
      if (because) {
        return {
          ok: false,
          reason: 'busy',
          holder: { ownerKind: row.ownerKind, ownerId: row.ownerId, label: this.ownerLabel(row) },
          because
        }
      }
    }

    trackRepository.adoptOwner(row.id, to.ownerKind, to.ownerId)
    trackRepository.touch(row.id)
    wtLog.info(
      `[transfer] ${row.branchName} moved from ${row.ownerKind}:${row.ownerId ?? '—'} ` +
        `to ${to.ownerKind}:${to.ownerId} (same tree at ${row.path})`
    )
    this.emitChanged(row.workspaceId)

    const updated = trackRepository.findById(row.id)
    return updated ? { ok: true, track: updated } : { ok: false, reason: 'absent' }
  }

  /**
   * Throw a track away on the user's explicit instruction.
   *
   * Keyed by track id, not owner id, because retaining a track detaches it: by
   * the time anyone looks at parked work and decides against it, the chat that
   * produced it is usually already deleted. This is the only entry point that
   * destroys uncommitted changes, and nothing calls it automatically.
   *
   * @returns false when the row is already gone.
   */
  async discard(trackId: string): Promise<boolean> {
    const row = trackRepository.findById(trackId)
    if (!row) return false

    trackRepository.markRemoving(row.id)
    await this.destroyTree(row.path, this.primaryPathFor(row.workspaceId))
    trackRepository.deleteById(row.id)
    wtLog.info(`[discard] deleted ${row.path} (${row.branchName}) on explicit request`)
    this.emitChanged(row.workspaceId)
    return true
  }

  /**
   * Boot-time cleanup: finish interrupted removals and drop rows whose
   * directory is gone. Returns how many rows were reclaimed.
   *
   * Only clean trees are reclaimed. A row can be `removing` and still hold
   * work: the previous run may have died between `markRemoving` and the actual
   * delete, or `destroyTree` may have failed. Re-checking rather than trusting
   * the tombstone is what keeps a crash from becoming data loss on next boot.
   * `retained` rows are skipped outright — that is their entire purpose.
   */
  async pruneOrphans(): Promise<number> {
    let reclaimed = 0
    for (const row of trackRepository.findAll()) {
      const missing = !existsSync(row.path)
      if (row.status !== 'removing' && !missing) continue

      if (!missing && (await this.hasUncommittedWork(row.path))) {
        trackRepository.markRetained(row.id)
        wtLog.warn(`[prune] retained ${row.path} — interrupted removal left uncommitted changes`)
        continue
      }

      wtLog.info(`[prune] reclaiming ${row.path} (status=${row.status}, missing=${missing})`)
      await this.destroyTree(row.path, this.primaryPathFor(row.workspaceId))
      trackRepository.deleteById(row.id)
      reclaimed++
    }
    if (reclaimed > 0) this.emitChanged(null)
    return reclaimed
  }

  /**
   * Reclaim tracks nobody has touched in a while — CLEAN ones only.
   *
   * Branch-per-chat became the default and nothing ever reaped, so worktrees
   * accumulated for the life of the install; `last_used_at` was written on
   * every turn and read by nothing. This is what reads it.
   *
   * Deliberately narrow: a dirty tree is never idle enough to delete, no matter
   * how old, because "we assumed you were done with it" is not a defensible
   * reason to destroy uncommitted work. A clean tree costs one `worktree add`
   * to rebuild, and `ensureTrack()` does that automatically on the next turn,
   * so the worst case here is a few seconds — not lost work.
   *
   * @returns how many tracks were reclaimed.
   */
  async reapIdle(idleMs: number = IDLE_REAP_MS): Promise<number> {
    const cutoff = Date.now() - idleMs
    let reclaimed = 0

    for (const row of trackRepository.findAll()) {
      // `last_used_at` is stored as SQLite `datetime('now')` — UTC, no zone
      // suffix — so it must be read as UTC rather than local time.
      const stamp = row.lastUsedAt ?? row.createdAt
      const lastUsed = Date.parse(`${stamp.replace(' ', 'T')}Z`)
      if (!Number.isFinite(lastUsed) || lastUsed > cutoff) continue
      if (!existsSync(row.path)) continue // pruneOrphans owns this case
      if (await this.hasUncommittedWork(row.path)) continue

      wtLog.info(
        `[reap] reclaiming idle clean track ${row.path} (${row.branchName}, last used ${stamp})`
      )
      trackRepository.markRemoving(row.id)
      await this.destroyTree(row.path, this.primaryPathFor(row.workspaceId))
      trackRepository.deleteById(row.id)
      reclaimed++
    }
    if (reclaimed > 0) this.emitChanged(null)
    return reclaimed
  }

  /**
   * Run the idle reaper on a timer for as long as the app is open.
   *
   * Idempotent — a second call is a no-op rather than a second timer.
   * `unref()` so a pending tick can never be the reason the process stays
   * alive; `stopIdleReaper()` on quit is the deterministic half.
   */
  startIdleReaper(intervalMs: number = IDLE_REAP_INTERVAL_MS): void {
    if (this.reapTimer) return
    this.reapTimer = setInterval(() => {
      void this.reapIdle()
        .then((reaped) => {
          if (reaped > 0) {
            wtLog.info(`[reap] periodic pass reclaimed ${reaped} idle clean worktree(s)`)
          }
        })
        .catch((err) => wtLog.warn(`[reap] periodic pass failed: ${(err as Error).message}`))
    }, intervalMs)
    this.reapTimer.unref?.()
  }

  /** Stop the periodic reaper. Safe to call when it was never started. */
  stopIdleReaper(): void {
    if (!this.reapTimer) return
    clearInterval(this.reapTimer)
    this.reapTimer = null
  }

  // ── Internals ─────────────────────────────────────────────────────

  private reapTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Tell every renderer the track list moved.
   *
   * The Tracks panel fetched on mount and never again, so a track created,
   * retained or reaped while the panel was open simply did not appear — the
   * user's evidence that retention worked arrived only if they thought to hit
   * Refresh. Broadcast rather than a held window reference: this service is a
   * module singleton with no window of its own, and the payload is a hint, not
   * data, so a missed send costs a stale list until the next event.
   *
   * `workspaceId` is null when the change crossed workspaces (the reaper and
   * the orphan pruner walk every row), meaning "refresh regardless".
   */
  private emitChanged(workspaceId: string | null): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy so this module loads without Electron (unit tests)
      const { BrowserWindow } = require('electron') as typeof import('electron')
      for (const win of BrowserWindow.getAllWindows()) {
        safeWindowSend(win, IPC_CHANNELS.TRACK_CHANGED, { workspaceId })
      }
    } catch {
      /* no Electron (unit context) or every renderer is gone */
    }
  }

  private pathFor(workspaceId: string, ownerId: string, branchName: string): string {
    // Branch slug for humans reading the folder list, owner id for uniqueness
    // (two owners can want similarly-named branches over time). Namespaced ids
    // (`blueprint:<uuid>`) contribute their id part, not the shared prefix —
    // otherwise every blueprint track would slug to the same eight characters.
    //
    // Both segments are short for the Windows path budget: workspace ids are
    // 32-char hex, and the full id bought nothing a prefix does not — collisions
    // between two workspaces' first 8 hex characters are vanishingly unlikely,
    // and the leaf below still carries the owner. See worktreesRoot().
    const idPart = ownerId.includes(':') ? ownerId.slice(ownerId.indexOf(':') + 1) : ownerId
    const ownerSlug = idPart.replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8) || 'track'
    const leaf = `${slugifyBranch(branchName)}-${ownerSlug}`
    const path = join(worktreesRoot(), workspaceId.slice(0, 8), leaf)
    warnOnLongPath(path)
    return path
  }

  private async currentBranch(git: ReturnType<typeof simpleGit>): Promise<string | null> {
    try {
      const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
      // Detached HEAD reports the literal string "HEAD".
      return branch && branch !== 'HEAD' ? branch : null
    } catch (err) {
      wtLog.warn(`[currentBranch] failed: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * Does this local branch exist?
   *
   * Deliberately not `rev-parse --verify --quiet`: `--quiet` silences stderr,
   * and simple-git only rejects when a failing git writes something there. The
   * check therefore reported *every* branch as existing, so new branches were
   * sent down the `worktree add <path> <branch>` path and died on
   * "fatal: invalid reference". `for-each-ref` exits 0 either way and answers
   * through stdout, so the result never depends on error-detection heuristics.
   */
  private async branchExists(git: ReturnType<typeof simpleGit>, branch: string): Promise<boolean> {
    try {
      const out = await git.raw([
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/heads/${branch}`
      ])
      return out.trim().length > 0
    } catch (err) {
      wtLog.warn(`[branchExists] lookup failed for ${branch}: ${(err as Error).message}`)
      return false
    }
  }

  /**
   * Does this tree hold changes that a forced delete would destroy?
   *
   * Failure returns TRUE. The cost of a false positive is a directory that
   * lingers until the user discards it; the cost of a false negative is
   * deleting work that cannot be recovered, so an unreadable tree is treated as
   * precious rather than disposable.
   *
   * `node_modules` is filtered out because this service created that symlink.
   * Repos that do not gitignore it would otherwise report every worktree as
   * permanently dirty, and nothing would ever be reclaimable. The path prefix
   * is part of the pattern because a multi-project repo gets one link per
   * project (`?? apps/web/node_modules`), not just one at the root.
   */
  async hasUncommittedWork(path: string): Promise<boolean> {
    if (!existsSync(path)) return false

    try {
      const out = await simpleGit(path).raw(['status', '--porcelain'])
      return out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .some((line) => !/^\?\?\s+(?:.*\/)?node_modules\/?$/.test(line))
    } catch (err) {
      wtLog.warn(
        `[hasUncommittedWork] status failed for ${path}: ${(err as Error).message} — ` +
          `treating as dirty so nothing is deleted on a guess`
      )
      return true
    }
  }

  private async gitAddWorktree(
    git: ReturnType<typeof simpleGit>,
    path: string,
    branch: string,
    baseBranch: string,
    /** Resolved by the caller, which needs the same answer for provenance. */
    branchAlreadyExists?: boolean
  ): Promise<void> {
    mkdirSync(dirname(path), { recursive: true })

    // A leftover directory makes `worktree add` fail with a confusing message.
    if (existsSync(path)) {
      wtLog.warn(`[gitAddWorktree] clearing leftover directory at ${path}`)
      rmSync(path, { recursive: true, force: true })
    }

    // Drop any registration pointing at a path we just deleted, otherwise git
    // still believes the worktree exists and refuses to re-add it.
    try {
      await git.raw(['worktree', 'prune'])
    } catch (err) {
      wtLog.warn(`[gitAddWorktree] prune failed (continuing): ${(err as Error).message}`)
    }

    const exists = branchAlreadyExists ?? (await this.branchExists(git, branch))
    const args = exists
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path, baseBranch]

    await git.raw(args)
  }

  /**
   * Every directory under `root` that could hold an npm project, relative to
   * it (`''` is the root itself).
   *
   * Bounded on purpose: this runs on the track-creation path, in front of the
   * agent's first turn, so a full-tree scan of a large repo would surface as a
   * stall. `isDirectory()` is false for a symlink, so the walk never follows a
   * link out of the tree it was pointed at.
   */
  private walkProjectDirs(root: string): string[] {
    const found: string[] = ['']
    const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }]

    while (queue.length > 0 && found.length < MAX_PROJECT_DIRS) {
      const { rel, depth } = queue.shift()!
      if (depth >= MAX_PROJECT_DEPTH) continue

      let entries: Dirent[] = []
      try {
        entries = readdirSync(join(root, rel), { withFileTypes: true })
      } catch {
        continue // an unreadable directory is not worth failing track creation over
      }

      for (const entry of entries) {
        if (found.length >= MAX_PROJECT_DIRS) break
        if (!entry.isDirectory() || PROJECT_WALK_SKIP.has(entry.name)) continue
        const child = rel ? `${rel}/${entry.name}` : entry.name
        found.push(child)
        queue.push({ rel: child, depth: depth + 1 })
      }
    }

    return found
  }

  /**
   * Project directories in the primary tree that actually have dependencies
   * installed, relative to it.
   *
   * A multi-project repo that is not an npm workspace — root `package.json`
   * with no `workspaces` key, `apps/*` each with their own lockfile and their
   * own `node_modules` — has one dependency tree per project. Linking only the
   * root leaves every nested app bare, and the agent meets that as
   * `Cannot find module '<dep>'` inside a build task, where it reads as a code
   * defect rather than the setup defect it is.
   *
   * The rule is deliberately dumb: *if the primary tree has dependencies
   * there, mirror them*. Guessing which nested projects are real build targets
   * can be wrong; one extra symlink cannot. The root is the only special case,
   * and only because a `node_modules` without a sibling `package.json` is
   * still worth linking there.
   */
  private discoverDependencyRoots(primaryPath: string): string[] {
    return this.walkProjectDirs(primaryPath).filter(
      (rel) =>
        existsSync(join(primaryPath, rel, 'node_modules')) &&
        (rel === '' || existsSync(join(primaryPath, rel, 'package.json')))
    )
  }

  /**
   * Symlink the primary tree's `node_modules` — every project's, not just the
   * root's — into the worktree.
   *
   * Without this every worktree is a broken dev environment — no typecheck, no
   * tests, no lint — which defeats the point of giving an agent its own tree.
   * Copying is not an option at 1.3 GB per track.
   *
   * Best-effort: a worktree without dependencies is degraded, not broken, so a
   * symlink failure (Windows without developer mode, for instance) must not
   * abort track creation — and one project's failure must not skip the rest.
   */
  private linkNodeModules(repoPath: string, worktreePath: string): boolean {
    for (const rel of this.discoverDependencyRoots(repoPath)) {
      const target = join(worktreePath, rel, 'node_modules')
      if (existsSync(target)) continue
      // A project the primary has but this branch does not is not ours to
      // create: an untracked `apps/foo/` would report as `?? apps/foo/` for
      // ever, and a permanently dirty tree is never reclaimable.
      if (!existsSync(join(worktreePath, rel))) continue

      try {
        symlinkSync(join(repoPath, rel, 'node_modules'), target, 'junction')
        wtLog.info(`[linkNodeModules] linked ${rel || '.'} dependencies into ${worktreePath}`)
      } catch (err) {
        // Windows refuses junction creation without the right privileges, and
        // it is the one failure here a user can actually fix — so say what
        // broke rather than logging a bare errno.
        wtLog.warn(
          `[linkNodeModules] could not link ${rel || '.'} dependencies into ` +
            `${worktreePath}: ${(err as Error).message}`
        )
      }
    }

    return this.reportBareProjects(worktreePath)
  }

  /**
   * Name every project left without dependencies, and report the tree as
   * degraded when any is.
   *
   * This is the half that was actually broken. The old code returned `true` on
   * three paths — no root `node_modules`, target already present, root link
   * succeeded — so the warning below, the only user-visible signal at setup
   * time, could not fire for the case that hurts: a nested project left bare
   * while the root link reported success.
   */
  private reportBareProjects(worktreePath: string): boolean {
    const bare = this.walkProjectDirs(worktreePath).filter(
      (rel) =>
        existsSync(join(worktreePath, rel, 'package.json')) &&
        !existsSync(join(worktreePath, rel, 'node_modules'))
    )
    if (bare.length === 0) return true

    wtLog.warn(
      `[linkNodeModules] ${bare.length} project(s) in ${worktreePath} have no dependencies: ` +
        `${bare.map((rel) => rel || '.').join(', ')}. The tree is usable for editing and git, ` +
        `but builds, tests and lint will not run in those directories until dependencies are ` +
        `installed there (or, on Windows, developer mode / elevated privileges allow the junction).`
    )
    return false
  }

  /** The owning workspace's primary working tree, if it is still on disk. */
  private primaryPathFor(workspaceId: string): string | null {
    try {
      const repoPath = workspaceRepository.findById(workspaceId)?.repoPath
      return repoPath && existsSync(repoPath) ? repoPath : null
    } catch (err) {
      wtLog.warn(`[primaryPathFor] lookup failed: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * Remove a worktree directory and deregister it.
   *
   * Every git call runs against the *owning* repository. An earlier version
   * fell back to `process.cwd()` when the directory was already gone, which
   * pointed `worktree remove` at whatever repo the app happened to be launched
   * from — a command aimed at an unrelated project's worktree list.
   *
   * The symlink is unlinked first: `--force` does a recursive delete, and the
   * one outcome that must be impossible is that walk following `node_modules`
   * into the primary tree's dependencies.
   */
  private async destroyTree(path: string, primaryPath: string | null): Promise<void> {
    this.unlinkNodeModules(path)

    if (!primaryPath) {
      wtLog.warn(`[destroyTree] no primary tree for ${path} — deleting directory only`)
      this.rmDirectory(path)
      return
    }

    const git = simpleGit(primaryPath)

    if (existsSync(path)) {
      const removed = await this.removeWorktreeWithRetry(git, path)
      if (!removed) this.rmDirectory(path)
    }

    // Deregister entries whose directory is already gone. Without this git
    // still believes the worktree exists and refuses to reuse the branch.
    try {
      await git.raw(['worktree', 'prune'])
    } catch (err) {
      wtLog.warn(`[destroyTree] prune failed: ${(err as Error).message}`)
    }
  }

  /**
   * `git worktree remove --force`, retried on a transient lock.
   *
   * On Windows a file in the tree is routinely held open for a moment by
   * something that is not us — antivirus scanning what the agent just wrote,
   * an indexer, a stale watcher — and the remove fails with EBUSY/EPERM.
   * Falling straight through to a raw recursive delete in that case leaves git
   * still believing the worktree exists, which is exactly the corruption
   * `pruneOrphans` was written to clean up. A couple of short retries turn the
   * common case back into a clean removal.
   *
   * Deliberately short: three attempts over ~700ms. A handle held longer than
   * that is not transient, and the caller's directory-delete fallback plus the
   * `worktree prune` that follows still leave a consistent state.
   *
   * @returns true when git removed the worktree itself.
   */
  private async removeWorktreeWithRetry(
    git: ReturnType<typeof simpleGit>,
    path: string
  ): Promise<boolean> {
    const delays = [0, 200, 500]
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) await new Promise((r) => setTimeout(r, delays[attempt]))
      try {
        await git.raw(['worktree', 'remove', '--force', path])
        return true
      } catch (err) {
        const message = (err as Error).message
        const transient =
          /EBUSY|EPERM|resource busy|being used by another process|Access is denied/i
        if (attempt === delays.length - 1 || !transient.test(message)) {
          wtLog.warn(
            `[destroyTree] 'worktree remove' failed for ${path}: ${message} — ` +
              `removing directory directly`
          )
          return false
        }
        wtLog.info(
          `[destroyTree] ${path} is locked (attempt ${attempt + 1}/${delays.length}) — retrying`
        )
      }
    }
    return false
  }

  private rmDirectory(path: string): void {
    try {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true })
    } catch (err) {
      wtLog.error(`[destroyTree] could not delete ${path}: ${(err as Error).message}`)
    }
  }

  /**
   * Remove every node_modules symlink without touching what they point at.
   *
   * All of them, not just the root's: teardown is `rmSync(recursive, force)`,
   * and a nested link left in place is a walk straight into the primary tree's
   * dependencies.
   */
  private unlinkNodeModules(worktreePath: string): void {
    for (const rel of this.walkProjectDirs(worktreePath)) {
      const target = join(worktreePath, rel, 'node_modules')
      try {
        // lstat, not stat: we must detect the link itself, not its destination.
        if (!lstatSync(target).isSymbolicLink()) continue
        unlinkSync(target)
      } catch {
        /* absent or already gone — nothing to protect */
      }
    }
  }
}

export const trackService = new TrackService()
