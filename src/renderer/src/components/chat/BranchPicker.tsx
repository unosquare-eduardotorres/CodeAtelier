import { useState, useEffect, useCallback } from 'react'
import { GitBranch, Loader2 } from 'lucide-react'

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
  /** Unique ID suffix for datalist (prevents DOM collision) */
  datalistId: string
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
  datalistId
}: BranchPickerProps): React.JSX.Element {
  const [branches, setBranches] = useState<{
    local: string[]
    remote: string[]
    current: string
  } | null>(null)
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  // Load branches when mode is 'custom' and we have a workspace
  useEffect(() => {
    if (mode !== 'custom' || !workspaceId) return
    let cancelled = false

    setBranchesLoading(true)
    window.api
      .listBranches({ workspaceId })
      .then((result) => {
        if (cancelled) return
        setBranches(result)
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
  }, [mode, workspaceId])

  const handleCustomNameChange = useCallback(
    (value: string) => {
      onCustomBranchNameChange(value)
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
    },
    [onCustomBranchNameChange]
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
            name={`branch-mode-${datalistId}`}
            value="none"
            checked={mode === 'none'}
            onChange={() => onModeChange('none')}
            className="w-3.5 h-3.5 border-border-subtle bg-surface-overlay text-primary focus:ring-primary/30 focus:ring-2 cursor-pointer"
          />
          No branch
        </label>

        {/* Auto-create from title */}
        <label className={`${radioBase} ${mode === 'auto' ? radioActive : radioInactive}`}>
          <input
            type="radio"
            name={`branch-mode-${datalistId}`}
            value="auto"
            checked={mode === 'auto'}
            onChange={() => onModeChange('auto')}
            className="w-3.5 h-3.5 border-border-subtle bg-surface-overlay text-primary focus:ring-primary/30 focus:ring-2 cursor-pointer"
          />
          Auto-create from title
          <span className="text-xs text-text-muted">(chat/your-title-abc123)</span>
        </label>

        {/* Select or create branch */}
        <label className={`${radioBase} ${mode === 'custom' ? radioActive : radioInactive}`}>
          <input
            type="radio"
            name={`branch-mode-${datalistId}`}
            value="custom"
            checked={mode === 'custom'}
            onChange={() => onModeChange('custom')}
            className="w-3.5 h-3.5 border-border-subtle bg-surface-overlay text-primary focus:ring-primary/30 focus:ring-2 cursor-pointer"
          />
          Select or create branch
        </label>

        {/* Branch name input — shown only when custom is selected */}
        {mode === 'custom' && (
          <div className="ml-5 mt-1.5">
            <div className="relative">
              <input
                type="text"
                list={`branch-options-${datalistId}`}
                value={customBranchName}
                onChange={(e) => handleCustomNameChange(e.target.value)}
                placeholder="e.g., feature/my-branch"
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
            {branches && (
              <datalist id={`branch-options-${datalistId}`}>
                {branches.local.map((b) => (
                  <option key={`local:${b}`} value={b} />
                ))}
                {branches.remote
                  .filter((b) => !branches.local.includes(b))
                  .map((b) => (
                    <option key={`remote:${b}`} value={b} />
                  ))}
              </datalist>
            )}
            {validationError && <p className="text-xs text-danger mt-1">{validationError}</p>}
            {!validationError && customBranchName && branches && (
              <p className="text-xs text-text-muted mt-1">
                {branches.local.includes(customBranchName)
                  ? 'Will check out existing branch'
                  : 'Will create a new branch'}
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
