/**
 * HealthTrackSidebar — persistent left sidebar with compact track cards.
 *
 * Always visible in the unified health layout. Each card shows checkbox,
 * icon, name, score, and status. Clicking the card body navigates the
 * detail panel; clicking the checkbox toggles track selection.
 */

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
  Ban
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AuditTrackId, AuditResult } from '../../../../shared/types'
import { AUDIT_TRACKS } from '../../../../shared/constants'

const ICON_MAP: Record<string, LucideIcon> = {
  Database,
  Code,
  TestTube,
  Building2,
  Shield,
  FileText,
  Palette
}

const ALL_TRACK_IDS = Object.keys(AUDIT_TRACKS) as AuditTrackId[]

function getScoreColor(score: number): string {
  if (score <= 20) return 'text-danger'
  if (score <= 40) return 'text-danger'
  if (score <= 60) return 'text-warning'
  if (score <= 80) return 'text-success'
  return 'text-success'
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

interface HealthTrackSidebarProps {
  selectedTracks: Set<AuditTrackId>
  onToggleTrack: (trackId: AuditTrackId) => void
  activeTrackId: AuditTrackId | null
  onSelectTrack: (trackId: AuditTrackId) => void
  results: AuditResult[]
  isRunning: boolean
  allSelected: boolean
  onToggleAll: () => void
}

export default function HealthTrackSidebar({
  selectedTracks,
  onToggleTrack,
  activeTrackId,
  onSelectTrack,
  results,
  isRunning,
  allSelected,
  onToggleAll
}: HealthTrackSidebarProps): React.JSX.Element {
  return (
    <div className="w-72 flex-shrink-0 border-r border-border-subtle bg-surface-raised overflow-y-auto">
      {/* Select All / Deselect All header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
        <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">
          Auditors
        </span>
        <button
          onClick={onToggleAll}
          disabled={isRunning}
          className="text-[10px] font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {allSelected ? 'Deselect All' : 'Select All'}
        </button>
      </div>

      {/* Track cards */}
      <div className="py-1">
        {ALL_TRACK_IDS.map((trackId) => {
          const track = AUDIT_TRACKS[trackId]
          const result = results.find((r) => r.trackId === trackId)
          const Icon = ICON_MAP[track.icon] ?? Code
          const isActive = trackId === activeTrackId
          const isSelected = selectedTracks.has(trackId)
          const status = result?.status
          const score = result?.score ?? null
          const isTrackRunning = status === 'running'

          return (
            <button
              key={trackId}
              onClick={() => onSelectTrack(trackId)}
              className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-all duration-200 ${
                isActive
                  ? 'bg-primary-muted/30 border-l-2 border-primary'
                  : 'border-l-2 border-transparent hover:bg-surface-overlay/50'
              } ${isTrackRunning ? 'animate-pulse' : ''}`}
            >
              {/* Checkbox — click stops propagation */}
              <input
                type="checkbox"
                checked={isSelected}
                disabled={isRunning}
                onChange={(e) => {
                  e.stopPropagation()
                  onToggleTrack(trackId)
                }}
                onClick={(e) => e.stopPropagation()}
                className="mt-0.5 w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary/50 disabled:opacity-40 flex-shrink-0"
              />

              {/* Icon */}
              <div className="flex-shrink-0 mt-0.5">
                <Icon
                  size={18}
                  className={
                    isActive
                      ? 'text-primary-text'
                      : isSelected
                        ? 'text-text-primary'
                        : 'text-text-muted'
                  }
                />
              </div>

              {/* Name + description */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-text-primary truncate">
                    {track.name}
                  </span>
                </div>
                <p className="text-[10px] text-text-muted line-clamp-1 mt-0.5">
                  {track.description}
                </p>
              </div>

              {/* Score + status indicator (right-aligned) */}
              <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                {status === 'completed' && score !== null && (
                  <span className={`text-[11px] font-bold ${getScoreColor(score)}`}>{score}</span>
                )}
                {status && <StatusIndicator status={status} />}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
