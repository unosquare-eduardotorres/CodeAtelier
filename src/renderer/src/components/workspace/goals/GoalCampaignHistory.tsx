/**
 * GoalCampaignHistory — past campaigns as grouped, expandable entries.
 *
 * Each campaign expands (lazy-loading its runs via mpaCampaignGetDetail) to show
 * its goal runs; selecting a run delegates to onSelectRun, which reuses the
 * existing GoalRunDetail view.
 */

import { useState, useCallback, type JSX } from 'react'
import { ChevronRight, ChevronDown, Layers, Loader2 } from 'lucide-react'
import { useMpaStore } from '@renderer/store/mpa.store'
import { RUN_STATUS_CONFIG } from './constants'
import type { MpaCampaign, MpaRun } from '../../../../../shared/mpa-types'

interface GoalCampaignHistoryProps {
  onSelectRun?: (runId: string) => void
}

export default function GoalCampaignHistory({
  onSelectRun
}: GoalCampaignHistoryProps): JSX.Element | null {
  const campaigns = useMpaStore((s) => s.campaignHistory)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [runsByCampaign, setRunsByCampaign] = useState<Record<string, MpaRun[]>>({})
  const [loadingId, setLoadingId] = useState<string | null>(null)

  const toggle = useCallback(
    async (campaignId: string) => {
      if (expanded === campaignId) {
        setExpanded(null)
        return
      }
      setExpanded(campaignId)
      if (!runsByCampaign[campaignId]) {
        setLoadingId(campaignId)
        try {
          const detail = (await window.api.mpaCampaignGetDetail({ campaignId })) as {
            campaign: MpaCampaign
            runs: MpaRun[]
          } | null
          if (detail) {
            setRunsByCampaign((prev) => ({ ...prev, [campaignId]: detail.runs }))
          }
        } finally {
          setLoadingId(null)
        }
      }
    },
    [expanded, runsByCampaign]
  )

  if (campaigns.length === 0) return null

  return (
    <div data-testid="goal-campaign-history" className="space-y-2">
      <h4 className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
        <Layers size={13} className="text-cyan-400" /> Campaigns
      </h4>

      {campaigns.map((c: MpaCampaign) => {
        const config = RUN_STATUS_CONFIG[c.status] ?? RUN_STATUS_CONFIG.running
        const isOpen = expanded === c.id
        const runs = runsByCampaign[c.id] ?? []
        const date = new Date(c.createdAt).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric'
        })
        return (
          <div
            key={c.id}
            className="bg-surface-overlay rounded-lg border border-border-subtle overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggle(c.id)}
              className="w-full flex items-center gap-2.5 p-3 hover:bg-surface-base transition-colors text-left"
            >
              {isOpen ? (
                <ChevronDown size={14} className="text-text-muted flex-shrink-0" />
              ) : (
                <ChevronRight size={14} className="text-text-muted flex-shrink-0" />
              )}
              <span className={config.color}>{config.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text-primary truncate">{c.title}</p>
                <p className="text-[10px] text-text-muted">
                  {date} · campaign · {config.label}
                </p>
              </div>
            </button>

            {isOpen && (
              <div className="border-t border-border-subtle px-3 py-2 space-y-1">
                {loadingId === c.id ? (
                  <div className="flex items-center gap-2 text-xs text-text-muted py-1">
                    <Loader2 size={12} className="animate-spin" /> Loading goals…
                  </div>
                ) : runs.length === 0 ? (
                  <p className="text-xs text-text-muted py-1">No goal runs recorded.</p>
                ) : (
                  runs.map((run, i) => {
                    const rc = RUN_STATUS_CONFIG[run.status] ?? RUN_STATUS_CONFIG.running
                    return (
                      <button
                        type="button"
                        key={run.id}
                        onClick={() => onSelectRun?.(run.id)}
                        className="w-full flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-surface-base transition-colors text-left"
                      >
                        <span className="flex items-center justify-center w-4 h-4 rounded-full bg-cyan-500/15 text-cyan-400 text-[10px] font-semibold flex-shrink-0">
                          {(run.orderIndex ?? i) + 1}
                        </span>
                        <span className={rc.color}>{rc.icon}</span>
                        <span className="flex-1 min-w-0 text-xs text-text-secondary truncate">
                          {run.title}
                        </span>
                      </button>
                    )
                  })
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
