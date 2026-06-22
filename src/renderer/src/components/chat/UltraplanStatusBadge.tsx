/**
 * UltraplanStatusBadge — shows a status pill when UltraPlan is active.
 *
 * Displays drafting/needs_input/ready states with appropriate colors and
 * an optional clickable link to open the Claude Code web session.
 */

import { Cloud, ExternalLink } from 'lucide-react'
import { useUltraplanStore, type UltraplanStatus } from '@renderer/store/ultraplan.store'

const STATUS_CONFIG: Record<
  Exclude<UltraplanStatus, 'idle' | 'approved' | 'cancelled'>,
  { label: string; dotColor: string; badgeStyle: string; pulse: boolean }
> = {
  drafting: {
    label: 'Planning in the cloud…',
    dotColor: 'bg-sky-400',
    badgeStyle: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
    pulse: true
  },
  needs_input: {
    label: 'Needs your input',
    dotColor: 'bg-warning',
    badgeStyle: 'bg-warning/10 text-warning border-warning/20',
    pulse: false
  },
  ready: {
    label: 'Plan ready — open in browser',
    dotColor: 'bg-success',
    badgeStyle: 'bg-success/10 text-success border-success/20',
    pulse: false
  }
}

export default function UltraplanStatusBadge(): React.JSX.Element | null {
  const status = useUltraplanStore((s) => s.status)
  const sessionUrl = useUltraplanStore((s) => s.sessionUrl)

  if (status === 'idle' || status === 'approved' || status === 'cancelled') return null

  const config = STATUS_CONFIG[status]
  if (!config) return null

  const handleOpenSession = (): void => {
    if (sessionUrl) {
      window.open(sessionUrl, '_blank')
    }
  }

  return (
    <button
      type="button"
      onClick={sessionUrl ? handleOpenSession : undefined}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${config.badgeStyle} ${sessionUrl ? 'cursor-pointer hover:brightness-110' : 'cursor-default'}`}
      title={sessionUrl ? 'Open in Claude Code web' : config.label}
      data-testid="ultraplan-status-badge"
    >
      <Cloud className="w-3 h-3" />
      <span
        className={`w-1.5 h-1.5 rounded-full ${config.dotColor} ${config.pulse ? 'animate-pulse' : ''}`}
      />
      <span>{status === 'drafting' ? '◇ ultraplan' : '◆ ultraplan ready'}</span>
      {sessionUrl && <ExternalLink className="w-3 h-3 opacity-60" />}
    </button>
  )
}
