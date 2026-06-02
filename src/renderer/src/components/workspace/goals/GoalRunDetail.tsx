import type { JSX } from 'react'
import { ArrowLeft, Play, Target } from 'lucide-react'
import { useState } from 'react'
import GoalArtifactViewer from './GoalArtifactViewer'
import { RUN_STATUS_CONFIG, formatGoalType } from './constants'
import type {
  MpaRun,
  MpaPhase,
  MpaArtifact,
  MpaPlanArtifact,
  MpaVerifyReport
} from '../../../../../shared/mpa-types'

interface GoalRunDetailProps {
  run: MpaRun
  phases: MpaPhase[]
  artifacts: MpaArtifact[]
  onBack: () => void
  onResume?: (runId: string) => void
}

export default function GoalRunDetail({
  run,
  phases,
  artifacts,
  onBack,
  onResume
}: GoalRunDetailProps): JSX.Element {
  const [isResuming, setIsResuming] = useState(false)
  const isResumable = run.status === 'failed' || run.status === 'cancelled'
  const statusConfig = RUN_STATUS_CONFIG[run.status] ?? RUN_STATUS_CONFIG.running
  const dateStr = new Date(run.createdAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

  // Find plan and verify report artifacts
  const planArtifact = artifacts.find((a) => a.artifactType === 'plan')
  const verifyArtifact = artifacts.find((a) => a.artifactType === 'verify_report')
  const plan = planArtifact?.contentJson as MpaPlanArtifact | undefined
  const verifyReport = verifyArtifact?.contentJson as MpaVerifyReport | undefined

  return (
    <div className="space-y-4">
      {/* Back + Header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="p-1.5 rounded-lg hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
          title="Back to goals"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Target size={14} className="text-cyan-400 shrink-0" />
            <h3 className="text-sm font-semibold text-text-primary truncate">{run.title}</h3>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-text-muted">
            <span className={statusConfig.color}>{statusConfig.icon}</span>
            <span className={statusConfig.color}>{statusConfig.label}</span>
            <span>·</span>
            <span>{formatGoalType(run.goalType)}</span>
            <span>·</span>
            <span>{dateStr}</span>
            {run.totalTokens > 0 && (
              <>
                <span>·</span>
                <span>{Math.round(run.totalTokens / 1000)}K tokens</span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Resume banner */}
      {isResumable && onResume && (
        <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5">
          <p className="text-xs text-amber-400">
            This run {run.status === 'failed' ? 'failed' : 'was cancelled'} — you can resume from
            the last completed phase.
          </p>
          <button
            type="button"
            disabled={isResuming}
            onClick={async () => {
              setIsResuming(true)
              try {
                await onResume(run.id)
              } catch {
                // onResume failed — button resets automatically
              } finally {
                setTimeout(() => setIsResuming(false), 2000)
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors"
          >
            <Play size={12} />
            {isResuming ? 'Resuming…' : 'Resume'}
          </button>
        </div>
      )}

      {/* Goal description */}
      <div className="bg-surface-base rounded-lg border border-border-subtle p-3">
        <p className="text-xs font-medium text-text-secondary mb-1">Goal</p>
        <p className="text-sm text-text-primary">{run.goal}</p>
      </div>

      {/* Phase timeline summary */}
      {phases.length > 0 && (
        <div className="bg-surface-base rounded-lg border border-border-subtle p-3">
          <p className="text-xs font-medium text-text-secondary mb-2">Phases</p>
          <div className="space-y-1.5">
            {phases.map((phase) => {
              const phaseStatus = RUN_STATUS_CONFIG[phase.status] ?? RUN_STATUS_CONFIG.running
              return (
                <div key={phase.id} className="flex items-center gap-2 text-xs">
                  <span className={phaseStatus.color}>{phaseStatus.icon}</span>
                  <span className="text-text-primary font-medium capitalize">
                    {phase.phaseType}
                  </span>
                  {phase.iteration > 1 && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-400">
                      iteration {phase.iteration}
                    </span>
                  )}
                  <span className="text-text-muted">{phase.agentRole}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Plan summary */}
      {plan && (
        <div className="bg-surface-base rounded-lg border border-border-subtle p-3">
          <p className="text-xs font-medium text-text-secondary mb-2">
            Plan ({plan.items.length} items)
          </p>
          <p className="text-sm text-text-primary mb-2">{plan.summary}</p>
          <div className="space-y-1">
            {plan.items.map((item) => (
              <div key={item.id} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-text-muted">{item.id}</span>
                <span className="text-text-primary">{item.title}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover text-text-muted">
                  {item.scope}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Verify report — uses GoalArtifactViewer */}
      {verifyReport && (
        <div className="bg-surface-base rounded-lg border border-border-subtle p-3">
          <p className="text-xs font-medium text-text-secondary mb-2">Verification Report</p>
          <GoalArtifactViewer report={verifyReport} />
        </div>
      )}
    </div>
  )
}
