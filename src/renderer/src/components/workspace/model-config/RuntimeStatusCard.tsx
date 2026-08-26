/**
 * RuntimeStatusCard — "In use" panel.
 *
 * Read-only, no inputs. Answers what the running app is doing *right now*,
 * as opposed to the editable draft below it. The gap between the two — saved
 * `bge-m3`, running `(none)` — is exactly what is invisible in a settings-only
 * view, and what makes a saved-but-unapplied config look broken.
 */

import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import type { ModelsRuntimeStatus } from '../../../../../shared/types'

interface RuntimeStatusCardProps {
  workspaceId: string
  /** Bumped by the parent after a successful save — forces a re-read */
  refreshKey: number
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className="w-28 shrink-0 text-xs text-text-muted">{label}</span>
      <span className="text-xs text-text-secondary">{children}</span>
    </div>
  )
}

function Dot({ ok }: { ok: boolean }): React.JSX.Element {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${ok ? 'bg-success' : 'bg-text-muted'}`}
    />
  )
}

export default function RuntimeStatusCard({
  workspaceId,
  refreshKey
}: RuntimeStatusCardProps): React.JSX.Element {
  const [status, setStatus] = useState<ModelsRuntimeStatus | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setStatus(await window.api.modelsRuntimeStatus({ workspaceId }))
    } catch (err) {
      console.warn('[RuntimeStatusCard] Non-fatal: runtime status read failed:', err)
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading an external system (main process) on mount and after each save
    void load()
  }, [load, refreshKey])

  const emb = status?.embedding
  const chat = status?.chat
  const reach = status?.reachability

  return (
    <div
      data-testid="models-runtime-status"
      className="rounded-lg border border-border-default bg-surface-base p-4 mb-4"
    >
      <div className="flex items-center gap-2 mb-3">
        <Activity size={14} className="text-text-secondary" />
        <h3 className="text-sm font-semibold text-text-primary">In use right now</h3>
        <span className="text-xs text-text-muted">Live runtime state — not editable</span>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 px-2 py-1 text-xs text-text-secondary border border-border-subtle hover:bg-surface-hover rounded-md transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          Refresh
        </button>
      </div>

      {emb?.drift && (
        <div className="mb-3 flex items-start gap-2 rounded-md bg-warning-muted/10 border border-warning/20 p-2.5">
          <AlertTriangle size={14} className="text-warning mt-0.5 shrink-0" />
          <div className="text-xs text-text-secondary">
            <span className="font-medium text-warning">Saved settings are not loaded</span>
            <p className="mt-0.5">
              Saved <code className="text-text-primary">{emb.savedBackend}</code>
              {emb.savedBackend === 'ollama' && (
                <>
                  {' / '}
                  <code className="text-text-primary">{emb.savedModelName || '(none)'}</code>
                </>
              )}
              , running <code className="text-text-primary">{emb.activeBackend}</code>
              {' / '}
              <code className="text-text-primary">{emb.activeModelName || '(none)'}</code>. Save the
              Local Models card to apply.
            </p>
          </div>
        </div>
      )}

      <Row label="Embeddings">
        {emb ? (
          <>
            <Dot ok={emb.ready} />
            {emb.activeBackend} · {emb.activeModelName || '(no model)'} ·{' '}
            {emb.ready ? 'ready' : 'not ready'}
          </>
        ) : (
          '—'
        )}
      </Row>

      <Row label="Chat · plan">
        {chat?.plan ? `${chat.plan.provider} · ${chat.plan.modelId}` : 'Not routed'}
      </Row>

      <Row label="Chat · build">
        {chat?.build ? `${chat.build.provider} · ${chat.build.modelId}` : 'Not routed'}
      </Row>

      <Row label="Reachability">
        {reach ? (
          <>
            <Dot ok={reach.ollamaRunning} />
            Ollama
            <span className="mx-2 text-text-muted">·</span>
            <Dot ok={reach.omlxRunning} />
            oMLX
          </>
        ) : (
          '—'
        )}
      </Row>
    </div>
  )
}
