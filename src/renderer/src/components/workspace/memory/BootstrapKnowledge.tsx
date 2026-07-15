/**
 * BootstrapKnowledge — UI for project knowledge bootstrap ("Feed Brain" + "Deep Scan").
 *
 * Features:
 * - Mode selector: Feed Brain (deterministic) vs Deep Scan (agent-driven)
 * - Phase stepper with per-phase status
 * - Overall progress bar + Cancel
 * - Incremental re-run awareness
 */

import { useState, useCallback } from 'react'
import {
  Brain,
  Zap,
  Search,
  X,
  Loader2,
  CheckCircle,
  AlertTriangle,
  FileText,
  Layers,
  GitBranch,
  Network,
  Sparkles,
  Flag
} from 'lucide-react'
import { useWorkspaceStore, useMemoryStore } from '@renderer/store'
import type { BootstrapMode, BootstrapPhaseLabel } from '../../../../../shared/types'

// ── Phase metadata ──

interface PhaseInfo {
  label: string
  icon: React.ReactNode
  description: string
}

const FULL_PHASE_INFO: Record<string, PhaseInfo> = {
  preflight: { label: 'Preflight', icon: <Zap className="w-3.5 h-3.5" />, description: 'Check prerequisites' },
  docs: { label: 'Docs', icon: <FileText className="w-3.5 h-3.5" />, description: 'Extract from documentation' },
  stack: { label: 'Stack', icon: <Layers className="w-3.5 h-3.5" />, description: 'Analyze tech stack' },
  architecture: { label: 'Architecture', icon: <Network className="w-3.5 h-3.5" />, description: 'Central files by PageRank' },
  history: { label: 'History', icon: <GitBranch className="w-3.5 h-3.5" />, description: 'Mine git history' },
  structure: { label: 'Structure', icon: <Search className="w-3.5 h-3.5" />, description: 'Detect gotchas' },
  'agent-exploration': { label: 'Agent Scan', icon: <Sparkles className="w-3.5 h-3.5" />, description: 'AI explores the codebase' },
  finalize: { label: 'Finalize', icon: <Flag className="w-3.5 h-3.5" />, description: 'Backfill & save markers' }
}

const FULL_PHASES: BootstrapPhaseLabel[] = ['preflight', 'docs', 'stack', 'architecture', 'history', 'structure', 'finalize']
const DEEP_SCAN_PHASES: BootstrapPhaseLabel[] = ['preflight', 'docs', 'stack', 'agent-exploration', 'finalize']

function PhaseStep({
  phase,
  index,
  currentIndex,
  isRunning
}: {
  phase: BootstrapPhaseLabel
  index: number
  currentIndex: number
  isRunning: boolean
}): React.JSX.Element {
  const info = FULL_PHASE_INFO[phase]
  const isDone = currentIndex > index
  const isCurrent = currentIndex === index && isRunning
  const isPending = currentIndex < index

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors ${
        isCurrent
          ? 'bg-teal/15 text-teal border border-teal/30'
          : isDone
            ? 'bg-green-500/10 text-green-400'
            : isPending
              ? 'text-text-muted'
              : 'text-text-secondary'
      }`}
    >
      {isCurrent ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : isDone ? (
        <CheckCircle className="w-3.5 h-3.5" />
      ) : (
        info?.icon ?? <div className="w-3.5 h-3.5" />
      )}
      <span>{info?.label ?? phase}</span>
    </div>
  )
}

export default function BootstrapKnowledge(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const { bootstrap, startBootstrap, cancelBootstrap, dismissBootstrap } = useMemoryStore()
  const [selectedMode, setSelectedMode] = useState<BootstrapMode>('full')

  const workspaceId = activeWorkspace?.id
  const workspacePath = activeWorkspace?.repoPath

  const handleStart = useCallback(async () => {
    if (!workspaceId || !workspacePath) return
    await startBootstrap(workspaceId, workspacePath, selectedMode)
  }, [workspaceId, workspacePath, selectedMode, startBootstrap])

  const handleCancel = useCallback(() => {
    cancelBootstrap()
  }, [cancelBootstrap])

  const handleDismiss = useCallback(() => {
    dismissBootstrap()
  }, [dismissBootstrap])

  const isRunning = bootstrap?.jobStatus === 'running'
  const isDone = bootstrap?.jobStatus === 'done' || bootstrap?.jobStatus === 'cancelled' || bootstrap?.jobStatus === 'error'
  const currentPhases = bootstrap?.mode === 'deep-scan' ? DEEP_SCAN_PHASES : FULL_PHASES
  const displayPhases = isRunning || isDone ? currentPhases : (selectedMode === 'deep-scan' ? DEEP_SCAN_PHASES : FULL_PHASES)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-text-primary flex items-center gap-1.5">
            <Brain className="w-4 h-4 text-teal" />
            Bootstrap Project Knowledge
          </h3>
          <p className="text-xs text-text-muted mt-0.5">
            Scans key files, docs, and git history to build project knowledge. Re-runs are incremental.
          </p>
        </div>
      </div>

      {/* ── Active Bootstrap Progress ── */}
      {bootstrap && (
        <div className="rounded-lg border border-border-default bg-surface-float p-3 space-y-3">
          {/* Phase stepper */}
          <div className="flex flex-wrap gap-1.5">
            {displayPhases.map((phase, idx) => (
              <PhaseStep
                key={phase}
                phase={phase}
                index={idx}
                currentIndex={bootstrap.phaseIndex}
                isRunning={isRunning}
              />
            ))}
          </div>

          {/* Progress bar */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-secondary">
                {isRunning
                  ? bootstrap.message
                  : bootstrap.jobStatus === 'done'
                    ? `Complete — ${bootstrap.factsCreated} memories created`
                    : bootstrap.jobStatus === 'cancelled'
                      ? 'Cancelled'
                      : `Error: ${bootstrap.message}`}
              </span>
              <span className="text-text-muted">{bootstrap.factsCreated} facts</span>
            </div>

            <div className="h-1.5 bg-surface-overlay rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  bootstrap.jobStatus === 'error'
                    ? 'bg-red-500'
                    : bootstrap.jobStatus === 'done'
                      ? 'bg-green-500'
                      : 'bg-teal'
                }`}
                style={{
                  width: `${displayPhases.length > 0 ? ((bootstrap.phaseIndex + (isRunning ? 0.5 : 1)) / displayPhases.length) * 100 : 0}%`
                }}
              />
            </div>
          </div>

          {/* Mode badge */}
          <div className="flex items-center gap-2 text-xs text-text-muted">
            {bootstrap.mode === 'deep-scan' ? (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">
                <Sparkles className="w-3 h-3" />
                Deep Scan
              </span>
            ) : (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-teal/10 text-teal">
                <Zap className="w-3 h-3" />
                {bootstrap.mode === 'incremental' ? 'Incremental' : 'Feed Brain'}
              </span>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex justify-end gap-2">
            {isRunning && (
              <button
                onClick={handleCancel}
                className="flex items-center gap-1 px-2.5 py-1 text-xs bg-red-500/10 text-red-400 rounded hover:bg-red-500/20"
              >
                <X className="w-3 h-3" />
                Cancel
              </button>
            )}
            {isDone && (
              <button
                onClick={handleDismiss}
                className="px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary rounded hover:bg-surface-overlay"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Mode Selection + Start ── */}
      {!isRunning && !isDone && (
        <div className="space-y-3">
          {/* Mode cards */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setSelectedMode('full')}
              className={`p-3 rounded-lg border text-left transition-colors ${
                selectedMode === 'full'
                  ? 'border-teal bg-teal/5'
                  : 'border-border-default hover:border-border-active'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Zap className={`w-4 h-4 ${selectedMode === 'full' ? 'text-teal' : 'text-text-muted'}`} />
                <span className="text-sm font-medium text-text-primary">Feed Brain</span>
              </div>
              <p className="text-xs text-text-muted">
                Deterministic scan — docs, stack, PageRank architecture, git history, structural gotchas.
              </p>
            </button>

            <button
              onClick={() => setSelectedMode('deep-scan')}
              className={`p-3 rounded-lg border text-left transition-colors ${
                selectedMode === 'deep-scan'
                  ? 'border-purple-500 bg-purple-500/5'
                  : 'border-border-default hover:border-border-active'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Sparkles className={`w-4 h-4 ${selectedMode === 'deep-scan' ? 'text-purple-400' : 'text-text-muted'}`} />
                <span className="text-sm font-medium text-text-primary">Deep Scan</span>
              </div>
              <p className="text-xs text-text-muted">
                AI agent explores the codebase interactively — more thorough, uses API tokens.
              </p>
            </button>
          </div>

          {/* Phase preview */}
          <div className="flex flex-wrap gap-1.5">
            {(selectedMode === 'deep-scan' ? DEEP_SCAN_PHASES : FULL_PHASES).map((phase) => {
              const info = FULL_PHASE_INFO[phase]
              return (
                <span
                  key={phase}
                  className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-text-muted bg-surface-overlay rounded"
                  title={info?.description}
                >
                  {info?.icon}
                  {info?.label}
                </span>
              )
            })}
          </div>

          {/* Start button */}
          <button
            onClick={handleStart}
            disabled={!workspaceId || !workspacePath}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-md transition-colors disabled:opacity-50 ${
              selectedMode === 'deep-scan'
                ? 'bg-purple-600 hover:bg-purple-500'
                : 'bg-teal hover:bg-teal/80'
            }`}
          >
            {selectedMode === 'deep-scan' ? (
              <Sparkles className="w-4 h-4" />
            ) : (
              <Brain className="w-4 h-4" />
            )}
            {selectedMode === 'deep-scan' ? 'Start Deep Scan' : 'Feed Brain'}
          </button>

          {selectedMode === 'deep-scan' && (
            <p className="text-xs text-amber-400/80">
              <AlertTriangle className="w-3 h-3 inline mr-1" />
              Deep Scan spawns a Claude agent session — this will consume API tokens (est. ~$0.10–0.50).
            </p>
          )}
        </div>
      )}
    </div>
  )
}
