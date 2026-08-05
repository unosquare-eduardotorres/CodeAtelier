import { useCallback, useEffect, useState } from 'react'
import { Check, X, RefreshCw, Sparkles } from 'lucide-react'

import { SettingsCard } from '@renderer/components/common'
import type { MemoryFact } from '../../../../../shared/types'

interface Proposal {
  parent: MemoryFact
  children: MemoryFact[]
}

interface ReflectionReviewProps {
  workspaceId: string
  workspacePath: string
  /** Reflection is opt-in; the panel explains itself rather than vanishing. */
  enabled: boolean
}

/**
 * Review queue for synthesised parent facts.
 *
 * Reflection writes proposals `archived` so they cannot reach a prompt before
 * someone agrees they are true. This is the only place that gate can be
 * cleared — without it the whole feature stays dark, which is exactly what
 * happened between it shipping and now.
 */
export default function ReflectionReview({
  workspaceId,
  workspacePath,
  enabled
}: ReflectionReviewProps): React.JSX.Element {
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    setLoading(true)
    setError(null)
    try {
      setProposals(await window.api.memoryReflectionList({ workspaceId }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  const handleRun = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    setMessage(null)
    try {
      const result = await window.api.memoryReflectionRun({ workspaceId, workspacePath })
      setMessage(
        `${result.clustersConsidered} cluster(s) considered, ${result.parentsProposed} proposal(s) written` +
          (result.errors > 0 ? `, ${result.errors} error(s)` : '')
      )
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const handleApprove = async (id: string): Promise<void> => {
    try {
      await window.api.memoryReflectionApprove({ id })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleReject = async (id: string): Promise<void> => {
    try {
      await window.api.memoryReflectionReject({ id })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <SettingsCard>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-text-primary">Reflection Review</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Proposed parent facts synthesised from clusters of similar memories. Nothing here is
            visible to the agent until you approve it.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => void load()}
            disabled={loading}
            title="Refresh"
            className="p-1.5 text-text-muted hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={() => void handleRun()}
            disabled={!enabled || running}
            title={enabled ? 'Run reflection now' : 'Enable reflection first'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary-muted text-primary-text border border-border-default rounded-md hover:bg-primary/20 disabled:opacity-50"
          >
            <Sparkles className={`w-4 h-4 ${running ? 'animate-pulse' : ''}`} />
            {running ? 'Running…' : 'Run now'}
          </button>
        </div>
      </div>

      {!enabled && (
        <p className="text-xs text-text-muted mt-3">
          Reflection is turned off for this workspace. Existing proposals can still be approved or
          rejected below.
        </p>
      )}

      {error && <p className="text-xs text-danger mt-2">{error}</p>}
      {message && <p className="text-xs text-success mt-2">{message}</p>}

      <div className="space-y-3 mt-3">
        {proposals.length === 0 && !loading && (
          <p className="text-xs text-text-muted">No proposals awaiting review.</p>
        )}

        {proposals.map(({ parent, children }) => (
          <div
            key={parent.id}
            className="border border-border-default rounded-md p-3 bg-surface-float"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-text-primary font-medium">{parent.title}</div>
                <div className="text-xs text-text-secondary mt-1 whitespace-pre-wrap">
                  {parent.content}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => void handleApprove(parent.id)}
                  title="Approve — activates this fact and demotes its sources one tier"
                  className="p-1.5 text-success hover:bg-success/10 rounded"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  onClick={() => void handleReject(parent.id)}
                  title="Reject — leaves it archived and removes its links"
                  className="p-1.5 text-danger hover:bg-danger/10 rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <details className="mt-2">
              <summary className="text-[11px] text-text-muted cursor-pointer">
                Synthesised from {children.length} fact{children.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-1.5 space-y-1">
                {children.map((child) => (
                  <li key={child.id} className="text-[11px] text-text-muted">
                    <span className="font-mono">T{child.tier}</span> · {child.title}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        ))}
      </div>
    </SettingsCard>
  )
}
