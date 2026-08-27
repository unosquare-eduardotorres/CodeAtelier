/**
 * InUseTab — "what is this workspace actually running right now".
 *
 * Read-only by construction: no inputs, no drafts, nothing to save. It exists
 * because a settings-only view cannot distinguish "saved" from "in force", and
 * the gap between the two is what makes a correctly-saved config look broken.
 *
 * Absorbs the former RuntimeStatusCard and adds the part that was missing:
 * every routable role, with *why* it resolved the way it did. A role showing
 * "defaulted" is one the user never chose — which is a different problem from
 * one they chose badly, and the old panel showed neither.
 */

import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import { MODEL_ROLE_GROUP_LABELS } from '../../../../../shared/constants'
import type {
  ModelRoleGroup,
  ModelsRuntimeStatus,
  RuntimeRoleRow
} from '../../../../../shared/types'

interface InUseTabProps {
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

/**
 * Says where the model came from in plain words.
 *
 * "Defaulted" is deliberately not styled as an error — it is the correct state
 * for most roles on most workspaces. It just has to be legible, because
 * "Not routed" told the user nothing about what would actually run.
 */
function SourceChip({ source }: { source: RuntimeRoleRow['source'] }): React.JSX.Element {
  const chosen = source === 'roles' || source === 'override'
  return (
    <span
      title={
        chosen
          ? 'You chose this model for this role'
          : 'You never set this role — it fell through to the built-in default'
      }
      className={`text-xs px-1.5 py-0.5 rounded-full border font-medium shrink-0 ${
        chosen
          ? 'bg-primary-muted text-primary-text border-primary/20'
          : 'bg-surface-overlay text-text-muted border-border-subtle'
      }`}
    >
      {chosen ? 'you chose this' : 'defaulted'}
    </span>
  )
}

function RoleLine({ role }: { role: RuntimeRoleRow }): React.JSX.Element {
  const providerLabel =
    role.provider === 'claude'
      ? 'Claude'
      : role.provider === 'local-llm'
        ? role.localBackend === 'ollama'
          ? 'Ollama'
          : 'oMLX'
        : role.provider

  return (
    <div data-testid="in-use-role" className="flex items-center gap-2 py-1.5">
      <span className="w-40 shrink-0 text-xs text-text-secondary">{role.label}</span>
      <span className="text-xs text-text-primary font-medium truncate">{role.modelId}</span>
      <span className="text-xs text-text-muted shrink-0">· {providerLabel}</span>
      {!role.available && (
        <span
          title="This model is not on the local server that is currently reachable"
          className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium shrink-0"
        >
          <AlertTriangle size={9} />
          not installed
        </span>
      )}
      <span className="ml-auto shrink-0">
        <SourceChip source={role.source} />
      </span>
    </div>
  )
}

const GROUP_ORDER: ModelRoleGroup[] = ['chat', 'blueprint', 'quality', 'council', 'background']

export default function InUseTab({ workspaceId, refreshKey }: InUseTabProps): React.JSX.Element {
  const [status, setStatus] = useState<ModelsRuntimeStatus | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setStatus(await window.api.modelsRuntimeStatus({ workspaceId }))
    } catch (err) {
      console.warn('[InUseTab] Non-fatal: runtime status read failed:', err)
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading an external system (main process) on mount and after each save
    void load()
  }, [load, refreshKey])

  const emb = status?.embedding
  const reach = status?.reachability
  const roles = status?.roles ?? []
  const unavailableCount = roles.filter((r) => !r.available).length

  return (
    <div data-testid="models-in-use" className="space-y-4">
      {/* ── Header ── */}
      <div className="flex items-center gap-2">
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

      {/* ── Saved-vs-running drift ── */}
      {emb?.drift && (
        <div
          data-testid="embedding-drift-warning"
          className="flex items-start gap-2 rounded-md bg-warning-muted/10 border border-warning/20 p-2.5"
        >
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
              <code className="text-text-primary">{emb.activeModelName || '(none)'}</code>. Save on
              the Configure tab to apply.
            </p>
          </div>
        </div>
      )}

      {/* ── Environment ── */}
      <SettingsCard>
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
      </SettingsCard>

      {/* ── Every routed role ── */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h4 className="text-xs font-medium text-text-secondary">Model routing</h4>
          {unavailableCount > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-400">
              <AlertTriangle size={10} />
              {unavailableCount} role{unavailableCount !== 1 ? 's' : ''} point at a model that is
              not installed
            </span>
          )}
        </div>

        {roles.length === 0 ? (
          <SettingsCard>
            <p className="text-xs text-text-muted">
              {loading ? 'Reading runtime state…' : 'Runtime state unavailable.'}
            </p>
          </SettingsCard>
        ) : (
          <div className="space-y-3">
            {GROUP_ORDER.map((group) => {
              const inGroup = roles.filter((r) => r.group === group)
              if (inGroup.length === 0) return null
              return (
                <div key={group}>
                  <h5 className="text-xs text-text-muted mb-1">{MODEL_ROLE_GROUP_LABELS[group]}</h5>
                  <SettingsCard>
                    <div className="divide-y divide-border-subtle">
                      {inGroup.map((role) => (
                        <RoleLine key={role.action} role={role} />
                      ))}
                    </div>
                  </SettingsCard>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
