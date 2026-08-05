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
import type { BootstrapMode, BootstrapScope } from '../../../../../../shared/types'
import { PHASE_INFO, DEEP_SCAN_PHASES, FULL_PHASES } from './phase-meta'

const SCOPES: Array<{ id: BootstrapScope; label: string; hint: string }> = [
  { id: 'changed', label: 'Changed only', hint: 'Skip files whose contents have not changed since the last run.' },
  { id: 'docs', label: 'Re-ingest all docs', hint: 'Re-read every documentation file, even unchanged ones.' },
  { id: 'deep-scan', label: 'Re-run Deep Scan', hint: 'Re-read the PageRank-central source files.' },
  { id: 'full', label: 'Full rebuild', hint: 'Ignore every hash and re-read everything. Slowest.' }
]

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
            <button
              data-testid="bootstrap-pause"
              onClick={onPause}
              className="flex items-center gap-1 px-2.5 py-1 text-xs bg-purple-500/10 text-purple-400 rounded hover:bg-purple-500/20"
            >
              <PauseCircle className="w-3.5 h-3.5" />
              Pause
            </button>
          )}
          {isPaused && resumableRunId && (
            <button
              data-testid="bootstrap-resume"
              onClick={() => onResume(resumableRunId)}
              className="flex items-center gap-1 px-2.5 py-1 text-xs bg-teal/10 text-teal rounded hover:bg-teal/20"
            >
              <PlayCircle className="w-3.5 h-3.5" />
              Resume
            </button>
          )}
          <button
            data-testid="bootstrap-cancel"
            onClick={onCancel}
            className="flex items-center gap-1 px-2.5 py-1 text-xs bg-red-500/10 text-red-400 rounded hover:bg-red-500/20"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
        </div>
        {isActive && mode === 'deep-scan' && (
          <p className="text-[10px] text-text-muted text-right">
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
          <button
            onClick={onDismiss}
            className="px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary rounded hover:bg-surface-overlay"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Mode cards */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => onModeChange('full')}
          className={`p-3 rounded-lg border text-left transition-colors ${
            mode === 'full' ? 'border-teal bg-teal/5' : 'border-border-default hover:border-border-active'
          }`}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <Zap className={`w-4 h-4 ${mode === 'full' ? 'text-teal' : 'text-text-muted'}`} />
            <span className="text-sm font-medium text-text-primary">Feed Brain</span>
          </div>
          <p className="text-xs text-text-muted">
            Deterministic scan — docs, stack, PageRank architecture, git history, structural gotchas.
          </p>
        </button>

        <button
          onClick={() => onModeChange('deep-scan')}
          className={`p-3 rounded-lg border text-left transition-colors ${
            mode === 'deep-scan'
              ? 'border-purple-500 bg-purple-500/5'
              : 'border-border-default hover:border-border-active'
          }`}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <Sparkles
              className={`w-4 h-4 ${mode === 'deep-scan' ? 'text-purple-400' : 'text-text-muted'}`}
            />
            <span className="text-sm font-medium text-text-primary">Deep Scan</span>
          </div>
          <p className="text-xs text-text-muted">
            AI agent explores the codebase interactively — more thorough, uses API tokens.
          </p>
        </button>
      </div>

      {/* Phase preview */}
      <div className="flex flex-wrap gap-1.5">
        {phases.map((phase) => (
          <span
            key={phase}
            className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-text-muted bg-surface-overlay rounded"
            title={PHASE_INFO[phase]?.description}
          >
            {PHASE_INFO[phase]?.icon}
            {PHASE_INFO[phase]?.label}
          </span>
        ))}
      </div>

      {/* Scope selector */}
      <div className="space-y-1.5">
        <span className="text-[10px] uppercase tracking-wider text-text-muted">Scope</span>
        <div className="flex flex-wrap gap-1.5">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              data-testid={`bootstrap-scope-${s.id}`}
              onClick={() => onScopeChange(s.id)}
              title={s.hint}
              className={`px-2 py-1 text-xs rounded border transition-colors ${
                scope === s.id
                  ? 'border-teal bg-teal/10 text-teal'
                  : 'border-border-default text-text-muted hover:text-text-secondary'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-text-muted">
          {SCOPES.find((s) => s.id === scope)?.hint}
        </p>
      </div>

      {/* Start */}
      <button
        data-testid="bootstrap-start"
        onClick={onStart}
        disabled={!canStart}
        className={`flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-md transition-colors disabled:opacity-50 ${
          mode === 'deep-scan' ? 'bg-purple-600 hover:bg-purple-500' : 'bg-teal hover:bg-teal/80'
        }`}
      >
        {mode === 'deep-scan' ? <Sparkles className="w-4 h-4" /> : <Brain className="w-4 h-4" />}
        {mode === 'deep-scan' ? 'Start Deep Scan' : 'Feed Brain'}
      </button>

      {mode === 'deep-scan' && (
        <p className="text-xs text-amber-400/80">
          <AlertTriangle className="w-3 h-3 inline mr-1" />
          Deep Scan spawns a Claude agent session — this will consume API tokens (est. ~$0.10–0.50).
        </p>
      )}
    </div>
  )
}
