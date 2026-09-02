import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  GitBranch,
  GitMerge,
  GitPullRequest,
  HardDrive,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { useChatStore } from '@renderer/store/chat.store'
import type {
  MainlineSyncStatus,
  TrackLandingMode,
  TrackListResult,
  TrackSummary
} from '../../../../shared/track-types'
import { TrackLandingPanel } from './TrackLandingPanel'

/**
 * Tracks — the working trees agents actually write in.
 *
 * Chats that own a branch run in their own git worktree, and closing one with
 * uncommitted changes deliberately does NOT delete it: the tree is retained.
 * Until this panel existed, "retained" meant the work was safe on disk and
 * completely unreachable — no list, no path, no way back short of
 * `git worktree list` in a terminal. This is the route back.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'never'
  // SQLite writes `datetime('now')` as UTC with no zone suffix.
  const ms = Date.parse(`${iso.replace(' ', 'T')}Z`)
  if (!Number.isFinite(ms)) return iso
  const days = Math.floor((Date.now() - ms) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

const STATE_STYLES: Record<string, string> = {
  active: 'bg-info/15 text-info',
  retained: 'bg-accent/15 text-accent',
  removing: 'bg-surface-overlay text-text-secondary',
  conflicted: 'bg-danger/15 text-danger'
}

/**
 * The integration branch's standing against the mainline, and the one button
 * that closes the loop.
 *
 * Completed blueprints merge themselves into the integration branch, and
 * nothing moves that work on to the branch the user actually works on. Without
 * this card that is invisible: the Tracks list would show nine landed tracks
 * and give no hint that none of it had reached the mainline. `behind` is shown
 * even though the user cannot act on it directly, because it is the number that
 * silently decides whether syncing stays a fast-forward or becomes a PR forever.
 */
function MainlineCard({
  mainline,
  busy,
  onSync
}: {
  mainline: MainlineSyncStatus
  busy: boolean
  onSync: () => void
}): React.JSX.Element | null {
  // Nothing has ever landed here, so there is no relationship to describe yet.
  if (!mainline.exists) return null

  const waiting = mainline.ahead > 0
  const diverged = mainline.behind > 0
  const blockedReason = mainline.primaryTreeDirty
    ? 'Your checkout has uncommitted changes — commit or stash them first.'
    : null

  return (
    <div
      data-testid="mainline-sync"
      className="flex items-start gap-3 p-3 rounded-lg border border-border-subtle bg-surface-overlay"
    >
      <GitMerge size={16} className="mt-0.5 shrink-0 text-accent" />

      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-primary truncate">
          {mainline.integrationBranch} → {mainline.baseBranch}
        </div>

        <div className="mt-1 text-xs text-text-secondary">
          {waiting ? (
            <>
              {mainline.ahead} commit{mainline.ahead === 1 ? '' : 's'} waiting
              {diverged && (
                <>
                  {' · '}
                  <span className="text-warning">
                    {mainline.baseBranch} is {mainline.behind} ahead
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 size={12} className="text-success" />
              {mainline.baseBranch} already has everything landed here
            </span>
          )}
        </div>

        {waiting && mainline.humanReviewCount > 0 && (
          <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-warning">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>
              {mainline.humanReviewCount} of them were landed by a blueprint that completed without
              being fully verified. Review before promoting.
            </span>
          </div>
        )}

        {waiting && diverged && (
          <div className="mt-1.5 text-[11px] text-text-secondary/70">
            {mainline.baseBranch} has moved since these forked, so this is a merge rather than a
            fast-forward — it opens a pull request instead of touching your checkout.
          </div>
        )}

        {waiting && blockedReason && (
          <div className="mt-1.5 text-[11px] text-warning">{blockedReason}</div>
        )}
      </div>

      <button
        onClick={onSync}
        disabled={busy || !waiting || (!diverged && mainline.primaryTreeDirty)}
        title={
          waiting
            ? diverged
              ? `Open a pull request to merge ${mainline.integrationBranch} into ${mainline.baseBranch}`
              : `Fast-forward ${mainline.baseBranch} to ${mainline.integrationBranch}`
            : 'Nothing is waiting to be promoted'
        }
        className="flex items-center gap-1.5 shrink-0 px-2.5 py-1.5 rounded-lg text-xs bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-40"
      >
        {busy ? (
          <Loader2 size={13} className="animate-spin" />
        ) : diverged ? (
          <GitPullRequest size={13} />
        ) : (
          <GitMerge size={13} />
        )}
        {diverged ? 'Open pull request' : 'Sync mainline'}
      </button>
    </div>
  )
}

interface TrackRowProps {
  track: TrackSummary
  busy: boolean
  onReveal: () => void
  onAdopt: () => void
  onLand: () => void
  onDiscard: () => void
}

function TrackRow({
  track,
  busy,
  onReveal,
  onAdopt,
  onLand,
  onDiscard
}: TrackRowProps): React.JSX.Element {
  const adoptable = track.ownerId === null && track.exists
  // Landing needs somewhere to land from, and nothing to land twice.
  const landable = track.exists && track.landedAt === null

  return (
    <div
      data-testid="track-row"
      className="flex items-start gap-3 p-3 rounded-lg border border-border-subtle bg-surface-overlay"
    >
      <GitBranch size={16} className="mt-0.5 shrink-0 text-accent" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-text-primary truncate">{track.branchName}</span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] ${STATE_STYLES[track.status] ?? ''}`}>
            {track.status}
          </span>
          {track.dirty && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-warning/15 text-warning">
              uncommitted changes
            </span>
          )}
          {!track.exists && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-danger/15 text-danger">
              directory missing
            </span>
          )}
          {track.landedAt && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-success-muted text-success">
              landed → {track.landedInto}
            </span>
          )}
        </div>

        <div className="mt-1 text-xs text-text-secondary">
          {track.ownerLabel ?? (track.ownerId ? track.ownerKind : 'no owner — work was retained')}
          {' · '}
          {formatBytes(track.diskBytes)}
          {' · used '}
          {formatWhen(track.lastUsedAt ?? track.createdAt)}
        </div>

        <div className="mt-1 text-[11px] text-text-secondary/70 truncate" title={track.path}>
          {track.path}
        </div>

        {/*
          Named files and named branches, not a count: "3 conflicts" tells you
          nothing you can act on while both tracks are still running.
        */}
        {track.conflicts.length > 0 && (
          <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-warning">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>
              Also being edited elsewhere:{' '}
              {track.conflicts
                .slice(0, 3)
                .map((c) => `${c.filePath} (${c.others.map((o) => o.branchName).join(', ')})`)
                .join(' · ')}
              {track.conflicts.length > 3 && ` · +${track.conflicts.length - 3} more`}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onReveal}
          disabled={busy || !track.exists}
          title="Reveal in file manager"
          className="p-1.5 rounded hover:bg-surface-raised disabled:opacity-40 text-text-secondary"
        >
          <FolderOpen size={14} />
        </button>
        <button
          onClick={onAdopt}
          disabled={busy || !adoptable}
          title={
            adoptable
              ? 'Open this work in a new chat'
              : 'Only retained work with no owner can be adopted'
          }
          className="p-1.5 rounded hover:bg-surface-raised disabled:opacity-40 text-text-secondary"
        >
          <MessageSquarePlus size={14} />
        </button>
        <button
          onClick={onLand}
          disabled={busy || !landable}
          title={
            landable
              ? 'Land this work — commit, then open a PR or merge into the integration branch'
              : track.landedAt
                ? 'Already landed'
                : 'The working tree is gone — nothing to land'
          }
          className="p-1.5 rounded hover:bg-surface-raised disabled:opacity-40 text-text-secondary"
        >
          <GitMerge size={14} />
        </button>
        <button
          onClick={onDiscard}
          disabled={busy}
          title="Discard — deletes the worktree and any uncommitted changes in it"
          className="p-1.5 rounded hover:bg-danger/15 hover:text-danger disabled:opacity-40 text-text-secondary"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

interface TracksSettingsTabProps {
  /** Switch the shell back to the chat view after adopting retained work. */
  onNavigateToChat?: () => void
}

export default function TracksSettingsTab({
  onNavigateToChat
}: TracksSettingsTabProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const loadConversations = useChatStore((s) => s.loadConversations)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const [result, setResult] = useState<TrackListResult | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null)
  const [landingId, setLandingId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const workspaceId = activeWorkspace?.id

  // No synchronous setState here: this runs from an effect, and flipping
  // `isLoading` before the await would be a cascading render. The refresh
  // button raises the spinner itself.
  const load = useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    try {
      setResult(await window.api.trackList({ workspaceId }))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch; state lands after the await
    void load()
  }, [load])

  /**
   * Follow the list as it changes.
   *
   * Fetch-on-mount alone meant a tree retained by a chat closing while this
   * panel was open never showed up — the one moment the user most needs to see
   * that their work survived. `workspaceId: null` is the reaper, which walks
   * every workspace, so it always refreshes.
   */
  useEffect(() => {
    if (!workspaceId) return
    return window.api.onTrackChanged(({ workspaceId: changed }) => {
      if (changed === null || changed === workspaceId) void load()
    })
  }, [workspaceId, load])

  /**
   * Adopt, then take the user to the chat that now owns the tree.
   *
   * Landing back on this list with nothing visibly changed is the version of
   * this feature that still leaves the work feeling lost.
   */
  const adopt = async (trackId: string): Promise<void> => {
    const conversationId = await window.api.trackAdopt({ trackId })
    if (!conversationId || !workspaceId) return
    await loadConversations(workspaceId)
    await selectConversation(conversationId)
    onNavigateToChat?.()
  }

  /**
   * Land a track.
   *
   * A conflict is reported as a message rather than thrown away: both branches
   * survive it, so the honest thing is to say which files collided and leave
   * the decision with the user.
   */
  const land = async (
    track: TrackSummary,
    opts: { commitMessage: string; description?: string; mode: TrackLandingMode }
  ): Promise<void> => {
    const result = await window.api.trackLand({ trackId: track.id, ...opts })
    setLandingId(null)
    if (result.outcome === 'conflicted') {
      setError(
        `"${result.branch}" conflicts with the integration branch` +
          (result.conflictedFiles?.length ? ` in ${result.conflictedFiles.join(', ')}` : '') +
          '. Nothing was merged — both branches are intact.'
      )
    } else if (result.outcome === 'nothing-to-land') {
      setError(`"${result.branch}" has no commits its base branch does not already have.`)
    }
  }

  /**
   * Promote the integration branch to the mainline.
   *
   * `blocked` is reported as an error and everything else as a notice, because
   * blocked is the only outcome where the user has something to do next — a
   * dirty checkout to clean, or a GitHub connection to make.
   */
  const syncMainline = async (): Promise<void> => {
    if (!workspaceId) return
    setSyncing(true)
    setNotice(null)
    setError(null)
    try {
      const result = await window.api.trackSyncMainline({ workspaceId })
      if (result.outcome === 'fast-forwarded') {
        setNotice(
          `${result.baseBranch} fast-forwarded ${result.commitCount} commit` +
            `${result.commitCount === 1 ? '' : 's'} from ${result.integrationBranch}.`
        )
      } else if (result.outcome === 'pull-request') {
        setNotice(
          `Opened ${result.prUrl ?? 'a pull request'} to merge ${result.integrationBranch} into ${result.baseBranch}.`
        )
      } else if (result.outcome === 'up-to-date') {
        setNotice(`${result.baseBranch} already has everything on ${result.integrationBranch}.`)
      } else {
        setError(result.reason ?? 'Nothing was promoted.')
      }
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  const run = async (trackId: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusyId(trackId)
    try {
      await fn()
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  if (!activeWorkspace) return <div />

  const tracks = result?.tracks ?? []
  const overBudget = result ? result.totalBytes > result.budgetBytes : false

  return (
    <div data-testid="tracks-settings" className="max-w-3xl mx-auto px-6 py-8 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Tracks</h2>
          <p className="text-xs text-text-secondary mt-1">
            Each track is one branch in its own working tree. Closing a chat with uncommitted
            changes retains its tree instead of deleting it — retained work shows up here.
          </p>
        </div>
        <button
          onClick={() => {
            setIsLoading(true)
            void load()
          }}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-surface-overlay disabled:opacity-50"
        >
          <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-danger/10 text-danger text-xs">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-success-muted text-success text-xs">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {result?.mainline && (
        <MainlineCard mainline={result.mainline} busy={syncing} onSync={() => void syncMainline()} />
      )}

      {result && (
        <div
          className={`flex items-center gap-2 p-3 rounded-lg text-xs ${
            overBudget ? 'bg-warning/10 text-warning' : 'bg-surface-overlay text-text-secondary'
          }`}
        >
          <HardDrive size={14} className="shrink-0" />
          <span>
            {formatBytes(result.totalBytes)} across {tracks.length} track
            {tracks.length === 1 ? '' : 's'}
            {overBudget && (
              <>
                {' — over the '}
                {formatBytes(result.budgetBytes)} guideline. Nothing is deleted automatically while
                a tree has uncommitted changes; discard the ones you no longer need.
              </>
            )}
          </span>
        </div>
      )}

      {isLoading && !result ? (
        <div className="flex items-center gap-2 text-xs text-text-secondary py-8 justify-center">
          <Loader2 size={14} className="animate-spin" /> Loading tracks…
        </div>
      ) : tracks.length === 0 ? (
        <div className="text-center text-xs text-text-secondary py-8">
          No tracks yet. One appears when a chat with its own branch takes a turn.
        </div>
      ) : (
        <div className="space-y-2">
          {tracks.map((track) => (
            <div key={track.id}>
              <TrackRow
                track={track}
                busy={busyId === track.id}
                onReveal={() =>
                  void run(track.id, () => window.api.trackReveal({ trackId: track.id }))
                }
                onAdopt={() => void run(track.id, () => adopt(track.id))}
                onLand={() => setLandingId(landingId === track.id ? null : track.id)}
                onDiscard={() => setConfirmDiscardId(track.id)}
              />
              {landingId === track.id && (
                <TrackLandingPanel
                  track={track}
                  busy={busyId === track.id}
                  onCancel={() => setLandingId(null)}
                  onLand={(opts) => run(track.id, () => land(track, opts))}
                />
              )}
              {confirmDiscardId === track.id && (
                <div className="mt-1 ml-9 flex items-center gap-3 p-2.5 rounded-lg bg-danger/10 text-xs text-danger">
                  <span>
                    {track.dirty
                      ? 'This tree has uncommitted changes. Discarding deletes them permanently.'
                      : 'Delete this working tree?'}
                  </span>
                  <button
                    onClick={() => {
                      setConfirmDiscardId(null)
                      void run(track.id, () => window.api.trackDiscard({ trackId: track.id }))
                    }}
                    className="px-2 py-1 rounded bg-danger text-white"
                  >
                    Discard
                  </button>
                  <button
                    onClick={() => setConfirmDiscardId(null)}
                    className="px-2 py-1 rounded hover:bg-surface-raised text-text-secondary"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
