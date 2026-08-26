import { useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink, Loader2, MessageSquarePlus, X } from 'lucide-react'
import { Button } from '@renderer/components/common/ui'
import type { JiraIssueDetail } from '../../../../../shared/jira.types'
import JiraIssueActions from './JiraIssueActions'

/**
 * Read-side detail for one ticket, plus the comment composer — the one place
 * this panel writes back to Jira.
 *
 * The parent mounts this with `key={issueKey}`, so switching tickets remounts
 * rather than mutating state in place. That is what keeps the load effect free
 * of the "reset every field first" block that would otherwise be needed to stop
 * the previous ticket's body and half-typed comment leaking into the new one.
 */
export default function JiraTicketDetail({
  workspaceId,
  issueKey,
  onClose
}: {
  workspaceId: string
  issueKey: string
  onClose: () => void
}): React.JSX.Element {
  const [issue, setIssue] = useState<JiraIssueDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    window.api
      .jiraGetIssue({ workspaceId, issueKey })
      .then((next) => {
        if (!cancelled) setIssue(next)
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load issue.')
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId, issueKey])

  /** Re-read the issue so an assignee or status change is visible immediately. */
  const reload = (): void => {
    window.api
      .jiraGetIssue({ workspaceId, issueKey })
      .then(setIssue)
      .catch((err: unknown) =>
        console.warn('[JiraTicketDetail] Non-fatal: reload after write failed:', err)
      )
  }

  const handlePostComment = async (): Promise<void> => {
    const body = comment.trim()
    if (body.length === 0) return
    setPosting(true)
    setPostError(null)
    try {
      await window.api.jiraAddComment({ workspaceId, issueKey, body })
      setComment('')
      // Re-fetch so the new comment appears in the thread rather than being
      // optimistically faked — Jira rewrites the body and stamps the author.
      setIssue(await window.api.jiraGetIssue({ workspaceId, issueKey }))
    } catch (err) {
      setPostError(err instanceof Error ? err.message : 'Failed to post comment.')
    } finally {
      setPosting(false)
    }
  }

  return (
    <aside
      data-testid="jira-ticket-detail"
      className="w-96 shrink-0 border-l border-border-subtle bg-surface-base flex flex-col min-h-0"
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-subtle shrink-0">
        <span className="font-mono text-[11px] text-accent">{issueKey}</span>
        {issue && (
          <button
            type="button"
            onClick={() => window.open(issue.browseUrl, '_blank', 'noopener,noreferrer')}
            className="text-text-muted hover:text-accent transition-colors"
            title="Open in Jira"
            aria-label="Open in Jira"
          >
            <ExternalLink size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-text-muted hover:text-text-primary transition-colors"
          aria-label="Close ticket detail"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 min-h-0">
        {loadError && (
          <div className="flex items-start gap-2 bg-warning-muted border border-warning/20 rounded-md p-2.5 text-[11px] text-text-secondary">
            <AlertTriangle size={12} className="text-warning mt-0.5 shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {!issue && !loadError && (
          <div className="flex items-center gap-2 text-[11px] text-text-muted">
            <Loader2 size={12} className="animate-spin" /> Loading ticket…
          </div>
        )}

        {issue && (
          <>
            <div>
              <h4 className="text-sm font-semibold text-text-primary">{issue.summary}</h4>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[11px] text-text-muted">
                {issue.status && <span>Status: {issue.status}</span>}
                {issue.type && <span>Type: {issue.type}</span>}
                {issue.priority && <span>Priority: {issue.priority}</span>}
                <span>Assignee: {issue.assignee}</span>
                {issue.reporter && <span>Reporter: {issue.reporter}</span>}
              </div>
              {issue.labels.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {issue.labels.map((label) => (
                    <span
                      key={label}
                      className="text-[11px] px-1.5 rounded border border-border-subtle text-text-muted"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <JiraIssueActions workspaceId={workspaceId} issueKey={issueKey} onChanged={reload} />

            <section>
              <h5 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">
                Description
              </h5>
              <p className="text-xs text-text-secondary whitespace-pre-wrap leading-relaxed">
                {issue.description || 'No description.'}
              </p>
            </section>

            <section>
              <h5 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">
                Recent comments ({issue.comments.length})
              </h5>
              {issue.comments.length === 0 ? (
                <p className="text-[11px] text-text-muted">No comments yet.</p>
              ) : (
                <ul className="space-y-2">
                  {issue.comments.map((c, i) => (
                    <li
                      key={`${c.author}-${c.created ?? i}`}
                      className="bg-surface-overlay border border-border-subtle rounded-md p-2"
                    >
                      <div className="text-[11px] text-text-muted mb-0.5">
                        {c.author}
                        {c.created ? ` · ${new Date(c.created).toLocaleDateString()}` : ''}
                      </div>
                      <p className="text-xs text-text-secondary whitespace-pre-wrap">{c.body}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>

      {issue && (
        <div className="border-t border-border-subtle p-3 space-y-2 shrink-0">
          <label
            htmlFor={`jira-comment-${issueKey}`}
            className="block text-[11px] font-medium text-text-secondary"
          >
            Add a comment
          </label>
          <textarea
            id={`jira-comment-${issueKey}`}
            data-testid="jira-comment-input"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Posts to Jira as your account. Blank lines separate paragraphs."
            className="w-full bg-surface-overlay border border-border-default rounded px-2 py-1.5 text-xs text-text-primary resize-y"
          />
          {postError && (
            <p className="text-[11px] text-warning" data-testid="jira-comment-error">
              {postError}
            </p>
          )}
          <Button
            variant="primary"
            size="xs"
            data-testid="jira-comment-submit"
            onClick={handlePostComment}
            disabled={posting || comment.trim().length === 0}
          >
            {posting ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <MessageSquarePlus size={11} />
            )}
            {posting ? 'Posting…' : 'Comment'}
          </Button>
        </div>
      )}
    </aside>
  )
}
