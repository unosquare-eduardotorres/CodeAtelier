/**
 * BlueprintBranchPicker — which branch a blueprint run works on.
 *
 * Chats have had a branch picker since they were given worktrees; blueprints
 * had none and always got `blueprint/<slug>-<id8>`. That asymmetry is the whole
 * reason this exists, so the vocabulary deliberately mirrors the chat one
 * rather than inventing a second set of words for the same idea.
 *
 * Two things are surfaced at pick time rather than left to be discovered:
 *
 *  - a branch the workspace checkout is sitting on cannot be checked out twice,
 *    so choosing it means running in the shared tree with no isolation;
 *  - a branch another chat or blueprint holds will be TAKEN from them when the
 *    run starts.
 *
 * Both are legal and sometimes wanted. Neither should be a surprise.
 */

import { useState, useEffect, useCallback, type JSX } from 'react'
import { GitBranch, AlertTriangle, Loader2 } from 'lucide-react'
import { summariseResolvedBase } from '../../../../../shared/blueprint-base-summary'
import type {
  BlueprintBranchChoice,
  BlueprintBranchMode,
  BlueprintBranchOptions,
  ResolvedBlueprintBase
} from '../../../../../shared/blueprint-types'

interface BlueprintBranchPickerProps {
  workspaceId: string
  value: BlueprintBranchChoice
  onChange: (choice: BlueprintBranchChoice) => void
}

const MODE_LABELS: { mode: BlueprintBranchMode; label: string; hint: string }[] = [
  // Deliberately no longer "cut from your HEAD": that stopped being true the
  // moment a base could be pinned or upgraded to an integration branch, and the
  // resolved-base line below states the real answer instead of predicting it.
  {
    mode: 'auto',
    label: 'New branch',
    hint: 'Named after this blueprint, cut from the base below'
  },
  { mode: 'fork', label: 'Branch from…', hint: 'A new branch taken from one you choose' },
  { mode: 'takeover', label: 'Work on…', hint: 'Continue an existing branch, taking it over' },
  { mode: 'primary', label: 'Workspace checkout', hint: 'No separate worktree' }
]

export function BlueprintBranchPicker({
  workspaceId,
  value,
  onChange
}: BlueprintBranchPickerProps): JSX.Element {
  const [options, setOptions] = useState<BlueprintBranchOptions | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [resolvedBase, setResolvedBase] = useState<ResolvedBlueprintBase | null>(null)

  useEffect(() => {
    let cancelled = false
    // No synchronous `setLoading(true)` here: the initial state already covers
    // the mount, and setting state in an effect body triggers a cascading
    // render. A workspace switch remounts this view, so there is no second
    // fetch to show a spinner for.
    window.api
      .blueprintBranchOptions({ workspaceId })
      .then((result) => {
        if (cancelled) return
        setOptions(result)
        setError(null)
        // A repo with no commits has nothing to branch from and no branches to
        // show. Preselecting `primary` with the reason visible is honest;
        // presenting an empty dropdown reads as a loading failure.
        if (!result.repoHasCommits) onChange({ mode: 'primary' })
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `onChange` is intentionally excluded — including it re-runs the query on
    // every parent render, and the preselect above must happen exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId])

  // Only `auto` and `fork` cut a new branch, so only they have a base to
  // resolve. Re-asked when the fork target changes, because the integration
  // upgrade is a property of the chosen base rather than of the workspace.
  const forkTarget = value.mode === 'fork' ? (value.branch ?? null) : null
  const resolvesBase = value.mode === 'auto' || value.mode === 'fork'

  useEffect(() => {
    // Not cleared for the modes that have no base: clearing here would be a
    // synchronous setState in an effect body (cascading render), and the render
    // below already gates on the mode, so a value left behind is unreachable.
    if (!resolvesBase) return
    let cancelled = false
    window.api
      .blueprintResolveBase({
        workspaceId,
        choice: forkTarget ? { mode: 'fork', branch: forkTarget } : { mode: 'auto' }
      })
      .then((result) => {
        if (!cancelled) setResolvedBase(result)
      })
      .catch(() => {
        // The picker still works without it — this line is explanation, not a
        // control, so a failure hides it rather than shouting.
        if (!cancelled) setResolvedBase(null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, resolvesBase, forkTarget])

  const selectMode = useCallback(
    (mode: BlueprintBranchMode) => {
      // Carry the branch across fork/takeover so switching between them does
      // not silently discard a choice the user already made.
      onChange(mode === 'auto' || mode === 'primary' ? { mode } : { mode, branch: value.branch })
    },
    [onChange, value.branch]
  )

  const branches = options?.branches ?? []
  const needsBranch = value.mode === 'fork' || value.mode === 'takeover'
  const selected = branches.find((b) => b.name === value.branch)
  const noCommits = options !== null && !options.repoHasCommits

  return (
    <div className="space-y-2">
      <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide flex items-center gap-1">
        <GitBranch size={11} />
        Branch
      </span>

      {loading && (
        <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
          <Loader2 size={11} className="animate-spin" />
          Reading branches…
        </div>
      )}

      {error && (
        <p className="text-[10px] text-danger">
          Could not read branches ({error}). This blueprint will use a new branch.
        </p>
      )}

      {noCommits && (
        <p className="text-[10px] text-text-muted">
          This repository has no commits yet, so there is nothing to branch from. The blueprint will
          run in your workspace checkout.
        </p>
      )}

      <div className="grid grid-cols-2 gap-1">
        {MODE_LABELS.map((m) => (
          <button
            key={m.mode}
            type="button"
            title={m.hint}
            disabled={noCommits && m.mode !== 'primary'}
            onClick={(e) => {
              e.stopPropagation()
              selectMode(m.mode)
            }}
            className={`px-2 py-1 text-[10px] rounded border transition-colors text-left disabled:opacity-30 disabled:cursor-not-allowed ${
              value.mode === m.mode
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-border-subtle text-text-secondary hover:text-text-primary'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {needsBranch && !noCommits && (
        <select
          value={value.branch ?? ''}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onChange({ ...value, branch: e.target.value || undefined })}
          className="w-full bg-surface-base border border-border-subtle rounded-lg px-2 py-1 text-[11px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">
            {value.mode === 'fork' ? 'Choose a base branch…' : 'Choose a branch to take over…'}
          </option>
          {branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
              {b.heldBy ? ` — held by ${b.heldBy.label ?? b.heldBy.ownerKind}` : ''}
            </option>
          ))}
        </select>
      )}

      {/*
        Where this run will actually start, for every mode. R4: a configured
        base nobody can see before BUILD is the same as no base at all — the
        point is to notice a wrong one before an hour of agents runs against it.
      */}
      {!noCommits && !loading && (
        <p data-testid="blueprint-resolved-base" className="text-[10px] text-text-muted">
          {value.mode === 'primary' ? (
            <>
              Runs in your workspace checkout
              {options?.currentBranch ? ` (${options.currentBranch})` : ''} — no separate branch.
            </>
          ) : value.mode === 'takeover' ? (
            value.branch ? (
              <>Continues {value.branch} from its own tip — nothing is forked.</>
            ) : null
          ) : resolvedBase ? (
            summariseResolvedBase(resolvedBase)
          ) : null}
        </p>
      )}

      {/* Taking a branch the checkout is on is legal, and means no isolation. */}
      {value.mode === 'takeover' && selected?.isPrimaryHead && (
        <p className="text-[10px] text-warning flex items-start gap-1">
          <AlertTriangle size={11} className="mt-px shrink-0" />
          Your workspace checkout is on {selected.name}, so it cannot be checked out separately. The
          blueprint will run in your checkout instead.
        </p>
      )}

      {value.mode === 'takeover' && selected?.heldBy && !selected.isPrimaryHead && (
        <p className="text-[10px] text-text-muted">
          {selected.heldBy.label ?? 'Other work'} holds this branch. The blueprint will take it over
          when it starts, and will be refused while that work is mid-turn.
        </p>
      )}
    </div>
  )
}

export default BlueprintBranchPicker
