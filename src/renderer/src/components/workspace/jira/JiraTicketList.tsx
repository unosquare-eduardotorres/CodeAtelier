import { useEffect, useRef } from 'react'
import { BookOpen, Check } from 'lucide-react'
import type { JiraIssueRow } from '../../../../../shared/jira.types'
import { priorityImportance, type JiraProjectGroup } from '../../../../../shared/jira-list-view'

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

/** Urgency → tone, driven by the same table the priority sort uses. */
function priorityTone(priority: string | undefined): string {
  const importance = priorityImportance(priority)
  if (importance === null) return 'text-text-muted'
  if (importance >= 5) return 'text-danger'
  if (importance === 4) return 'text-warning'
  return 'text-text-muted'
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

interface RowProps {
  issue: JiraIssueRow
  isSelected: boolean
  isActive: boolean
  isCursor: boolean
  blueprintId: string | undefined
  onToggleSelected: (key: string) => void
  onOpenDetail: (key: string) => void
  onOpenBlueprint: (blueprintId: string) => void
}

function JiraTicketRow({
  issue,
  isSelected,
  isActive,
  isCursor,
  blueprintId,
  onToggleSelected,
  onOpenDetail,
  onOpenBlueprint
}: RowProps): React.JSX.Element {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors ${
        isCursor ? 'ring-1 ring-accent/50 ' : ''
      }${
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
          <span className={`text-[11px] px-1.5 rounded border ${statusTone(issue.status ?? '')}`}>
            {issue.status || 'Unknown'}
          </span>
          {issue.priority && (
            <span className={`text-[11px] shrink-0 ${priorityTone(issue.priority)}`}>
              {issue.priority}
            </span>
          )}
          <span className="text-[11px] text-text-muted truncate">{issue.type}</span>
          <span className="text-[11px] text-text-muted truncate">{issue.assignee}</span>
          {issue.parentKey && (
            <span className="text-[11px] text-text-muted font-mono shrink-0">
              ↑{issue.parentKey}
            </span>
          )}
          <span className="text-[11px] text-text-muted ml-auto shrink-0">
            {relativeDate(issue.updated)}
          </span>
        </div>
      </button>

      {/* Already converted. Shown before the click rather than as a "skipped"
          line in the result box after it. */}
      {blueprintId && (
        <button
          type="button"
          data-testid={`jira-ticket-converted-${issue.key}`}
          title="Already converted — open the blueprint"
          onClick={() => onOpenBlueprint(blueprintId)}
          className="flex items-center gap-1 shrink-0 text-[11px] px-1.5 py-0.5 rounded-full border border-success/20 bg-success-muted text-success hover:border-success/50 transition-colors"
        >
          <BookOpen size={11} />
          Blueprint
        </button>
      )}
    </div>
  )
}

export default function JiraTicketList({
  issues,
  groups,
  selectedKeys,
  activeKey,
  cursorKey,
  convertedKeys,
  onToggleSelected,
  onOpenDetail,
  onOpenBlueprint
}: {
  issues: JiraIssueRow[]
  /** Project buckets, or null to render one flat list. */
  groups?: JiraProjectGroup[] | null
  selectedKeys: Set<string>
  activeKey: string | null
  cursorKey?: string | null
  convertedKeys?: Record<string, string>
  onToggleSelected: (key: string) => void
  onOpenDetail: (key: string) => void
  onOpenBlueprint?: (blueprintId: string) => void
}): React.JSX.Element {
  const cursorRef = useRef<HTMLLIElement | null>(null)

  // Keyboard navigation is useless if the row it lands on is off screen.
  useEffect(() => {
    cursorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [cursorKey])

  const converted = convertedKeys ?? {}
  const openBlueprint = onOpenBlueprint ?? ((): void => {})

  const renderRow = (issue: JiraIssueRow): React.JSX.Element => (
    <li key={issue.key} ref={cursorKey === issue.key ? cursorRef : undefined}>
      <JiraTicketRow
        issue={issue}
        isSelected={selectedKeys.has(issue.key)}
        isActive={activeKey === issue.key}
        isCursor={cursorKey === issue.key}
        blueprintId={converted[issue.key]}
        onToggleSelected={onToggleSelected}
        onOpenDetail={onOpenDetail}
        onOpenBlueprint={openBlueprint}
      />
    </li>
  )

  if (groups) {
    return (
      <div data-testid="jira-ticket-list" className="space-y-3">
        {groups.map((group) => (
          <div key={group.project} data-testid={`jira-project-group-${group.project}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-[11px] text-text-secondary">{group.project}</span>
              <span className="text-[11px] text-text-muted">{group.rows.length}</span>
              <div className="flex-1 h-px bg-border-subtle" />
            </div>
            <ul className="space-y-1">{group.rows.map(renderRow)}</ul>
          </div>
        ))}
      </div>
    )
  }

  return (
    <ul data-testid="jira-ticket-list" className="space-y-1">
      {issues.map(renderRow)}
    </ul>
  )
}
