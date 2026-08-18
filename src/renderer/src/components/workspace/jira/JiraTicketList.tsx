import { Check } from 'lucide-react'
import type { JiraIssueRow } from '../../../../../shared/jira.types'

/** Status category → tone. Jira status names are per-instance, so this is a
 *  best-effort match on the common English defaults and falls back to neutral. */
function statusTone(status: string): string {
  const s = status.toLowerCase()
  if (['done', 'closed', 'resolved', 'complete'].some((t) => s.includes(t)))
    return 'bg-success-muted text-success border-success/20'
  if (['progress', 'review', 'testing'].some((t) => s.includes(t)))
    return 'bg-info-muted text-info border-info/20'
  if (['blocked', 'impediment'].some((t) => s.includes(t)))
    return 'bg-danger-muted text-danger border-danger/30'
  return 'bg-surface-base text-text-muted border-border-subtle'
}

function relativeDate(iso: string | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

export default function JiraTicketList({
  issues,
  selectedKeys,
  activeKey,
  onToggleSelected,
  onOpenDetail
}: {
  issues: JiraIssueRow[]
  selectedKeys: Set<string>
  activeKey: string | null
  onToggleSelected: (key: string) => void
  onOpenDetail: (key: string) => void
}): React.JSX.Element {
  return (
    <ul data-testid="jira-ticket-list" className="space-y-1">
      {issues.map((issue) => {
        const isSelected = selectedKeys.has(issue.key)
        const isActive = activeKey === issue.key

        return (
          <li key={issue.key}>
            <div
              className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors ${
                isActive
                  ? 'bg-primary-muted border-primary/20'
                  : isSelected
                    ? 'bg-surface-overlay border-accent/30'
                    : 'bg-surface-overlay border-border-subtle hover:border-border-default'
              }`}
            >
              {/* Selection and opening the detail view are separate targets:
                  ticking a row to batch-convert it must not also swap the
                  detail panel out from under the user. */}
              <button
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                aria-label={`Select ${issue.key}`}
                data-testid={`jira-ticket-select-${issue.key}`}
                onClick={() => onToggleSelected(issue.key)}
                className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                  isSelected
                    ? 'bg-accent border-accent text-white'
                    : 'border-border-default hover:border-accent'
                }`}
              >
                {isSelected && <Check size={11} />}
              </button>

              <button
                type="button"
                data-testid={`jira-ticket-row-${issue.key}`}
                onClick={() => onOpenDetail(issue.key)}
                className="flex-1 min-w-0 text-left group"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-[11px] text-accent shrink-0">{issue.key}</span>
                  <span className="text-xs text-text-primary truncate group-hover:text-accent transition-colors">
                    {issue.summary}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span
                    className={`text-[11px] px-1.5 rounded border ${statusTone(issue.status ?? '')}`}
                  >
                    {issue.status || 'Unknown'}
                  </span>
                  <span className="text-[11px] text-text-muted truncate">{issue.type}</span>
                  <span className="text-[11px] text-text-muted truncate">{issue.assignee}</span>
                  <span className="text-[11px] text-text-muted ml-auto shrink-0">
                    {relativeDate(issue.updated)}
                  </span>
                </div>
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
