import { useEffect, useState, type JSX } from 'react'
import { AlertTriangle, CheckCircle2, GitMerge, HelpCircle, Loader2 } from 'lucide-react'
import type { LandingPreview, TrackLandingMode, TrackSummary } from '../../../../shared/track-types'

/**
 * The decision panel in front of landing.
 *
 * Landing used to be a button with an `onClick` that committed everything
 * uncommitted under the message "Land <branch>", pushed, and either opened a PR
 * or merged into an integration branch — with the user finding out which one
 * afterwards, from the error message if it went wrong. Every input to that
 * decision was already knowable beforehand.
 *
 * Three of them are worth the panel on their own:
 *
 *  - the commit message, which was auto-generated and is the permanent record
 *    of the work;
 *  - the mode, which decides between "a PR appears on GitHub" and "this merges
 *    into a local branch" — very different acts, previously chosen by a setting
 *    most users never see;
 *  - whether it will conflict, which `git merge-tree` answers without merging
 *    anything.
 */

interface TrackLandingPanelProps {
  track: TrackSummary
  busy: boolean
  onCancel: () => void
  onLand: (opts: {
    commitMessage: string
    description?: string
    mode: TrackLandingMode
  }) => Promise<void>
}

const MODES: { mode: TrackLandingMode; label: string; hint: string }[] = [
  {
    mode: 'independent',
    label: 'Push & open a PR',
    hint: 'Pushes the branch and opens a pull request against its base'
  },
  {
    mode: 'integration',
    label: 'Merge locally',
    hint: "Merges into this workspace's integration branch, in a tree you are not standing in"
  }
]

export function TrackLandingPanel({
  track,
  busy,
  onCancel,
  onLand
}: TrackLandingPanelProps): JSX.Element {
  const [commitMessage, setCommitMessage] = useState(`Land ${track.branchName}`)
  const [description, setDescription] = useState('')
  /**
   * The mode the user explicitly picked, or null while the default stands.
   *
   * Deliberately not seeded from the preview: storing the resolved default here
   * would make the effect below depend on state it sets itself, and the panel
   * would preview twice every time it opened.
   */
  const [requestedMode, setRequestedMode] = useState<TrackLandingMode | null>(null)
  const [preview, setPreview] = useState<LandingPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Re-previews when the user picks a mode, because almost everything shown
  // depends on it: a different target branch, therefore a different commit
  // count and a different conflict forecast. Sending no mode on the first pass
  // asks the main process to resolve the default and report which it chose.
  useEffect(() => {
    let cancelled = false
    window.api
      .trackLandPreview({ trackId: track.id, ...(requestedMode ? { mode: requestedMode } : {}) })
      .then((result) => {
        if (cancelled) return
        setPreview(result)
        setError(null)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [track.id, requestedMode])

  /** What is actually in force: the user's pick, else whatever the preview resolved. */
  const mode = requestedMode ?? preview?.mode ?? null
  const canLand = preview !== null && !preview.nothingToLand && commitMessage.trim().length > 0

  return (
    <div
      data-testid="track-landing-panel"
      className="mt-1 ml-9 p-3 rounded-lg bg-surface-overlay space-y-3"
    >
      <div className="space-y-1.5">
        <label className="text-[10px] font-medium text-text-muted uppercase tracking-wide block">
          Commit message
        </label>
        <input
          type="text"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          data-testid="track-landing-message"
          className="w-full bg-surface-base border border-border-subtle rounded-lg px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Description (optional) — becomes the commit body and the PR description"
          className="w-full bg-surface-base border border-border-subtle rounded-lg px-2 py-1.5 text-xs text-text-primary resize-none focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      <div className="grid grid-cols-2 gap-1">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            title={m.hint}
            onClick={() => setRequestedMode(m.mode)}
            disabled={busy}
            className={`px-2 py-1.5 text-[10px] rounded border text-left transition-colors disabled:opacity-40 ${
              mode === m.mode
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border-subtle text-text-secondary hover:text-text-primary'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-[11px] text-danger">Could not preview this landing ({error}).</p>
      )}

      {!preview && !error && (
        <div className="flex items-center gap-1.5 text-[11px] text-text-muted">
          <Loader2 size={11} className="animate-spin" />
          Checking what this would do…
        </div>
      )}

      {preview && <LandingSummary preview={preview} />}

      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            if (!mode) return
            void onLand({
              commitMessage: commitMessage.trim(),
              description: description.trim() || undefined,
              mode
            })
          }}
          disabled={!canLand || busy || !mode}
          data-testid="track-landing-confirm"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-accent text-white text-xs disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <GitMerge size={12} />}
          Land
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-2.5 py-1 rounded text-xs text-text-secondary hover:bg-surface-raised disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/** What is about to happen, in the order a user asks about it. */
function LandingSummary({ preview }: { preview: LandingPreview }): JSX.Element {
  if (preview.nothingToLand) {
    return (
      <p className="text-[11px] text-text-muted">
        Nothing to land — {preview.branch} has no commits {preview.target} does not already have,
        and its working tree is clean.
      </p>
    )
  }

  return (
    <div className="space-y-1.5 text-[11px]">
      <p className="text-text-secondary">
        {preview.commitCount === 0
          ? 'No commits yet'
          : `${preview.commitCount} commit${preview.commitCount === 1 ? '' : 's'}`}
        {preview.uncommittedFiles.length > 0 && (
          <>
            {' + '}
            {preview.uncommittedFiles.length} uncommitted file
            {preview.uncommittedFiles.length === 1 ? '' : 's'} (committed first)
          </>
        )}
        {' → '}
        <span className="text-text-primary font-medium">{preview.target}</span>
      </p>

      {/* Said out loud because the alternative is a user waiting for a PR that
          was never going to appear: no remote to push to, or no GitHub token. */}
      {preview.mode === 'independent' && !preview.hasRemote && (
        <p className="text-text-muted">
          This repository has no remote, so nothing is pushed — the work is committed to the branch
          and stays local.
        </p>
      )}
      {preview.mode === 'independent' && preview.hasRemote && !preview.opensPullRequest && (
        <p className="text-text-muted">
          GitHub is not configured for this workspace, so the branch is pushed but no pull request
          is opened.
        </p>
      )}

      {preview.forecast === 'clean' && (
        <p className="flex items-center gap-1 text-success">
          <CheckCircle2 size={11} className="shrink-0" />
          Merges cleanly into {preview.target}.
        </p>
      )}

      {preview.forecast === 'conflicts' && (
        <div className="flex items-start gap-1 text-warning">
          <AlertTriangle size={11} className="mt-px shrink-0" />
          <span>
            Conflicts with {preview.target} in {preview.conflictFiles.join(', ')}. Landing stops
            before merging and leaves both branches exactly as they are.
          </span>
        </div>
      )}

      {/* Not folded into "clean": this is "we could not check", and promising a
          clean merge we never verified is how a user gets ambushed. */}
      {preview.forecast === 'unknown' && (
        <p className="flex items-start gap-1 text-text-muted">
          <HelpCircle size={11} className="mt-px shrink-0" />
          Could not check for conflicts against {preview.target} — it may not exist locally yet.
        </p>
      )}
    </div>
  )
}

export default TrackLandingPanel
