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
  GoalCampaignPanel,
  GoalCampaignProgress,
  GoalCampaignHistory
} from './goals'
import type { MpaPhaseType, MpaStatus } from '../../../../shared/mpa-types'

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

// ── useGoalPageState ──

function useGoalPageState(workspaceId: string) {
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
    activeCampaign,
    campaignHistory,
    cancelGoal,
    respondToApproval,
    cancelCampaign,
    loadHistory,
    loadCampaignHistory,
    loadRun
  } = useMpaStore()

  const hasAnyHistory = history.length > 0 || campaignHistory.length > 0
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [showCampaignPanel, setShowCampaignPanel] = useState(false)
  const campaignActive =
    !!activeCampaign && (activeCampaign.status === 'running' || activeCampaign.status === 'paused')

  useEffect(() => {
    if (workspaceId) {
      loadHistory(workspaceId)
      loadCampaignHistory(workspaceId)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on workspace switch
      setSelectedRunId(null)
    }
  }, [workspaceId, loadHistory, loadCampaignHistory])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- auto-open panel from preloaded goal
    if (preloadedGoal) setShowCampaignPanel(true)
  }, [preloadedGoal])

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
    if (campaignActive) {
      cancelCampaign(workspaceId)
    } else {
      cancelGoal()
    }
  }, [campaignActive, cancelCampaign, cancelGoal, workspaceId])

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

  const currentPhaseEntries = Object.entries(phaseStreamText)
  const latestPhaseEntry =
    currentPhaseEntries.length > 0 ? currentPhaseEntries[currentPhaseEntries.length - 1] : null

  return {
    status,
    isRunning,
    currentRun,
    runPhases,
    artifacts,
    pendingApproval,
    configuredPhases,
    history,
    hasAnyHistory,
    campaignActive,
    latestPhaseEntry,
    selectedRunId,
    showCampaignPanel,
    setShowCampaignPanel,
    handleApprove,
    handleReject,
    handleCancel,
    handleSelectRun,
    handleBackFromDetail,
    handleResume
  }
}

// ── EmptyGoalState ──

function EmptyGoalState({ onStartCampaign }: { onStartCampaign: () => void }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-4">
      <div className="max-w-2xl w-full space-y-6">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-cyan-500/15 mb-2">
            <Target size={28} className="text-cyan-400" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary inline-flex items-center gap-2">
            Your Goals
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30">
              Experimental
            </span>
          </h2>
          <p className="text-sm text-text-secondary max-w-md mx-auto">
            Describe what you want to achieve. The agent will
            <span className="text-text-primary font-medium"> plan, execute, and verify </span>
            autonomously — pausing for your approval before writing code.
          </p>
        </div>

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

        <div className="flex justify-center">
          <button
            onClick={onStartCampaign}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 rounded-xl transition-colors"
          >
            <Plus size={16} />
            Start Your First Goal
          </button>
        </div>
      </div>
    </div>
  )
}

// ── GoalHistorySection ──

function GoalHistorySection({
  onNewGoal,
  onSelectRun,
  hasRunHistory
}: {
  onNewGoal: () => void
  onSelectRun: (runId: string) => void
  hasRunHistory: boolean
}): JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onNewGoal}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 rounded-lg transition-colors"
        >
          <Plus size={14} />
          New Goal
        </button>
      </div>
      <GoalCampaignHistory onSelectRun={onSelectRun} />
      {hasRunHistory && <GoalRunHistory onSelectRun={onSelectRun} />}
    </div>
  )
}

// ── GoalPage ──

export default function GoalPage(_props: GoalPageProps): JSX.Element {
  const workspace = useWorkspaceStore((s) => s.activeWorkspace)
  const workspaceId = workspace?.id ?? ''

  const {
    status,
    isRunning,
    currentRun,
    runPhases,
    artifacts,
    pendingApproval,
    configuredPhases,
    history,
    hasAnyHistory,
    campaignActive,
    latestPhaseEntry,
    selectedRunId,
    showCampaignPanel,
    setShowCampaignPanel,
    handleApprove,
    handleReject,
    handleCancel,
    handleSelectRun,
    handleBackFromDetail,
    handleResume
  } = useGoalPageState(workspaceId)

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-6 space-y-6 max-w-3xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target size={16} className="text-cyan-400" />
            <h3 className="text-sm font-semibold text-text-primary">Goals</h3>
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30">
              Experimental
            </span>
          </div>
          {(isRunning || campaignActive) && (
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

        {/* Campaign panel — 3-step Describe → Review → Run */}
        {showCampaignPanel && (
          <GoalCampaignPanel
            workspaceId={workspaceId}
            onClose={() => setShowCampaignPanel(false)}
          />
        )}

        {/* Campaign progress + pause prompt */}
        {!showCampaignPanel && campaignActive && <GoalCampaignProgress workspaceId={workspaceId} />}

        {/* Empty state — no history, not running */}
        {!showCampaignPanel &&
          !campaignActive &&
          !isRunning &&
          !pendingApproval &&
          !selectedRunId &&
          !hasAnyHistory && <EmptyGoalState onStartCampaign={() => setShowCampaignPanel(true)} />}

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
        {!showCampaignPanel && isRunning && (
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
        {!showCampaignPanel &&
          !isRunning &&
          !pendingApproval &&
          selectedRunId &&
          currentRun?.id === selectedRunId && (
            <GoalRunDetail
              run={currentRun}
              phases={runPhases}
              artifacts={artifacts}
              onBack={handleBackFromDetail}
              onResume={handleResume}
            />
          )}

        {/* Past Goals + Campaigns */}
        {!showCampaignPanel &&
          !campaignActive &&
          !isRunning &&
          !pendingApproval &&
          !selectedRunId &&
          hasAnyHistory && (
            <GoalHistorySection
              onNewGoal={() => setShowCampaignPanel(true)}
              onSelectRun={handleSelectRun}
              hasRunHistory={history.length > 0}
            />
          )}
      </div>
    </div>
  )
}
