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
  ChevronDown,
  ChevronRight
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AuditTrackId, AuditResult, AuditFinding, AuditTrack } from '../../../../shared/types'
import HealthFindingsList from './HealthFindingsList'

const ICON_MAP: Record<string, LucideIcon> = {
  Database,
  Code,
  TestTube,
  Building2,
  Shield,
  FileText,
  Palette
}

interface HealthAuditorCardProps {
  track: AuditTrack
  result: AuditResult | null
  isSelected: boolean
  onToggleSelect: (trackId: AuditTrackId) => void
  isRunning: boolean
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

function getScoreBgColor(score: number): string {
  if (score <= 20) return 'bg-danger/10'
  if (score <= 40) return 'bg-danger/10'
  if (score <= 60) return 'bg-warning/10'
  if (score <= 80) return 'bg-success/10'
  return 'bg-success/10'
}

function StatusIndicator({ status }: { status: string }): React.JSX.Element {
  switch (status) {
    case 'completed':
      return <CheckCircle2 size={14} className="text-success" />
    case 'running':
      return <Loader2 size={14} className="text-info animate-spin" />
    case 'failed':
      return <XCircle size={14} className="text-danger" />
    case 'cancelled':
      return <Ban size={14} className="text-text-muted" />
    case 'pending':
    default:
      return <Clock size={14} className="text-text-muted" />
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Done'
    case 'running':
      return 'Running…'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'pending':
      return 'Pending'
    default:
      return status
  }
}

export default function HealthAuditorCard({
  track,
  result,
  isSelected,
  onToggleSelect,
  isRunning: auditRunning,
  selectedFindings,
  onToggleFinding,
  onConvertToChat
}: HealthAuditorCardProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)

  const Icon = ICON_MAP[track.icon] ?? Code
  const status = result?.status ?? (isSelected ? 'pending' : undefined)
  const score = result?.score ?? null
  const findings = result?.findings ?? []

  const cardBorderClass = (() => {
    if (status === 'running') return 'border-info/40 animate-pulse'
    if (status === 'completed') return 'border-success/30'
    if (status === 'failed') return 'border-danger/30'
    if (isSelected) return 'border-primary/20'
    return 'border-border-subtle'
  })()

  const isCardDisabled = auditRunning

  return (
    <div
      className={`rounded-xl border ${cardBorderClass} bg-surface-raised transition-all flex flex-col`}
    >
      {/* Card header — checkbox top-left, score top-right */}
      <div className="flex items-center justify-between p-3 pb-0">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(track.id)}
          disabled={isCardDisabled}
          className="rounded border-border-subtle text-primary focus:ring-primary/50 disabled:opacity-40"
        />
        {score !== null && (
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded-full ${getScoreColor(score)} ${getScoreBgColor(score)}`}
          >
            {score}
          </span>
        )}
      </div>

      {/* Large centered icon + name + description */}
      <div className="flex flex-col items-center text-center px-4 py-3 gap-2">
        <div
          className={`w-14 h-14 rounded-xl flex items-center justify-center ${
            isSelected ? 'bg-primary-muted/60' : 'bg-surface-overlay'
          }`}
        >
          <Icon size={32} className={isSelected ? 'text-primary-text' : 'text-text-muted'} />
        </div>

        <div>
          <div className="flex items-center justify-center gap-1.5">
            <span
              className={`text-sm font-semibold ${isSelected ? 'text-text-primary' : 'text-text-muted'}`}
            >
              {track.name}
            </span>
            {status && (
              <div className="flex items-center gap-1">
                <StatusIndicator status={status} />
                <span className="text-[10px] text-text-muted">{statusLabel(status)}</span>
              </div>
            )}
          </div>
          <p className="text-[11px] text-text-secondary mt-1 leading-relaxed line-clamp-2">
            {track.description}
          </p>
        </div>
      </div>

      {/* Scoring focus pills */}
      <div className="flex flex-wrap justify-center gap-1 px-3 pb-3">
        {track.scoringFocus.slice(0, 3).map((focus, i) => (
          <span
            key={i}
            className="px-2 py-0.5 text-[10px] bg-surface-overlay text-text-muted rounded-full"
          >
            {focus.length > 24 ? focus.slice(0, 22) + '…' : focus}
          </span>
        ))}
        {track.scoringFocus.length > 3 && (
          <span className="px-2 py-0.5 text-[10px] text-text-muted">
            +{track.scoringFocus.length - 3}
          </span>
        )}
      </div>

      {/* Expand toggle (only when there are findings) */}
      {findings.length > 0 && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center justify-center gap-1.5 w-full px-3 py-2 text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface-overlay/50 transition-colors border-t border-border-subtle"
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {findings.length} finding{findings.length !== 1 ? 's' : ''}
        </button>
      )}

      {/* Expanded findings */}
      {isExpanded && findings.length > 0 && (
        <div className="px-3 pb-3 border-t border-border-subtle pt-2">
          <HealthFindingsList
            findings={findings}
            selectedFindings={selectedFindings}
            onToggle={onToggleFinding}
            onConvertToChat={onConvertToChat}
            trackName={track.name}
            score={score}
          />
        </div>
      )}

      {/* Failed error message */}
      {status === 'failed' && result?.summary && (
        <div className="px-3 pb-3">
          <p className="text-[11px] text-danger">{result.summary}</p>
        </div>
      )}
    </div>
  )
}
