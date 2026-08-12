import { Loader2, AlertTriangle } from 'lucide-react'

export type SessionRecoveryPhase =
  'started' | 'building_context' | 'resuming' | 'completed' | 'failed'

interface SessionRecoveryBannerProps {
  phase: SessionRecoveryPhase
  message: string
}

export default function SessionRecoveryBanner({
  phase,
  message
}: SessionRecoveryBannerProps): React.JSX.Element | null {
  if (phase === 'completed') return null

  const isFailed = phase === 'failed'
  const Icon = isFailed ? AlertTriangle : Loader2

  return (
    <div
      data-testid="session-recovery-banner"
      className={`
        mx-4 mt-2 flex items-center gap-3 rounded-lg border px-4 py-3
        ${
          isFailed
            ? 'border-red-500/20 bg-red-500/5 text-red-400'
            : 'border-amber-500/20 bg-amber-500/5 text-amber-300'
        }
        animate-in fade-in slide-in-from-top-2 duration-300
      `}
    >
      <Icon size={16} className={isFailed ? '' : 'animate-spin'} />
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">
          {isFailed ? 'Recovery Failed' : 'Recovering Session'}
        </span>
        <span className="text-xs opacity-70">{message}</span>
      </div>
    </div>
  )
}
