/**
 * GlmProviderCard — Z.ai GLM connection settings.
 *
 * Self-contained draft + explicit Save (its own, not the tab's Save bar) because the
 * GLM connection is independent of the local-server draft the rest of the tab shares.
 *
 * Two things this card exists to make impossible:
 *  - a silently rewritten base URL. It is stored and used verbatim; the hint says so.
 *  - a required API key in proxy mode. A local proxy commonly holds the credential
 *    itself, so demanding a key here would block a legitimate setup.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Cloud, Loader2 } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import {
  GLM_DEFAULT_BASE_URL,
  GLM_ENDPOINTS,
  GLM_MCP_CREDITS_PER_CALL,
  GLM_MODELS,
  GLM_REMOTE_MCP_SERVERS
} from '../../../../../shared/constants'
import type { GlmConnectionResult, GlmQuotaStatus } from '../../../../../shared/types'
import {
  draftFromSettings,
  emptyGlmDraft,
  isPayAsYouGoUrl,
  settingsFromDraft,
  type GlmDraft
} from './glm-draft'

// ─── Draft ───────────────────────────────────────────────

// ─── Card ────────────────────────────────────────────────

export interface GlmProviderCardProps {
  workspaceId: string | undefined
  workspacePath: string | undefined
  /**
   * Publishes the freshly discovered catalogue so the routing dropdowns on the
   * same tab stop offering the hardcoded fallback IDs. Without this the list is
   * written to settings and not re-read until the page is remounted.
   */
  onModelsDiscovered?: (models: string[]) => void
}

export default function GlmProviderCard({
  workspaceId,
  workspacePath,
  onModelsDiscovered
}: GlmProviderCardProps): React.JSX.Element {
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [draft, setDraft] = useState<GlmDraft>(emptyGlmDraft)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<GlmConnectionResult | null>(null)
  const [quota, setQuota] = useState<GlmQuotaStatus | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    const loaded = await window.api.getWorkspaceSettings({ workspaceId })
    setSettings(loaded)
    setDraft(draftFromSettings(loaded))
    setQuota(await window.api.getGlmQuota({ workspaceId }).catch(() => null))
  }, [workspaceId])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads persisted settings on mount; state lands in an async callback
    void reload()
  }, [reload])

  const patch = useCallback(
    (changes: Partial<GlmDraft>) => setDraft((prev) => ({ ...prev, ...changes })),
    []
  )

  const handleTest = useCallback(async (): Promise<void> => {
    setTesting(true)
    try {
      const result = await window.api.glmTestConnection({
        workspacePath,
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey || undefined
      })
      setTestResult(result)
      // Persist the discovered catalogue: Z.ai's docs disagree on model IDs, so what
      // the endpoint actually reports beats any list we could ship.
      if (result.ok && result.models.length > 0 && workspaceId) {
        // Limits reported for the model actually in use win over the shipped
        // defaults: a proxy commonly caps context below the upstream model, and
        // compaction tuned against the wrong number truncates real context.
        // Only written when reported — never overwrite a known value with a guess.
        const limits = result.modelLimits?.[draft.model]
        const patchSettings: Record<string, unknown> = {
          glmDiscoveredModels: result.models,
          ...(limits?.contextLimit !== undefined ? { glmContextLimit: limits.contextLimit } : {}),
          ...(limits?.outputLimit !== undefined ? { glmOutputLimit: limits.outputLimit } : {})
        }
        await window.api.updateWorkspaceSettings({ workspaceId, settings: patchSettings })
        setSettings((prev) => ({ ...prev, ...patchSettings }))
        onModelsDiscovered?.(result.models)
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        models: [],
        code: 'network'
      })
    } finally {
      setTesting(false)
    }
  }, [draft.baseUrl, draft.apiKey, draft.model, workspaceId, workspacePath, onModelsDiscovered])

  const handleSave = useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    setSaving(true)
    try {
      await window.api.updateWorkspaceSettings({
        workspaceId,
        settings: settingsFromDraft(draft)
      })
      // Clear the key field after save so the plaintext does not linger in the DOM.
      setDraft((prev) => ({ ...prev, apiKey: '' }))
      await reload()
    } finally {
      setSaving(false)
    }
  }, [draft, workspaceId, reload])

  const discovered = (settings.glmDiscoveredModels as string[] | undefined) ?? []
  const modelChoices =
    discovered.length > 0
      ? discovered.map((id) => ({ id, label: id }))
      : GLM_MODELS.map((m) => ({ id: m.id, label: m.label }))

  const statusText = testResult ? (testResult.ok ? 'Connected' : 'Not connected') : 'Not tested'
  const statusColor = testResult ? (testResult.ok ? 'bg-success' : 'bg-red-400') : 'bg-text-muted'

  return (
    <div
      data-testid="glm-config-section"
      className="rounded-lg border border-border-subtle bg-surface-float p-4"
    >
      <div className="flex items-center gap-3 mb-4">
        <span className={`inline-block w-2 h-2 rounded-full ${statusColor}`} />
        <div className="flex items-center gap-2">
          <Cloud size={16} className="text-text-secondary" />
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Z.AI GLM</h3>
            <p className="text-xs text-text-muted">
              Coding Plan{draft.endpointMode === 'proxy' ? ' · locally proxied' : ''}
            </p>
          </div>
        </div>
        <span className="ml-auto text-xs text-text-secondary">{statusText}</span>
      </div>

      <SettingsCard>
        <div className="space-y-4">
          {/* ── Endpoint mode ── */}
          <div>
            <label className="text-xs font-medium text-text-secondary">Endpoint</label>
            <div className="flex gap-1 mt-1 p-1 rounded-lg bg-surface-base border border-border-subtle">
              {(
                [
                  { id: 'zai-coding', label: 'Z.ai direct' },
                  { id: 'proxy', label: 'Local proxy' }
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() =>
                    patch({
                      endpointMode: tab.id,
                      // Switching to direct restores the coding endpoint; switching to
                      // proxy leaves the field for the user to fill in themselves.
                      baseUrl: tab.id === 'zai-coding' ? GLM_DEFAULT_BASE_URL : draft.baseUrl
                    })
                  }
                  className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    draft.endpointMode === tab.id
                      ? 'bg-primary/15 text-primary border border-primary/30'
                      : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* ── Base URL ── */}
          <div>
            <label className="text-xs font-medium text-text-secondary">Base URL</label>
            <input
              value={draft.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
              placeholder="http://127.0.0.1:8080"
              className="w-full mt-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-xs text-text-muted mt-1">
              Used exactly as entered — no <code>/v1</code> is appended.
            </p>
            {isPayAsYouGoUrl(draft.baseUrl) && (
              <div className="mt-2 flex items-start gap-2 rounded-md bg-warning-muted/10 border border-warning/20 p-2.5">
                <AlertTriangle size={14} className="text-warning mt-0.5 shrink-0" />
                <p className="text-xs text-text-secondary">
                  <span className="font-medium text-warning">Pay-as-you-go endpoint</span> — a
                  Coding Plan key is rejected here. Use{' '}
                  <code className="px-1 py-0.5 rounded bg-surface-overlay text-text-primary">
                    {GLM_ENDPOINTS.codingOpenAI}
                  </code>
                  .
                </p>
              </div>
            )}
          </div>

          {/* ── API key ── */}
          <div>
            <label className="text-xs font-medium text-text-secondary">
              API Key{' '}
              {draft.endpointMode === 'proxy' && (
                <span className="font-normal text-text-muted">(optional)</span>
              )}
            </label>
            <input
              value={draft.apiKey}
              onChange={(e) => patch({ apiKey: e.target.value })}
              type="password"
              placeholder={
                draft.endpointMode === 'proxy'
                  ? 'Leave blank if your proxy injects the Authorization header'
                  : 'Coding Plan API key'
              }
              className="w-full mt-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-xs text-text-muted mt-1">
              Encrypted with your OS keychain. Leave blank to keep the stored key.
            </p>
          </div>

          {/* ── Models ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-text-secondary">Model</label>
              <select
                value={draft.model}
                onChange={(e) => patch({ model: e.target.value })}
                aria-label="GLM model"
                className="w-full mt-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {modelChoices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-text-secondary">Housekeeping model</label>
              <select
                value={draft.smallModel}
                onChange={(e) => patch({ smallModel: e.target.value })}
                aria-label="GLM housekeeping model"
                className="w-full mt-1 bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {modelChoices.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                <option value="">Disabled</option>
              </select>
              <p className="text-xs text-text-muted mt-1">
                Titles and summaries. Flash costs ~3× fewer credits than the frontier model.
              </p>
            </div>
          </div>

          {/* ── Thinking ──
              Deliberately NOT a toggle. Z.ai's API reference states that for GLM-5.3
              and GLM-5.3-Flash — the models this card defaults to — `thinking.type`
              can only be `enabled`. A checkbox here would be inert for exactly the
              models most users run, so it states the behaviour instead. */}
          <p className="text-xs text-text-muted">
            GLM-5.3 and GLM-5.3-Flash always reason before answering — Z.ai does not allow thinking
            to be turned off for them.
          </p>

          {/* ── Test connection ── */}
          <div>
            <button
              onClick={() => void handleTest()}
              disabled={testing || !draft.baseUrl.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary border border-border-default hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-50"
            >
              {testing ? <Loader2 size={12} className="animate-spin" /> : null}
              Test Connection
            </button>
            {testResult && (
              <p
                className={`text-xs mt-2 ${testResult.ok ? 'text-success' : 'text-red-400'}`}
                role="status"
              >
                {testResult.message}
              </p>
            )}
          </div>
        </div>
      </SettingsCard>

      {/* ── GLM-hosted MCP ── */}
      <div className="mt-4">
        <h4 className="text-xs font-medium text-text-secondary mb-2">
          Coding-Plan MCP (credit-billed)
        </h4>
        <SettingsCard>
          <div className="space-y-2">
            {GLM_REMOTE_MCP_SERVERS.map((server) => (
              <label
                key={server.id}
                className="flex items-center gap-2 text-xs text-text-secondary"
              >
                <input
                  type="checkbox"
                  checked={!!draft.mcpActive[server.id]}
                  onChange={(e) =>
                    patch({ mcpActive: { ...draft.mcpActive, [server.id]: e.target.checked } })
                  }
                />
                <span className="font-medium text-text-primary">{server.displayName}</span>
                <span className="text-text-muted">
                  {GLM_MCP_CREDITS_PER_CALL} credits/call — {server.description}
                </span>
              </label>
            ))}
            <p className="text-xs text-text-muted pt-1">
              Vision tools are a separate stdio server — enable{' '}
              <span className="text-text-secondary font-medium">Z.AI Vision</span> on the
              Integrations page (requires Node.js ≥ 22).
            </p>
            {!draft.apiKey && (
              <p className="text-xs text-text-muted">
                These endpoints authenticate with a Bearer key — they stay unmounted until one is
                saved.
              </p>
            )}
          </div>
        </SettingsCard>
      </div>

      {/* ── Credits meter ── */}
      {quota && (
        <div className="mt-4">
          <SettingsCard>
            <h4 className="text-sm font-medium text-text-primary mb-2">Credits</h4>
            <div className="h-2 rounded-full bg-surface-base overflow-hidden">
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.min(100, quota.percentOf5h)}%` }}
              />
            </div>
            <p className="text-xs text-text-secondary mt-1.5">
              {Math.round(quota.creditsIn5h).toLocaleString()} / {quota.limit5h.toLocaleString()} in
              the last 5 hours · {Math.round(quota.creditsInWeek).toLocaleString()} /{' '}
              {quota.limitWeek.toLocaleString()} this week
              {quota.offPeak ? ' · off-peak (half rate)' : ''}
            </p>
          </SettingsCard>
        </div>
      )}

      {/* Saving this card stores a connection; it does not select GLM. The active
          provider is derived from the Plan role in Model Routing, so without this
          the user saves, sees a success, and every chat still runs on Claude with
          nothing on screen explaining why. */}
      {settings.llmProvider !== 'glm' && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-border-subtle bg-surface-base p-3">
          <AlertTriangle size={14} className="text-text-muted mt-0.5 shrink-0" />
          <p className="text-xs text-text-secondary">
            This workspace is not using GLM yet. Saving here stores the connection only — to route
            work to GLM, set the <span className="text-text-primary font-medium">Plan</span> role to
            a GLM model under <span className="text-text-primary font-medium">Model Routing</span>{' '}
            below.
          </p>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button
          onClick={() => void handleSave()}
          disabled={saving || !workspaceId}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : null}
          Save GLM settings
        </button>
      </div>
    </div>
  )
}
