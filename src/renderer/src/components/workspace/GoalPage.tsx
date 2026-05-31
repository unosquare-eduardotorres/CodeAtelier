import { useEffect, useCallback } from 'react'
import { Target, StopCircle } from 'lucide-react'
import { useMpaStore } from '@renderer/store/mpa.store'
import { useWorkspaceStore } from '@renderer/store/workspace.store'
import {
  GoalInput,
  GoalPhaseTimeline,
  GoalPhaseStream,
  GoalApprovalGate,
  GoalRunHistory
} from './goals'
import type { MpaGoalType, MpaPhaseType, MpaStatus } from '../../../../shared/mpa-types'

/** Derive phase timeline entries from the run's configured phases and current status. */
function buildPhaseEntries(
  configuredPhases: MpaPhaseType[],
  status: MpaStatus
): Array<{ phaseType: MpaPhaseType; status: 'running' | 'completed' | 'pending'; iteration: number }> {
  const phases = configuredPhases.length > 0 ? configuredPhases : ['plan', 'execute', 'verify'] as MpaPhaseType[]
  const currentIdx = phases.indexOf(status.currentPhase as MpaPhaseType)

  return phases.map((phaseType, idx) => ({
    phaseType,
    status:
      idx < currentIdx
        ? 'completed'
        : idx === currentIdx
          ? 'running'
          : 'pending',
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
    phaseStreamText,
    pendingApproval,
    preloadedGoal,
    configuredPhases,
    startGoal,
    cancelGoal,
    respondToApproval,
    loadHistory
  } = useMpaStore()

  // Listeners are registered globally in AppLayout — no need to duplicate here

  // Load history on workspace change
  useEffect(() => {
    if (workspaceId) {
      loadHistory(workspaceId)
    }
  }, [workspaceId, loadHistory])

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

  // Get current phase stream text
  const currentPhaseEntries = Object.entries(phaseStreamText)
  const latestPhaseEntry =
    currentPhaseEntries.length > 0
      ? currentPhaseEntries[currentPhaseEntries.length - 1]
      : null

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

        {/* New Goal Input — shown when not running */}
        {!isRunning && !pendingApproval && (
          <div className="bg-surface-raised rounded-xl border border-border-subtle p-4">
            <GoalInput
              workspaceId={workspaceId}
              onStart={handleStart}
              disabled={isRunning}
            />
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
                  phases={
                    status.currentPhase
                      ? buildPhaseEntries(configuredPhases, status)
                      : []
                  }
                  currentPhaseType={status.currentPhase as MpaPhaseType | null}
                  awaitingApproval={status.awaitingApproval}
                />
              </div>

              {/* Stream output */}
              <div className="flex flex-col">
                {latestPhaseEntry ? (
                  <GoalPhaseStream
                    phaseId={latestPhaseEntry[0]}
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

        {/* Past Goals */}
        {!isRunning && !pendingApproval && (
          <GoalRunHistory workspaceId={workspaceId} />
        )}
      </div>
    </div>
  )
}
