import { useState } from 'react'
import {
  Database,
  Code,
  TestTube,
  Building2,
  Shield,
  FileText,
  Palette,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  Ban,
  ArrowLeft,
  Square
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AuditRun, AuditTrackId } from '../../../../shared/types'
import { AUDIT_TRACKS } from '../../../../shared/constants'
import HealthFindingsList from './HealthFindingsList'
import AuditStreamView from './AuditStreamView'
import type { AuditFinding } from '../../../../shared/types'

const ICON_MAP: Record<string, LucideIcon> = {
  Database,
  Code,
  TestTube,
  Building2,
  Shield,
  FileText,
  Palette
}

interface HealthExecutionViewProps {
  currentRun: AuditRun
  isRunning: boolean
  rerunningTrackId: AuditTrackId | null
  onCancel: () => void
  onBack: () => void
  selectedFindings: AuditFinding[]
  onToggleFinding: (finding: AuditFinding) => void
  onConvertToChat: () => void
}

function getScoreColor(score: number): string {
  if (score <= 20) return 'text-danger'
  if (score <= 40) return 'text-danger'
  if (score <= 60) return 'text-warning'
  if (score <= 80) return 'text-success'
  return 'text-success'
}

function StatusIcon({ status }: { status: string }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={16} className="text-success" />
    case 'running':
      return <Loader2 size={16} className="text-info animate-spin" />
    case 'failed':
      return <XCircle size={16} className="text-danger" />
    case 'cancelled':
      return <Ban size={16} className="text-text-muted" />
    case 'pending':
    default:
      return <Clock size={16} className="text-text-muted" />
  }
}

export default function HealthExecutionView({
  currentRun,
  isRunning,
  rerunningTrackId,
  onCancel,
  onBack,
  selectedFindings,
  onToggleFinding,
  onConvertToChat
}: HealthExecutionViewProps): React.JSX.Element {
  const [selectedTrackId, setSelectedTrackId] = useState<AuditTrackId | null>(null)
  const effectivelyRunning = isRunning || !!rerunningTrackId

  // Find the currently-running track
  const runningTrackId = currentRun.results.find((r) => r.status === 'running')?.trackId ?? null

  // Determine which track to show in main area
  const activeViewTrack = selectedTrackId ?? runningTrackId

  // Get result for active view track
  const activeResult =
    activeViewTrack ? currentRun.results.find((r) => r.trackId === activeViewTrack) ?? null : null

  // Progress calculation
  const completedCount = currentRun.results.filter(
    (r) => r.status === 'completed' || r.status === 'failed'
  ).length
  const totalCount = currentRun.selectedTracks.length
  const percentage = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0

  const activeTrack = activeViewTrack ? AUDIT_TRACKS[activeViewTrack] : null
  const ActiveIcon = activeTrack ? ICON_MAP[activeTrack.icon] ?? Code : Code

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle bg-surface-raised">
        <div className="flex items-center gap-3">
          {!isRunning && (
            <button
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              <ArrowLeft size={14} />
              Back to Selection
            </button>
          )}
          <span className="text-sm font-bold text-text-primary">
            Workspace Health —{' '}
            {rerunningTrackId
              ? `Re-running ${AUDIT_TRACKS[rerunningTrackId]?.name ?? rerunningTrackId}`
              : effectivelyRunning
                ? 'Running'
                : 'Complete'}
          </span>
        </div>
        {effectivelyRunning && (
          <button
            onClick={onCancel}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
          >
            <Square size={12} />
            Cancel
          </button>
        )}
      </div>

      {/* 80/20 split — live output left (80%), queue sidebar right (20%) */}
      <div className="flex flex-1 min-h-0">
        {/* Main area — 80% — live output / results */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {activeViewTrack && activeTrack ? (
            <>
              {/* Track header */}
              <div className="flex items-center gap-3 px-6 py-3 border-b border-border-subtle bg-surface-raised">
                <ActiveIcon size={24} className="text-primary-text" />
                <div>
                  <h3 className="text-sm font-bold text-text-primary">{activeTrack.name}</h3>
                  <p className="text-[11px] text-text-muted">{activeTrack.description}</p>
                </div>
                {activeResult?.score !== null && activeResult?.score !== undefined && (
                  <span
                    className={`ml-auto text-lg font-bold ${getScoreColor(activeResult.score)}`}
                  >
                    {activeResult.score}/100
                  </span>
                )}
              </div>

              {/* Content area */}
              <div className="flex-1 overflow-y-auto min-h-0">
                {activeResult?.status === 'completed' && activeResult.findings.length > 0 ? (
                  /* Show completed findings */
                  <div className="p-6">
                    {activeResult.summary && (
                      <p className="text-xs text-text-secondary mb-4 leading-relaxed">
                        {activeResult.summary}
                      </p>
                    )}
                    <HealthFindingsList
                      findings={activeResult.findings}
                      selectedFindings={selectedFindings}
                      onToggle={onToggleFinding}
                      onConvertToChat={onConvertToChat}
                      trackName={activeTrack.name}
                      score={activeResult.score}
                    />
                  </div>
                ) : activeResult?.status === 'completed' ? (
                  <div className="flex-1 flex items-center justify-center p-6">
                    <div className="text-center">
                      <CheckCircle2 size={32} className="text-success mx-auto mb-2" />
                      <p className="text-sm text-text-primary font-medium">Audit Complete</p>
                      {activeResult.summary && (
                        <p className="text-xs text-text-secondary mt-1 max-w-md">
                          {activeResult.summary}
                        </p>
                      )}
                      <p className="text-xs text-text-muted mt-2 italic">
                        No analysis results available. Try re-running this auditor.
                      </p>
                    </div>
                  </div>
                ) : (
                  /* Chat-like streaming output */
                  <AuditStreamView
                    trackId={activeViewTrack}
                    trackName={activeTrack.name}
                    isStreaming={activeResult?.status === 'running'}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-text-muted">Select an auditor from the queue</p>
            </div>
          )}
        </div>

        {/* Right sidebar — 20% — track queue */}
        <div className="w-56 flex-shrink-0 border-l border-border-subtle bg-surface-raised overflow-y-auto">
          <div className="px-3 py-2">
            <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
              Queue
            </span>
          </div>
          <div className="space-y-0.5 px-1 pb-3">
            {currentRun.selectedTracks.map((trackId) => {
              const track = AUDIT_TRACKS[trackId]
              const result = currentRun.results.find((r) => r.trackId === trackId)
              const Icon = ICON_MAP[track?.icon ?? ''] ?? Code
              const isActive = trackId === activeViewTrack
              const isCompleted = result?.status === 'completed'

              return (
                <button
                  key={trackId}
                  onClick={() => setSelectedTrackId(trackId)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-all duration-300 ${
                    isActive
                      ? 'bg-primary-muted/40 border border-primary/30'
                      : 'hover:bg-surface-overlay border border-transparent'
                  } ${result?.status === 'running' ? 'animate-pulse' : ''}`}
                >
                  <Icon
                    size={14}
                    className={isActive ? 'text-primary-text' : 'text-text-muted'}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-text-primary truncate block">
                      {track?.name ?? trackId}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {isCompleted && result?.score !== null && result?.score !== undefined && (
                      <span
                        className={`text-[11px] font-bold ${getScoreColor(result.score)} transition-all duration-500`}
                      >
                        {result.score}
                      </span>
                    )}
                    <StatusIcon status={result?.status ?? 'pending'} />
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Bottom progress bar */}
      <div className="px-6 py-3 border-t border-border-subtle bg-surface-raised">
        <div className="flex items-center gap-3">
          <div className="flex-1 h-2 bg-surface-overlay rounded-full overflow-hidden">
            <div
              className="h-full bg-success rounded-full transition-all duration-500 ease-out"
              style={{ width: `${percentage}%` }}
            />
          </div>
          <span className="text-xs text-text-secondary whitespace-nowrap">
            {completedCount}/{totalCount} auditors ({percentage}%)
          </span>
        </div>
      </div>
    </div>
  )
}
