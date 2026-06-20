import { useState, useEffect, useCallback, type JSX } from 'react'
import { BookOpen, StopCircle, Plus, Clock, CheckCircle2, XCircle } from 'lucide-react'
import { useBlueprintStore } from '@renderer/store/blueprint.store'
import { useWorkspaceStore } from '@renderer/store/workspace.store'
import {
  BlueprintPhaseTimeline,
  BlueprintPhaseStream,
  BlueprintApprovalGate,
  BlueprintWaveProgress,
  StatusBadge,
  BlueprintHistoryItem,
  formatTimeAgo
} from './blueprints'

// ── View States ──

type ViewState = 'landing' | 'input' | 'active' | 'detail'

// ── Blueprint Page ──

interface BlueprintPageProps {
  onNavigateToChat?: () => void
}

export default function BlueprintPage(_props: BlueprintPageProps): JSX.Element {
  const workspace = useWorkspaceStore((s) => s.activeWorkspace)
  const workspaceId = workspace?.id ?? ''

  const {
    isRunning,
    currentPhase,
    phaseStreamText,
    pendingApproval,
    currentWave,
    waveTasks,
    history,
    currentBlueprint,
    loadHistory,
    loadBlueprint,
    startBlueprint,
    cancelBlueprint,
    respondToApproval
  } = useBlueprintStore()

  // ── Local state ──
  const [viewState, setViewState] = useState<ViewState>('landing')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<'P1' | 'P2' | 'P3'>('P2')

  // ── Load history on workspace change ──
  useEffect(() => {
    if (workspaceId) {
      loadHistory(workspaceId)
    }
    /* eslint-disable react-hooks/set-state-in-effect -- intentional reset on workspace identity change */
    setSelectedId(null)
    setViewState('landing')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [workspaceId, loadHistory])

  // ── Derive view state ──
  const effectiveView: ViewState = isRunning
    ? 'active'
    : pendingApproval
      ? 'active'
      : selectedId
        ? 'detail'
        : viewState

  // ── Actions ──
  const handleStart = useCallback(async () => {
    if (!title.trim() || !workspaceId) return
    try {
      await startBlueprint({
        workspaceId,
        title: title.trim(),
        description: description.trim() || undefined,
        priority
      })
      setTitle('')
      setDescription('')
      setPriority('P2')
    } catch {
      // Error already logged in store
    }
  }, [title, description, priority, workspaceId, startBlueprint])

  const handleCancel = useCallback(() => {
    if (workspaceId) {
      cancelBlueprint(workspaceId)
    }
  }, [workspaceId, cancelBlueprint])

  const handleApprove = useCallback(() => {
    if (pendingApproval) {
      respondToApproval(pendingApproval.blueprintId, true)
    }
  }, [pendingApproval, respondToApproval])

  const handleReject = useCallback(
    (feedback: string) => {
      if (pendingApproval) {
        respondToApproval(pendingApproval.blueprintId, false, feedback)
      }
    },
    [pendingApproval, respondToApproval]
  )

  const handleSelectBlueprint = useCallback(
    (id: string) => {
      setSelectedId(id)
      setViewState('detail')
      loadBlueprint(id)
    },
    [loadBlueprint]
  )

  const handleBackFromDetail = useCallback(() => {
    setSelectedId(null)
    setViewState('landing')
  }, [])

  // ── Get current stream text ──
  const currentPhaseStream = currentPhase ? (phaseStreamText[currentPhase] ?? '') : ''

  return (
    <div data-testid="blueprint-page" className="flex flex-col h-full overflow-y-auto">
      <div className="p-6 space-y-6 max-w-3xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen size={16} className="text-emerald-400" />
            <h3 className="text-sm font-semibold text-text-primary">Blueprints</h3>
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30">
              Experimental
            </span>
          </div>
          {isRunning && (
            <button
              type="button"
              onClick={handleCancel}
              data-testid="blueprint-cancel-btn"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 rounded-lg transition-colors"
            >
              <StopCircle size={14} />
              Cancel
            </button>
          )}
        </div>
        <p className="text-xs text-text-secondary">
          Define a feature and let the 7-phase pipeline specify, plan, build, and verify it
          automatically — pausing for your approval before writing code.
        </p>

        {/* ── Landing View ── */}
        {effectiveView === 'landing' && (
          <>
            {/* Empty state */}
            {history.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 px-4">
                <div className="max-w-2xl w-full space-y-6">
                  <div className="text-center space-y-2">
                    <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-500/15 mb-2">
                      <BookOpen size={28} className="text-emerald-400" />
                    </div>
                    <h2 className="text-lg font-semibold text-text-primary">Your Blueprints</h2>
                    <p className="text-sm text-text-secondary max-w-md mx-auto">
                      Describe a feature and the agent will{' '}
                      <span className="text-text-primary font-medium">
                        specify, clarify, plan, build, and verify
                      </span>{' '}
                      it through a 7-phase pipeline — pausing for your approval.
                    </p>
                  </div>

                  {/* 7-phase workflow cards */}
                  <div className="grid grid-cols-4 gap-3">
                    {(
                      [
                        {
                          emoji: '📋',
                          label: 'Specify',
                          desc: 'Analyze requirements and create a detailed spec'
                        },
                        {
                          emoji: '🗺️',
                          label: 'Plan',
                          desc: 'Create implementation plan with steps and files'
                        },
                        {
                          emoji: '🏗️',
                          label: 'Build',
                          desc: 'Execute tasks in parallel waves across the codebase'
                        },
                        {
                          emoji: '✅',
                          label: 'Verify',
                          desc: 'Run checks to confirm correct implementation'
                        }
                      ] as const
                    ).map((card) => (
                      <div
                        key={card.label}
                        className="rounded-xl border border-border-subtle bg-surface-overlay p-3 space-y-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-base">{card.emoji}</span>
                          <span className="text-sm font-semibold text-text-primary">
                            {card.label}
                          </span>
                        </div>
                        <p className="text-xs text-text-secondary leading-relaxed">{card.desc}</p>
                      </div>
                    ))}
                  </div>

                  <div className="flex justify-center">
                    <button
                      onClick={() => setViewState('input')}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-xl transition-colors"
                    >
                      <Plus size={16} />
                      Create Your First Blueprint
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* History list */}
            {history.length > 0 && (
              <div className="space-y-4">
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setViewState('input')}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-lg transition-colors"
                  >
                    <Plus size={14} />
                    New Blueprint
                  </button>
                </div>
                <div className="space-y-2">
                  {history.map((bp) => (
                    <BlueprintHistoryItem
                      key={bp.id}
                      blueprint={bp}
                      onSelect={() => handleSelectBlueprint(bp.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Input View ── */}
        {effectiveView === 'input' && (
          <div className="bg-surface-raised rounded-xl border border-border-subtle p-5 space-y-4">
            <h4 className="text-sm font-semibold text-text-primary">New Blueprint</h4>

            <div className="space-y-3">
              {/* Title */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Add user notification preferences page"
                  className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  autoFocus
                />
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">
                  Description <span className="text-text-muted">(optional)</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the feature in detail. Include requirements, constraints, and any relevant context..."
                  rows={4}
                  className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-emerald-500 resize-none"
                />
              </div>

              {/* Priority */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">
                  Priority
                </label>
                <div className="flex gap-2">
                  {(['P1', 'P2', 'P3'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                        priority === p
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          : 'bg-surface-base text-text-secondary border-border-subtle hover:bg-surface-hover'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
              <button
                type="button"
                onClick={() => setViewState('landing')}
                className="text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleStart}
                disabled={!title.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Start Pipeline
              </button>
            </div>
          </div>
        )}

        {/* ── Active Pipeline View ── */}
        {effectiveView === 'active' && (
          <>
            {/* Approval Gate overlay */}
            {pendingApproval && (
              <div
                data-testid="blueprint-approval-gate"
                className="bg-surface-raised rounded-xl border border-emerald-400/30 p-4"
              >
                <BlueprintApprovalGate
                  planSummary={pendingApproval.planSummary}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  onCancel={handleCancel}
                />
              </div>
            )}

            {/* Timeline + Stream */}
            <div
              data-testid="blueprint-phase-timeline"
              className="bg-surface-raised rounded-xl border border-border-subtle overflow-hidden"
            >
              <div className="grid grid-cols-[200px_1fr] divide-x divide-border-subtle h-[400px]">
                {/* Timeline sidebar */}
                <div className="p-4 overflow-y-auto">
                  <BlueprintPhaseTimeline
                    currentPhase={currentPhase}
                    awaitingApproval={!!pendingApproval}
                  />
                </div>

                {/* Stream output */}
                <div className="flex flex-col">
                  {currentPhase ? (
                    <BlueprintPhaseStream
                      phaseType={currentPhase}
                      streamText={currentPhaseStream}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-text-muted text-xs">
                      Waiting for pipeline to start...
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Wave Progress — shown during build phase */}
            {currentPhase === 'build' && currentWave && (
              <div className="bg-surface-raised rounded-xl border border-border-subtle p-4">
                <BlueprintWaveProgress
                  wave={currentWave.wave}
                  taskCount={currentWave.taskCount}
                  waveTasks={waveTasks}
                />
              </div>
            )}
          </>
        )}

        {/* ── Detail View (past blueprint) ── */}
        {effectiveView === 'detail' && selectedId && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={handleBackFromDetail}
              className="text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              ← Back to list
            </button>

            {currentBlueprint && currentBlueprint.id === selectedId ? (
              <div className="space-y-4">
                {/* Blueprint header */}
                <div className="bg-surface-raised rounded-xl border border-border-subtle p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold text-text-primary">
                      {currentBlueprint.title}
                    </h4>
                    <StatusBadge status={currentBlueprint.status} />
                    <span className="text-[10px] text-text-muted">{currentBlueprint.priority}</span>
                  </div>
                  {currentBlueprint.description && (
                    <p className="text-xs text-text-secondary">{currentBlueprint.description}</p>
                  )}
                  <div className="flex items-center gap-2 text-[10px] text-text-muted">
                    <Clock size={10} />
                    <span>Created {formatTimeAgo(new Date(currentBlueprint.createdAt))}</span>
                  </div>
                </div>

                {/* Phase list */}
                <div className="space-y-2">
                  <h5 className="text-xs font-medium text-text-secondary">Phases</h5>
                  {currentBlueprint.phases.map((phase) => (
                    <div
                      key={phase.id}
                      className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-base border border-border-subtle"
                    >
                      {phase.status === 'complete' ? (
                        <CheckCircle2 size={14} className="text-success flex-shrink-0" />
                      ) : phase.status === 'failed' ? (
                        <XCircle size={14} className="text-danger flex-shrink-0" />
                      ) : (
                        <div className="w-3.5 h-3.5 rounded-full border border-border-subtle flex-shrink-0" />
                      )}
                      <span className="text-xs font-medium text-text-primary capitalize">
                        {phase.phase}
                      </span>
                      <StatusBadge status={phase.status} />
                      {phase.completedAt && (
                        <span className="text-[10px] text-text-muted ml-auto">
                          {formatTimeAgo(new Date(phase.completedAt))}
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Tasks */}
                {currentBlueprint.tasks.length > 0 && (
                  <div className="space-y-2">
                    <h5 className="text-xs font-medium text-text-secondary">
                      Tasks ({currentBlueprint.tasks.length})
                    </h5>
                    {currentBlueprint.tasks.map((task) => (
                      <div
                        key={task.id}
                        className="px-3 py-2 rounded-lg bg-surface-base border border-border-subtle"
                      >
                        <div className="flex items-center gap-2">
                          {task.status === 'complete' ? (
                            <CheckCircle2 size={12} className="text-success" />
                          ) : task.status === 'failed' ? (
                            <XCircle size={12} className="text-danger" />
                          ) : (
                            <div className="w-3 h-3 rounded-full border border-border-subtle" />
                          )}
                          <span className="text-xs text-text-primary flex-1">
                            {task.description}
                          </span>
                          <span className="text-[10px] text-text-muted">Wave {task.wave}</span>
                        </div>
                        {task.filePathsJson.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1.5 ml-5">
                            {task.filePathsJson.map((f) => (
                              <span
                                key={f}
                                className="text-[10px] font-mono text-text-muted bg-surface-hover px-1.5 py-0.5 rounded"
                              >
                                {f}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-text-muted animate-pulse text-center py-8">
                Loading blueprint...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
