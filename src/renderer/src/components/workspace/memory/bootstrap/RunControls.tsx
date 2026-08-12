/**
 * RunControls — mode cards, scope selector and the start/pause/resume/cancel
 * buttons.
 *
 * The scope selector replaces the old "Force full re-scan" checkbox, which was
 * the only way to re-read anything and did so by deleting every stored file
 * hash in the workspace. Scopes ignore the hash gate for the phase you name
 * instead of destroying the record.
 */

import { Brain, Sparkles, Zap, X, PauseCircle, PlayCircle, AlertTriangle } from 'lucide-react'
import { Button, Tooltip } from '@renderer/components/common/ui'
import type { BootstrapMode, BootstrapScope } from '../../../../../../shared/types'
import { PHASE_INFO, DEEP_SCAN_PHASES, FULL_PHASES } from './phase-meta'

const SCOPES: Array<{ id: BootstrapScope; label: string; hint: string }> = [
  {
    id: 'changed',
    label: 'Changed only',
    hint: 'Skip files whose contents have not changed since the last run.'
  },
  {
    id: 'docs',
    label: 'Re-ingest all docs',
    hint: 'Re-read every documentation file, even unchanged ones.'
  },
  {
    id: 'deep-scan',
    label: 'Re-run Deep Scan',
    hint: 'Re-read the PageRank-central source files.'
  },
  { id: 'full', label: 'Full rebuild', hint: 'Ignore every hash and re-read everything. Slowest.' }
]

/**
 * Phases as a numbered pipeline rather than a flat row of bordered pills —
 * those read as buttons even though they are progress state.
 */
function PhaseStepper({ phases }: { phases: readonly string[] }): React.JSX.Element {
  return (
    <ol className="flex items-center flex-wrap gap-y-1.5">
      {phases.map((phase, i) => (
        <li key={phase} className="flex items-center">
          <Tooltip content={PHASE_INFO[phase]?.description ?? phase}>
            <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
              <span className="flex items-center justify-center w-4 h-4 rounded-full border border-border-default font-mono text-[11px] tabular-nums">
                {i + 1}
              </span>
              {PHASE_INFO[phase]?.label ?? phase}
            </span>
          </Tooltip>
          {i < phases.length - 1 && (
            <span className="w-4 h-px mx-1.5 bg-border-default" aria-hidden="true" />
          )}
        </li>
      ))}
    </ol>
  )
}

export default function RunControls({
  mode,
  scope,
  onModeChange,
  onScopeChange,
  onStart,
  onPause,
  onResume,
  onCancel,
  onDismiss,
  jobStatus,
  canStart,
  resumableRunId
}: {
  mode: BootstrapMode
  scope: BootstrapScope
  onModeChange: (mode: BootstrapMode) => void
  onScopeChange: (scope: BootstrapScope) => void
  onStart: () => void
  onPause: () => void
  onResume: (runId: string) => void
  onCancel: () => void
  onDismiss: () => void
  jobStatus: 'idle' | 'planning' | 'running' | 'paused' | 'done' | 'cancelled' | 'error'
  canStart: boolean
  resumableRunId: string | null
}): React.JSX.Element {
  const isActive = jobStatus === 'running' || jobStatus === 'planning'
  const isPaused = jobStatus === 'paused'
  const isFinished = jobStatus === 'done' || jobStatus === 'cancelled' || jobStatus === 'error'

  // ── In-flight / paused: control buttons only ──
  if (isActive || isPaused) {
    return (
      <div className="space-y-2">
        <div className="flex justify-end gap-2">
          {isActive && (
            <Button data-testid="bootstrap-pause" variant="secondary" onClick={onPause}>
              <PauseCircle className="w-3.5 h-3.5" />
              Pause
            </Button>
          )}
          {isPaused && resumableRunId && (
            <Button
              data-testid="bootstrap-resume"
              variant="primary"
              onClick={() => onResume(resumableRunId)}
            >
              <PlayCircle className="w-3.5 h-3.5" />
              Resume
            </Button>
          )}
          <Button data-testid="bootstrap-cancel" variant="danger" onClick={onCancel}>
            <X className="w-3 h-3" />
            Cancel
          </Button>
        </div>
        {isActive && mode === 'deep-scan' && (
          <p className="text-[11px] text-text-muted text-right">
            Pause takes effect after the current agent step — the exploration agent runs as an
            external process and cannot be interrupted mid-turn.
          </p>
        )}
      </div>
    )
  }

  // ── Finished: dismiss + start again ──
  const phases = mode === 'deep-scan' ? DEEP_SCAN_PHASES : FULL_PHASES

  return (
    <div className="space-y-3">
      {isFinished && (
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      )}

      {/* Mode cards */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onModeChange('full')}
          aria-pressed={mode === 'full'}
          className={`p-3 rounded-lg border text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus ${
            mode === 'full'
              ? 'border-teal bg-teal/5'
              : 'border-border-default hover:border-border-strong'
          }`}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <Zap className={`w-4 h-4 ${mode === 'full' ? 'text-teal' : 'text-text-muted'}`} />
            <span className="text-sm font-medium text-text-primary">Feed Brain</span>
          </div>
          <p className="text-xs text-text-muted">
            Deterministic scan — docs, stack, PageRank architecture, git history, structural
            gotchas.
          </p>
        </button>

        <button
          type="button"
          onClick={() => onModeChange('deep-scan')}
          aria-pressed={mode === 'deep-scan'}
          className={`p-3 rounded-lg border text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus ${
            mode === 'deep-scan'
              ? 'border-primary bg-primary-muted'
              : 'border-border-default hover:border-border-strong'
          }`}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <Sparkles
              className={`w-4 h-4 ${mode === 'deep-scan' ? 'text-primary-text' : 'text-text-muted'}`}
            />
            <span className="text-sm font-medium text-text-primary">Deep Scan</span>
          </div>
          <p className="text-xs text-text-muted">
            AI agent explores the codebase interactively — more thorough, uses API tokens.
          </p>
        </button>
      </div>

      {/* Phase pipeline */}
      <PhaseStepper phases={phases} />

      {/* Scope selector */}
      <div className="space-y-1.5">
        <span className="text-[11px] uppercase tracking-wider text-text-muted">Scope</span>
        <div className="flex flex-wrap gap-1.5">
          {SCOPES.map((s) => (
            <Tooltip key={s.id} content={s.hint}>
              <button
                type="button"
                data-testid={`bootstrap-scope-${s.id}`}
                onClick={() => onScopeChange(s.id)}
                aria-pressed={scope === s.id}
                className={`px-2 py-1 text-xs rounded border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus ${
                  scope === s.id
                    ? 'border-teal bg-teal/10 text-teal'
                    : 'border-border-default text-text-muted hover:text-text-secondary'
                }`}
              >
                {s.label}
              </button>
            </Tooltip>
          ))}
        </div>
        <p className="text-[11px] text-text-muted">{SCOPES.find((s) => s.id === scope)?.hint}</p>
      </div>

      {/* Start */}
      <Button
        data-testid="bootstrap-start"
        variant="primary"
        size="md"
        onClick={onStart}
        disabled={!canStart}
        className={mode === 'deep-scan' ? '' : '!bg-teal !border-teal hover:!bg-teal/80'}
      >
        {mode === 'deep-scan' ? <Sparkles className="w-4 h-4" /> : <Brain className="w-4 h-4" />}
        {mode === 'deep-scan' ? 'Start Deep Scan' : 'Feed Brain'}
      </Button>

      {mode === 'deep-scan' && (
        <p className="text-xs text-warning">
          <AlertTriangle className="w-3 h-3 inline mr-1" />
          Deep Scan spawns a Claude agent session — this will consume API tokens (est. ~$0.10–0.50).
        </p>
      )}
    </div>
  )
}
