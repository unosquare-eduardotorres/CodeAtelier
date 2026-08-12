/**
 * Which branch a new chat works on.
 *
 * The existing branches used to live in a native `<datalist>`: no dropdown
 * arrow, nothing rendered until you typed, and the list only loaded once
 * "Select or create branch" was already chosen. The control read as a
 * type-a-new-name box, so the honest answer to "where is the branch list" was
 * that there wasn't a visible one. It is now an always-loaded, always-visible
 * list, and the text input filters it as well as naming a new branch.
 *
 * Held branches are shown, never hidden. A branch missing from a list the user
 * can see in their own terminal reads as a bug and leaves them no way to find
 * out who has it — the same rule `branch-options.ts` states for blueprints.
 * Taking one is legal and sometimes exactly what is wanted (a finished
 * blueprint's branch, continued in a chat), so it is offered behind an explicit
 * confirmation rather than refused or done silently.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { GitBranch, Loader2, Check } from 'lucide-react'
import type { BlueprintBranchOptions } from '../../../../shared/blueprint-types'

export type BranchMode = 'none' | 'auto' | 'custom'

interface BranchPickerProps {
  /** Current branch mode selection */
  mode: BranchMode
  /** Callback when mode changes */
  onModeChange: (mode: BranchMode) => void
  /** Custom branch name entered by user */
  customBranchName: string
  /** Callback when custom branch name changes */
  onCustomBranchNameChange: (name: string) => void
  /** Workspace ID for loading branch list */
  workspaceId?: string
  /** Whether gitAutoBranch is enabled at workspace level */
  gitAutoBranch?: boolean
  /** Unique ID suffix for radio group names (prevents DOM collision) */
  idSuffix: string
  /** User confirmed taking the selected branch from its current holder */
  takeover?: boolean
  /** Callback when the take-over confirmation changes */
  onTakeoverChange?: (takeover: boolean) => void
}

/** Regex for valid git branch name characters */
const GIT_BRANCH_REGEX = /^[a-zA-Z0-9/_.-]*$/
/** Patterns git rejects even when individual characters are valid */
const GIT_BRANCH_INVALID = /^\.|\.\.|\.$|\.lock$|^\/|\/$|\/\/|@\{/

export default function BranchPicker({
  mode,
  onModeChange,
  customBranchName,
  onCustomBranchNameChange,
  workspaceId,
  gitAutoBranch,
  idSuffix,
  takeover = false,
  onTakeoverChange
}: BranchPickerProps): React.JSX.Element {
  const [options, setOptions] = useState<BlueprintBranchOptions | null>(null)
  // Initialised true rather than set true inside the effect: a synchronous
  // setState in an effect body is a cascading render, and the initial value
  // already covers the only load this component does.
  const [branchesLoading, setBranchesLoading] = useState(Boolean(workspaceId))
  const [validationError, setValidationError] = useState<string | null>(null)

  // Loaded on mount, not on mode change: a list that only appears after the
  // user has already committed to "custom" cannot be what tells them the
  // option exists.
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false

    window.api
      .chatBranchOptions({ workspaceId })
      .then((result) => {
        if (cancelled) return
        setOptions(result)
        setBranchesLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        console.warn('[BranchPicker] Failed to load branches:', err)
        setBranchesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const branches = useMemo(() => options?.branches ?? [], [options])
  const selected = branches.find((b) => b.name === customBranchName) ?? null

  const filtered = useMemo(() => {
    const q = customBranchName.trim().toLowerCase()
    if (!q) return branches
    return branches.filter((b) => b.name.toLowerCase().includes(q))
  }, [branches, customBranchName])

  const validate = useCallback((value: string) => {
    if (value && !GIT_BRANCH_REGEX.test(value)) {
      setValidationError('Branch names can only contain letters, numbers, /, _, ., and -')
    } else if (value && value.startsWith('-')) {
      setValidationError('Branch name cannot start with -')
    } else if (value && GIT_BRANCH_INVALID.test(value)) {
      setValidationError(
        'Invalid branch name — cannot start/end with . or /, contain .., or end with .lock'
      )
    } else {
      setValidationError(null)
    }
  }, [])

  // Any change of branch clears the confirmation. Take-over is granted for one
  // specific branch and one specific holder; carrying a tick across a change of
  // selection would hand over a tree the user never agreed to take.
  const changeBranch = useCallback(
    (value: string) => {
      onCustomBranchNameChange(value)
      onTakeoverChange?.(false)
      validate(value)
    },
    [onCustomBranchNameChange, onTakeoverChange, validate]
  )

  const changeMode = useCallback(
    (next: BranchMode) => {
      onModeChange(next)
      if (next !== 'custom') onTakeoverChange?.(false)
    },
    [onModeChange, onTakeoverChange]
  )

  const radioBase = 'flex items-center gap-2 cursor-pointer text-sm transition-colors'
  const radioActive = 'text-text-primary'
  const radioInactive = 'text-text-secondary hover:text-text-primary'

  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-2">
        <span className="flex items-center gap-1.5">
          <GitBranch size={14} />
          Branch
        </span>
      </label>

      <div className="space-y-2 pl-0.5">
        {/* No branch */}
        <label className={`${radioBase} ${mode === 'none' ? radioActive : radioInactive}`}>
          <input
            type="radio"
            name={`branch-mode-${idSuffix}`}
            value="none"
            checked={mode === 'none'}
            onChange={() => changeMode('none')}
            className="w-3.5 h-3.5 border-border-subtle bg-surface-overlay text-primary focus:ring-primary/30 focus:ring-2 cursor-pointer"
          />
          No branch
        </label>

        {/* Auto-create from title */}
        <label className={`${radioBase} ${mode === 'auto' ? radioActive : radioInactive}`}>
          <input
            type="radio"
            name={`branch-mode-${idSuffix}`}
            value="auto"
            checked={mode === 'auto'}
            onChange={() => changeMode('auto')}
            className="w-3.5 h-3.5 border-border-subtle bg-surface-overlay text-primary focus:ring-primary/30 focus:ring-2 cursor-pointer"
          />
          Auto-create from title
          <span className="text-xs text-text-muted">(chat/your-title-abc123)</span>
        </label>

        {/* Select or create branch */}
        <label className={`${radioBase} ${mode === 'custom' ? radioActive : radioInactive}`}>
          <input
            type="radio"
            name={`branch-mode-${idSuffix}`}
            value="custom"
            checked={mode === 'custom'}
            onChange={() => changeMode('custom')}
            className="w-3.5 h-3.5 border-border-subtle bg-surface-overlay text-primary focus:ring-primary/30 focus:ring-2 cursor-pointer"
          />
          Select or create branch
          {branches.length > 0 && (
            <span className="text-xs text-text-muted">({branches.length} existing)</span>
          )}
        </label>

        {/* Branch name input + list — shown only when custom is selected */}
        {mode === 'custom' && (
          <div className="ml-5 mt-1.5">
            <div className="relative">
              <input
                type="text"
                value={customBranchName}
                onChange={(e) => changeBranch(e.target.value)}
                placeholder="Filter branches, or type a new name"
                className="w-full px-3 py-2 bg-surface-overlay border border-border-subtle rounded-lg text-text-primary text-sm font-mono placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
                autoComplete="off"
              />
              {branchesLoading && (
                <Loader2
                  size={14}
                  className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-text-muted"
                />
              )}
            </div>

            {options && !options.repoHasCommits && (
              <p className="text-xs text-text-muted mt-1.5">
                This repository has no commits yet, so there are no branches to pick from.
              </p>
            )}

            {branches.length > 0 && (
              <div
                data-testid="branch-list"
                className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-border-subtle bg-surface-overlay divide-y divide-border-subtle/50"
              >
                {filtered.length === 0 && (
                  <p className="px-3 py-2 text-xs text-text-muted">
                    No existing branch matches — this will create a new one.
                  </p>
                )}
                {filtered.map((b) => {
                  const isSelected = b.name === customBranchName
                  return (
                    <button
                      key={b.name}
                      type="button"
                      onClick={() => changeBranch(b.name)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs font-mono transition-colors ${
                        isSelected
                          ? 'bg-primary/10 text-text-primary'
                          : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
                      }`}
                    >
                      {isSelected ? (
                        <Check size={12} className="shrink-0 text-primary" />
                      ) : (
                        <span className="w-3 shrink-0" />
                      )}
                      <span className="truncate">{b.name}</span>
                      {b.isPrimaryHead && (
                        <span className="ml-auto shrink-0 px-1.5 py-px rounded text-[10px] font-sans bg-surface-raised text-text-muted">
                          current
                        </span>
                      )}
                      {b.heldBy && (
                        <span
                          className={`shrink-0 px-1.5 py-px rounded text-[10px] font-sans bg-warning/15 text-warning ${
                            b.isPrimaryHead ? '' : 'ml-auto'
                          }`}
                        >
                          held by {b.heldBy.label ?? b.heldBy.ownerKind}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {validationError && <p className="text-xs text-danger mt-1">{validationError}</p>}

            {!validationError && customBranchName && options && (
              <p className="text-xs text-text-muted mt-1">
                {selected ? 'Will check out existing branch' : 'Will create a new branch'}
              </p>
            )}

            {/* Explicit hand-over. Never implicit: the previous owner keeps the
                tree — and every uncommitted file in it — until this is ticked. */}
            {selected?.heldBy && (
              <label className="flex items-start gap-2 mt-2 text-xs text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={takeover}
                  onChange={(e) => onTakeoverChange?.(e.target.checked)}
                  className="mt-0.5 w-3.5 h-3.5 rounded border-border-subtle bg-surface-overlay text-primary focus:ring-primary/30 focus:ring-2 cursor-pointer"
                />
                <span>
                  Take over from {selected.heldBy.label ?? selected.heldBy.ownerKind}. This chat
                  continues in their working directory, with the files they left in it. Refused
                  while that work is mid-turn.
                </span>
              </label>
            )}

            {selected?.heldBy && !takeover && (
              <p className="text-xs text-warning mt-1">
                {selected.heldBy.label ?? 'Other work'} holds this branch — without taking it over,
                this chat cannot write to it.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Hint about workspace default */}
      {gitAutoBranch && mode === 'none' && (
        <p className="text-xs text-text-muted mt-1.5 ml-0.5">
          Workspace has auto-branch enabled — override it here or leave as &quot;No branch&quot;
        </p>
      )}
    </div>
  )
}
