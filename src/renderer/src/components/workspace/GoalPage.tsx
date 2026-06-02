import { useState, useEffect, useCallback, type JSX } from 'react'
import {
  Target,
  StopCircle,
  Plus,
  ClipboardList,
  UserCheck,
  Code2,
  CheckCircle2
} from 'lucide-react'
import { useMpaStore } from '@renderer/store/mpa.store'
import { useWorkspaceStore } from '@renderer/store/workspace.store'
import {
  GoalPhaseTimeline,
  GoalPhaseStream,
  GoalApprovalGate,
  GoalRunHistory,
  GoalRunDetail,
  StartGoalModal
} from './goals'
import type { MpaGoalType, MpaPhaseType, MpaStatus } from '../../../../shared/mpa-types'

/** Derive phase timeline entries from the run's configured phases and current status. */
function buildPhaseEntries(
  configuredPhases: MpaPhaseType[],
  status: MpaStatus
): Array<{
  phaseType: MpaPhaseType
  status: 'running' | 'completed' | 'pending'
  iteration: number
}> {
  const phases =
    configuredPhases.length > 0
      ? configuredPhases
      : (['plan', 'execute', 'verify'] as MpaPhaseType[])
  const currentIdx = phases.indexOf(status.currentPhase as MpaPhaseType)

  return phases.map((phaseType, idx) => ({
    phaseType,
    status: idx < currentIdx ? 'completed' : idx === currentIdx ? 'running' : 'pending',
    iteration: idx === currentIdx ? status.iteration : 1
  }))
}

interface GoalPageProps {
  onNavigateToChat?: () => void
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future use (e.g., linking goal results back to chat)
export default function GoalPage({ onNavigateToChat }: GoalPageProps): JSX.Element {
  const workspace = useWorkspaceStore((s) => s.activeWorkspace)
  const workspaceId = workspace?.id ?? ''

  const {
    status,
    isRunning,
    currentRun,
    phases: runPhases,
    artifacts,
    phaseStreamText,
    pendingApproval,
    preloadedGoal,
    configuredPhases,
    history,
    startGoal,
    cancelGoal,
    respondToApproval,
    loadHistory,
    loadRun
  } = useMpaStore()

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [showStartModal, setShowStartModal] = useState(false)

  // Listeners are registered globally in AppLayout — no need to duplicate here

  // Load history on workspace change (reset selected run on workspace switch)
  useEffect(() => {
    if (workspaceId) {
      loadHistory(workspaceId)
      setSelectedRunId(null)
    }
  }, [workspaceId, loadHistory])

  // Auto-open the Start Goal modal when a goal is handed off from the grill
  useEffect(() => {
    if (preloadedGoal) setShowStartModal(true)
  }, [preloadedGoal])

  const handleStart = useCallback(
    async (params: {
      goal: string
      title: string
      goalType: MpaGoalType
      phases: MpaPhaseType[]
    }) => {
      if (!workspaceId) return
      await startGoal({
        workspaceId,
        goal: params.goal,
        title: params.title,
        goalType: params.goalType,
        phases: params.phases,
        grillSessionId: preloadedGoal?.grillSessionId,
        grillDecisions: preloadedGoal?.grillDecisions
      })
    },
    [workspaceId, startGoal, preloadedGoal]
  )

  const handleApprove = useCallback(() => {
    respondToApproval(true)
  }, [respondToApproval])

  const handleReject = useCallback(
    (feedback: string) => {
      respondToApproval(false, feedback)
    },
    [respondToApproval]
  )

  const handleCancel = useCallback(() => {
    cancelGoal()
  }, [cancelGoal])

  const handleSelectRun = useCallback(
    (runId: string) => {
      setSelectedRunId(runId)
      loadRun(runId)
    },
    [loadRun]
  )

  const handleBackFromDetail = useCallback(() => {
    setSelectedRunId(null)
  }, [])

  const handleResume = useCallback(
    async (runId: string) => {
      if (!workspaceId) return
      await window.api.mpaResume({ runId, workspaceId })
    },
    [workspaceId]
  )

  // Get current phase stream text
  const currentPhaseEntries = Object.entries(phaseStreamText)
  const latestPhaseEntry =
    currentPhaseEntries.length > 0 ? currentPhaseEntries[currentPhaseEntries.length - 1] : null

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-6 space-y-6 max-w-3xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target size={16} className="text-cyan-400" />
            <h3 className="text-sm font-semibold text-text-primary">Goals</h3>
          </div>
          {isRunning && (
            <button
              type="button"
              onClick={handleCancel}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 rounded-lg transition-colors"
            >
              <StopCircle size={14} />
              Cancel
            </button>
          )}
        </div>
        <p className="text-xs text-text-secondary">
          Define a high-level objective and let an AI agent plan, implement, and verify it
          automatically.
        </p>

        {/* Empty state — no history, not running */}
        {!isRunning && !pendingApproval && !selectedRunId && history.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 px-4">
            <div className="max-w-2xl w-full space-y-6">
              {/* Header */}
              <div className="text-center space-y-2">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-cyan-500/15 mb-2">
                  <Target size={28} className="text-cyan-400" />
                </div>
                <h2 className="text-lg font-semibold text-text-primary">Your Goals</h2>
                <p className="text-sm text-text-secondary max-w-md mx-auto">
                  Describe what you want to achieve. The agent will
                  <span className="text-text-primary font-medium"> plan, execute, and verify </span>
                  autonomously — pausing for your approval before writing code.
                </p>
              </div>

              {/* 4-phase workflow cards */}
              <div className="grid grid-cols-4 gap-3">
                <div className="rounded-xl border border-border-subtle bg-surface-overlay p-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-cyan-500/15 flex items-center justify-center">
                      <ClipboardList size={14} className="text-cyan-400" />
                    </div>
                    <span className="text-sm font-semibold text-text-primary">Plan</span>
                  </div>
                  <p className="text-xs text-text-secondary leading-relaxed">
                    Agent analyzes your goal and produces a step-by-step implementation plan.
                  </p>
                </div>

                <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-cyan-500/15 flex items-center justify-center">
                      <UserCheck size={14} className="text-cyan-400" />
                    </div>
                    <span className="text-sm font-semibold text-text-primary">Review</span>
                  </div>
                  <p className="text-xs text-text-secondary leading-relaxed">
                    You approve, reject, or refine the plan before any code is written.
                  </p>
                </div>

                <div className="rounded-xl border border-border-subtle bg-surface-overlay p-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-accent/15 flex items-center justify-center">
                      <Code2 size={14} className="text-accent" />
                    </div>
                    <span className="text-sm font-semibold text-text-primary">Execute</span>
                  </div>
                  <p className="text-xs text-text-secondary leading-relaxed">
                    Agent implements the approved plan across your codebase.
                  </p>
                </div>

                <div className="rounded-xl border border-border-subtle bg-surface-overlay p-3 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-success/15 flex items-center justify-center">
                      <CheckCircle2 size={14} className="text-success" />
                    </div>
                    <span className="text-sm font-semibold text-text-primary">Verify</span>
                  </div>
                  <p className="text-xs text-text-secondary leading-relaxed">
                    Runs quality checks and confirms the implementation is correct.
                  </p>
                </div>
              </div>

              {/* CTA */}
              <div className="flex justify-center">
                <button
                  onClick={() => setShowStartModal(true)}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 rounded-xl transition-colors"
                >
                  <Plus size={16} />
                  Start Your First Goal
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Approval Gate — shown when awaiting approval */}
        {pendingApproval && (
          <div className="bg-surface-raised rounded-xl border border-cyan-400/30 p-4">
            <GoalApprovalGate
              plan={pendingApproval.artifact}
              onApprove={handleApprove}
              onReject={handleReject}
              onCancel={handleCancel}
            />
          </div>
        )}

        {/* Active Goal — timeline + stream */}
        {isRunning && (
          <div className="bg-surface-raised rounded-xl border border-border-subtle overflow-hidden">
            <div className="grid grid-cols-[240px_1fr] divide-x divide-border-subtle h-[400px]">
              {/* Timeline sidebar */}
              <div className="p-4 overflow-y-auto">
                <GoalPhaseTimeline
                  phases={status.currentPhase ? buildPhaseEntries(configuredPhases, status) : []}
                  currentPhaseType={status.currentPhase as MpaPhaseType | null}
                  awaitingApproval={status.awaitingApproval}
                />
              </div>

              {/* Stream output */}
              <div className="flex flex-col">
                {latestPhaseEntry ? (
                  <GoalPhaseStream
                    phaseType={status.currentPhase ?? 'plan'}
                    streamText={latestPhaseEntry[1]}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-text-muted text-xs">
                    Waiting for agent to start...
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Run Detail — shown when a past run is selected */}
        {!isRunning && !pendingApproval && selectedRunId && currentRun?.id === selectedRunId && (
          <GoalRunDetail
            run={currentRun}
            phases={runPhases}
            artifacts={artifacts}
            onBack={handleBackFromDetail}
            onResume={handleResume}
          />
        )}

        {/* Past Goals — shown when no run is selected and history exists */}
        {!isRunning && !pendingApproval && !selectedRunId && history.length > 0 && (
          <GoalRunHistory onSelectRun={handleSelectRun} onNewGoal={() => setShowStartModal(true)} />
        )}
      </div>

      {showStartModal && (
        <StartGoalModal
          onStart={handleStart}
          disabled={isRunning}
          onClose={() => setShowStartModal(false)}
        />
      )}
    </div>
  )
}
