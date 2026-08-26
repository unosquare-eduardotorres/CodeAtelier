import { useEffect, useState } from 'react'
import { Loader2, UserCheck } from 'lucide-react'
import { Button } from '@renderer/components/common/ui'
import type { JiraTransition } from '../../../../../shared/jira.types'

/**
 * The two writes that mean "I am picking this up": claim the ticket, and move
 * it along the workflow.
 *
 * Both are explicit, single-click actions with the outcome named before it
 * happens — the transition dropdown shows the status the issue will land in,
 * not an opaque transition id. Neither is ever folded into another action:
 * these write to a tracker the whole team reads, and a status change nobody
 * asked for is worse than no status change.
 *
 * The transition list is fetched per issue because transition ids are
 * per-workflow: "In Progress" is 21 on one project and 4 on the next.
 */
export default function JiraIssueActions({
  workspaceId,
  issueKey,
  onChanged
}: {
  workspaceId: string
  issueKey: string
  onChanged: () => void
}): React.JSX.Element {
  const [transitions, setTransitions] = useState<JiraTransition[]>([])
  const [transitionId, setTransitionId] = useState('')
  const [busy, setBusy] = useState<null | 'assign' | 'transition'>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .jiraListTransitions({ workspaceId, issueKey })
      .then((next) => {
        if (!cancelled) setTransitions(next)
      })
      // A workflow this account cannot move is not an error worth a banner —
      // the control simply does not render.
      .catch(() => {
        if (!cancelled) setTransitions([])
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, issueKey])

  const handleAssign = async (): Promise<void> => {
    setBusy('assign')
    setError(null)
    setNotice(null)
    try {
      const user = await window.api.jiraAssignToMe({ workspaceId, issueKey })
      setNotice(`Assigned to ${user.displayName}.`)
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign the ticket.')
    } finally {
      setBusy(null)
    }
  }

  const handleTransition = async (): Promise<void> => {
    const target = transitions.find((t) => t.id === transitionId)
    if (!target) return
    setBusy('transition')
    setError(null)
    setNotice(null)
    try {
      await window.api.jiraTransitionIssue({ workspaceId, issueKey, transitionId: target.id })
      setNotice(`Moved to ${target.toStatus ?? target.name}.`)
      setTransitionId('')
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move the ticket.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section data-testid="jira-issue-actions" className="space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Button
          size="xs"
          data-testid="jira-assign-to-me"
          onClick={handleAssign}
          disabled={busy !== null}
          title="Assign this ticket to the account these credentials belong to"
        >
          {busy === 'assign' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <UserCheck size={11} />
          )}
          Assign to me
        </Button>

        {transitions.length > 0 && (
          <>
            <select
              aria-label="Move to status"
              data-testid="jira-transition-select"
              value={transitionId}
              onChange={(e) => setTransitionId(e.target.value)}
              className="bg-surface-overlay border border-border-default rounded px-1.5 py-1 text-[11px] text-text-primary max-w-[150px]"
            >
              <option value="">Move to…</option>
              {transitions.map((transition) => (
                <option key={transition.id} value={transition.id}>
                  {transition.toStatus ?? transition.name}
                </option>
              ))}
            </select>
            <Button
              size="xs"
              data-testid="jira-transition-submit"
              onClick={handleTransition}
              disabled={busy !== null || transitionId === ''}
            >
              {busy === 'transition' ? <Loader2 size={11} className="animate-spin" /> : null}
              Move
            </Button>
          </>
        )}
      </div>

      {notice && (
        <p className="text-[11px] text-success" data-testid="jira-action-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="text-[11px] text-warning" data-testid="jira-action-error">
          {error}
        </p>
      )}
    </section>
  )
}
