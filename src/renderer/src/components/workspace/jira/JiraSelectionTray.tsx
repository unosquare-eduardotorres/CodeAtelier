import { BookOpen, ListChecks, X } from 'lucide-react'
import { Button, PanelHeader, StatPill } from '@renderer/components/common/ui'
import type { JiraIssueRow } from '../../../../../shared/jira.types'
import { deriveGroupTitle, sharedParentOf } from '../../../../../shared/jira-format'

/**
 * Review surface for a multi-ticket selection.
 *
 * The toolbar is where the selection is *acted on*; this is where it is *read*.
 * Ten ticked checkboxes scattered down a list is not a reviewable set — you
 * cannot see what you picked without scrolling past what you did not, and the
 * one thing that matters most (that all ten become a single blueprint, under a
 * title derived from them) was previously invisible until after the click.
 *
 * So the derived title is shown read-only here, and tickets that already have a
 * blueprint are called out inline rather than reported as "skipped" afterwards.
 */
export default function JiraSelectionTray({
  selected,
  convertedKeys,
  onRemove,
  onClear,
  onOpenBlueprint
}: {
  /** The selected rows, in selection order. */
  selected: JiraIssueRow[]
  /** issueKey → blueprint id for tickets already converted. */
  convertedKeys: Record<string, string>
  onRemove: (key: string) => void
  onClear: () => void
  onOpenBlueprint: (blueprintId: string) => void
}): React.JSX.Element {
  // The blueprint is built from the tickets that are not already converted, so
  // the title has to be derived from those — otherwise it would promise a title
  // the conversion will not produce.
  const convertible = selected.filter((issue) => convertedKeys[issue.key] === undefined)
  const alreadyConverted = selected.length - convertible.length
  // "Epic" is the normal case, but a group of sub-tasks shares a story instead
  // — the pill names whichever it actually is.
  const parent = sharedParentOf(convertible)

  return (
    <div data-testid="jira-selection-tray" className="flex-1 flex flex-col min-h-0">
      <div className="p-3 space-y-2 border-b border-border-subtle shrink-0">
        <PanelHeader
          title="Selected tickets"
          icon={<ListChecks size={13} />}
          actions={
            selected.length > 0 && (
              <Button size="xs" variant="ghost" data-testid="jira-tray-clear" onClick={onClear}>
                Clear all
              </Button>
            )
          }
        />

        <div className="flex items-center gap-1.5 flex-wrap">
          <StatPill label="selected" value={selected.length} />
          {alreadyConverted > 0 && (
            <StatPill
              label="already converted"
              value={alreadyConverted}
              tone="success"
              title="These keep their existing blueprint — converting again would create a second one for the same work."
            />
          )}
          {parent && (
            <StatPill
              label={(parent.type ?? 'parent').toLowerCase()}
              value={parent.key}
              tone="info"
              title={parent.summary}
            />
          )}
        </div>

        {convertible.length > 0 && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-0.5">
              Blueprint title
            </p>
            <p data-testid="jira-tray-derived-title" className="text-xs text-text-primary">
              {deriveGroupTitle(convertible)}
            </p>
            <p className="text-[11px] text-text-muted mt-0.5">
              {convertible.length === 1
                ? 'One ticket, one blueprint.'
                : `All ${convertible.length} become one blueprint on one branch.`}
            </p>
          </div>
        )}
      </div>

      <ul className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
        {selected.length === 0 && (
          <li className="text-xs text-text-secondary p-1">
            Tick tickets in the list to build a selection.
          </li>
        )}

        {selected.map((issue) => {
          const blueprintId = convertedKeys[issue.key]
          return (
            <li
              key={issue.key}
              data-testid={`jira-tray-item-${issue.key}`}
              className="flex items-start gap-2 rounded-md border border-border-subtle bg-surface-overlay px-2 py-1.5"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-[11px] text-accent shrink-0">{issue.key}</span>
                  <span className="text-xs text-text-primary truncate">{issue.summary}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="text-[11px] text-text-muted">{issue.status || 'Unknown'}</span>
                  {blueprintId && (
                    <button
                      type="button"
                      data-testid={`jira-tray-converted-${issue.key}`}
                      onClick={() => onOpenBlueprint(blueprintId)}
                      title="Already converted — this ticket will be left alone"
                      className="flex items-center gap-1 text-[11px] text-success hover:underline"
                    >
                      <BookOpen size={11} />
                      Already a blueprint — will be skipped
                    </button>
                  )}
                </div>
              </div>

              <button
                type="button"
                aria-label={`Remove ${issue.key} from the selection`}
                data-testid={`jira-tray-remove-${issue.key}`}
                onClick={() => onRemove(issue.key)}
                className="shrink-0 text-text-muted hover:text-danger transition-colors mt-0.5"
              >
                <X size={12} />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
