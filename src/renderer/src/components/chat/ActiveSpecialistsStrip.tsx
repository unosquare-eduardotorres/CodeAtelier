import { useEffect, useMemo } from 'react'
import { Loader2, Settings2, Users } from 'lucide-react'
import {
  useConversationSpecialistActions,
  useConversationSpecialists,
  useConversationSpecialistStatus,
  useConversationTokenEstimates,
  useSpecialistStore
} from '@renderer/store'

interface ActiveSpecialistsStripProps {
  conversationId: string
  onOpenDrawer?: () => void
  className?: string
}

const TOKEN_FORMATTER = new Intl.NumberFormat('en-US')

export default function ActiveSpecialistsStrip({
  conversationId,
  onOpenDrawer,
  className
}: ActiveSpecialistsStripProps): React.JSX.Element {
  const conversationSpecialists = useConversationSpecialists(conversationId)
  const tokenEstimates = useConversationTokenEstimates(conversationId)
  const { isLoading, isEstimating, error } = useConversationSpecialistStatus(conversationId)
  const { hydrateConversationSpecialists } = useConversationSpecialistActions()
  const workspaceSpecialists = useSpecialistStore((state) => state.specialists)

  useEffect(() => {
    void hydrateConversationSpecialists(conversationId).catch(() => undefined)
  }, [conversationId, hydrateConversationSpecialists])

  const specialistMap = useMemo(
    () => new Map(workspaceSpecialists.map((specialist) => [specialist.id, specialist])),
    [workspaceSpecialists]
  )

  const estimateMap = useMemo(
    () => new Map(tokenEstimates.map((estimate) => [estimate.specialistId, estimate])),
    [tokenEstimates]
  )

  const activeSpecialists = useMemo(
    () => conversationSpecialists.filter((specialist) => specialist.isActive),
    [conversationSpecialists]
  )

  const totalEstimatedTokens = useMemo(
    () => tokenEstimates.reduce((sum, estimate) => sum + estimate.estimatedTokens, 0),
    [tokenEstimates]
  )

  const rootClassName = [
    'flex items-center justify-between gap-3 px-6 py-2 border-b border-border-subtle bg-surface-overlay/70',
    className
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClassName}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-1.5 text-text-secondary shrink-0">
          <Users size={14} />
          <span className="text-xs font-medium">Specialists</span>
        </div>

        {isLoading && activeSpecialists.length === 0 ? (
          <div className="flex items-center gap-1.5 text-xs text-text-muted">
            <Loader2 size={12} className="animate-spin" />
            <span>Loading…</span>
          </div>
        ) : activeSpecialists.length > 0 ? (
          <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto no-scrollbar">
            {activeSpecialists.map((entry) => {
              const specialist = entry.specialist ?? specialistMap.get(entry.specialistId)
              const label = specialist?.alias || specialist?.displayName || entry.specialistId
              const color = specialist?.color ?? '#6B7280'
              const icon = specialist?.icon ?? '🤖'
              const estimate = estimateMap.get(entry.specialistId)

              return (
                <span
                  key={entry.id}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-float border border-border-default text-[11px] text-text-body whitespace-nowrap"
                  title={estimate ? `${label} · ~${estimate.estimatedTokens} tokens` : label}
                >
                  <span
                    className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px]"
                    style={{ backgroundColor: `${color}22`, color }}
                  >
                    {icon}
                  </span>
                  <span className="max-w-28 truncate">{label}</span>
                </span>
              )
            })}
          </div>
        ) : (
          <span className="text-xs text-text-muted">
            No active specialists for this conversation
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <span className="text-[11px] text-text-secondary">
          {isEstimating ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 size={11} className="animate-spin" />
              Estimating
            </span>
          ) : (
            `~${TOKEN_FORMATTER.format(totalEstimatedTokens)} tokens`
          )}
        </span>
        <button
          type="button"
          onClick={onOpenDrawer}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border-default bg-surface-float text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors text-[11px] font-medium"
          aria-label="Manage conversation specialists"
        >
          <Settings2 size={12} />
          Manage
        </button>
      </div>

      {error && <span className="sr-only">{error}</span>}
    </div>
  )
}
