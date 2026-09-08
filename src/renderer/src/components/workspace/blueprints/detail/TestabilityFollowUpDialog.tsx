/**
 * TestabilityFollowUpDialog — turn ledger rows into scheduled work.
 *
 * The Testability Ledger answers "what did this blueprint never prove?", but
 * until now it only answered it into a Markdown file. That leaves the human
 * holding a list with no route back into the pipeline. This dialog closes the
 * loop: each row becomes an IDEA, which already feeds the grill → blueprint
 * pipeline, so unproven scope becomes schedulable rather than a note.
 *
 * Ideas, not bugs: `bug:report` is for defects, and "nobody demonstrated this
 * works" is not the same claim as "this is broken".
 *
 * The rows come from main (`blueprintTestabilityEntries`) rather than from the
 * blueprint record the renderer already holds. Preflight findings live on the
 * REVIEW phase artifact, which the renderer cannot see — deriving the list here
 * would show a SHORTER list than the export produces for the same blueprint.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, Lightbulb, Loader2, AlertTriangle, CheckCircle } from 'lucide-react'
import {
  testabilityEntryKey,
  type TestabilityEntry,
  type TestabilityReason
} from '../../../../../../shared/testability-report'

interface TestabilityFollowUpDialogProps {
  blueprintId: string
  blueprintTitle: string
  onClose: () => void
}

const REASON_LABELS: Record<TestabilityReason, string> = {
  'requested-proof-missing': 'Requested proof missing',
  'never-completed': 'Never completed',
  'blocked-by-environment': 'Blocked by environment',
  'closed-unproven': 'Closed unproven',
  'check-could-not-run': 'Check could not run'
}

export function TestabilityFollowUpDialog({
  blueprintId,
  blueprintTitle,
  onClose
}: TestabilityFollowUpDialogProps): React.JSX.Element {
  const [entries, setEntries] = useState<TestabilityEntry[] | null>(null)
  const [linked, setLinked] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createdCount, setCreatedCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api
      .blueprintTestabilityEntries({ blueprintId })
      .then((res) => {
        if (cancelled) return
        setEntries(res.entries)
        setLinked(res.convertedIdeaRefs)
        // Default to all — the point of the dialog is to make the whole gap
        // schedulable in one action; unticking is the cheap direction.
        setSelected(
          new Set(res.entries.map(testabilityEntryKey).filter((key) => !res.convertedIdeaRefs[key]))
        )
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setEntries([])
      })
    return () => {
      cancelled = true
    }
  }, [blueprintId])

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const selectable = useMemo(
    () => (entries ?? []).filter((e) => !linked[testabilityEntryKey(e)]),
    [entries, linked]
  )

  const onCreate = useCallback(() => {
    setCreating(true)
    setError(null)
    void window.api
      .blueprintLinkTestabilityIdeas({ blueprintId, entryKeys: [...selected] })
      .then((res) => {
        setCreatedCount(res.created)
        setCreating(false)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setCreating(false)
      })
  }, [blueprintId, selected])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        data-testid="testability-followup-dialog"
        className="relative bg-surface-panel border border-border-subtle rounded-xl shadow-2xl w-[620px] max-w-[92vw] overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-semibold text-text-primary">Create follow-up ideas</h2>
            <span className="text-[11px] text-text-muted">{blueprintTitle}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {createdCount !== null ? (
            <div
              data-testid="testability-followup-result"
              className="flex items-start gap-2 rounded-lg border border-success/25 bg-success/5 px-3 py-2.5"
            >
              <CheckCircle size={14} className="mt-0.5 flex-shrink-0 text-success" />
              <span className="text-xs text-text-secondary">
                {createdCount === 0
                  ? 'Nothing new to create — every selected item already has an idea.'
                  : `Created ${createdCount} idea${createdCount > 1 ? 's' : ''}. They are in Ideas, ready to grill into scope.`}
              </span>
            </div>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2.5">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-danger" />
              <span className="text-xs text-text-secondary">{error}</span>
            </div>
          ) : null}

          {entries === null ? (
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <Loader2 size={12} className="animate-spin" />
              <span>Collecting what this blueprint never proved…</span>
            </div>
          ) : entries.length === 0 && !error ? (
            <p className="text-xs text-text-muted">
              Nothing unproven was recorded for this blueprint at its verification depth.
            </p>
          ) : (
            entries.map((entry) => {
              const key = testabilityEntryKey(entry)
              const alreadyLinked = !!linked[key]
              return (
                <label
                  key={key}
                  data-testid="testability-followup-row"
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
                    alreadyLinked
                      ? 'border-border-subtle bg-surface-base/50 cursor-default'
                      : 'border-border-subtle hover:bg-surface-raised cursor-pointer'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={alreadyLinked || selected.has(key)}
                    disabled={alreadyLinked || creating || createdCount !== null}
                    onChange={() => toggle(key)}
                  />
                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="font-mono text-[10px] text-text-muted">{entry.ref}</span>
                      <span className="text-[10px] text-warning/80">
                        {REASON_LABELS[entry.reason]}
                      </span>
                      {alreadyLinked ? (
                        <span className="text-[10px] text-success">idea already created</span>
                      ) : null}
                    </span>
                    <span className="text-xs text-text-primary break-words">{entry.title}</span>
                    <span className="text-[11px] text-text-muted break-words">{entry.detail}</span>
                  </span>
                </label>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-subtle px-5 py-3">
          <span className="text-[11px] text-text-muted">
            {selectable.length === 0
              ? 'No new items to convert'
              : `${selected.size} of ${selectable.length} selected`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-raised"
            >
              {createdCount === null ? 'Cancel' : 'Done'}
            </button>
            <button
              type="button"
              data-testid="testability-followup-create"
              onClick={onCreate}
              disabled={creating || selected.size === 0 || createdCount !== null}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/80 disabled:opacity-40"
            >
              {creating ? <Loader2 size={12} className="animate-spin" /> : <Lightbulb size={12} />}
              Create {selected.size > 0 ? selected.size : ''} idea{selected.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
