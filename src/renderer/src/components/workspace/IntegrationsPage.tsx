import { useState, useEffect, useCallback } from 'react'
import { useWorkspaceStore } from '@renderer/store'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../../../shared/constants'
import type { IntegrationCredentialStatus } from '../../../../shared/integration-credentials.types'
import { McpExplainerBanner, IntegrationCard } from './integrations'

/**
 * Integrations page — workspace settings tab for managing external MCP servers.
 * Each integration can be enabled/disabled per workspace. When enabled, a toggle
 * pill appears in the chat UI for per-message activation.
 */
export default function IntegrationsPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [cliStatuses, setCliStatuses] = useState<
    Record<string, { checked: boolean; found: boolean; path?: string }>
  >({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [credentialStatuses, setCredentialStatuses] = useState<
    Record<string, IntegrationCredentialStatus>
  >({})

  const workspaceId = activeWorkspace?.id ?? null

  // Load workspace settings
  const reloadSettings = useCallback(() => {
    if (!workspaceId) return
    window.api
      .getWorkspaceSettings({ workspaceId })
      .then(setSettings)
      .catch((err) => console.warn('[IntegrationsPage] Non-fatal: settings load failed:', err))
  }, [workspaceId])

  useEffect(() => {
    reloadSettings()
  }, [reloadSettings])

  // Check CLI availability — bundled servers ship with the app, nothing to look up
  useEffect(() => {
    for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
      if (integration.bundledServerEntry) continue
      window.api
        .checkExternalMcp({ command: integration.command })
        .then((result) => {
          setCliStatuses((prev) => ({
            ...prev,
            [integration.id]: { checked: true, found: result.available, path: result.path }
          }))
        })
        .catch((err) => {
          console.warn('[IntegrationsPage] Non-fatal: CLI check failed:', err)
          setCliStatuses((prev) => ({
            ...prev,
            [integration.id]: { checked: true, found: false }
          }))
        })
    }
  }, [])

  // Load stored credential state — drives the "configured" badge and toggle gate
  useEffect(() => {
    if (!activeWorkspace) return
    for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
      if (!integration.credentialFields?.length) continue
      window.api
        .getIntegrationCredentialStatus({
          workspaceId: activeWorkspace.id,
          integrationId: integration.id
        })
        .then((status) => setCredentialStatuses((prev) => ({ ...prev, [integration.id]: status })))
        .catch((err) =>
          console.warn('[IntegrationsPage] Non-fatal: credential status failed:', err)
        )
    }
  }, [activeWorkspace])

  const handleCredentialStatusChange = useCallback(
    (integrationId: string, status: IntegrationCredentialStatus) => {
      setCredentialStatuses((prev) => ({ ...prev, [integrationId]: status }))
    },
    []
  )

  // Toggle handler — persists to workspace settings
  const handleToggle = useCallback(
    async (integrationId: string, enabled: boolean) => {
      if (!activeWorkspace) return
      setSavingId(integrationId)
      const key = `${integrationId}Available`
      const newSettings = { ...settings, [key]: enabled }
      try {
        await window.api.updateWorkspaceSettings({
          workspaceId: activeWorkspace.id,
          settings: { [key]: enabled }
        })
        setSettings(newSettings)
      } catch (err) {
        console.error('Failed to update integration setting:', err)
      } finally {
        setSavingId(null)
      }
    },
    [activeWorkspace, settings]
  )

  // Group integrations by category
  const categories = [
    { key: 'testing' as const, label: 'Testing' },
    { key: 'deployment' as const, label: 'Deployment' },
    { key: 'monitoring' as const, label: 'Monitoring' },
    { key: 'other' as const, label: 'Other' }
  ]

  return (
    <div data-testid="integrations-page" className="p-6 space-y-6 max-w-2xl">
      {/* MCP Explainer Banner */}
      <McpExplainerBanner />

      {/* Integration cards by category */}
      {categories.map((cat) => {
        const integrations = EXTERNAL_MCP_INTEGRATIONS.filter((i) => i.category === cat.key)
        if (integrations.length === 0) return null
        return (
          <div key={cat.key}>
            <h4 className="text-xs text-text-secondary uppercase tracking-wider font-medium mb-3">
              {cat.label}
            </h4>
            <div className="space-y-3">
              {integrations.map((integration) => (
                <IntegrationCard
                  key={integration.id}
                  integration={integration}
                  available={!!settings[`${integration.id}Available`]}
                  cliStatus={cliStatuses[integration.id] ?? { checked: false, found: false }}
                  onToggle={handleToggle}
                  savingId={savingId}
                  workspaceId={workspaceId}
                  credentialStatus={credentialStatuses[integration.id]}
                  onCredentialStatusChange={handleCredentialStatusChange}
                  onCredentialsCleared={reloadSettings}
                />
              ))}
            </div>
          </div>
        )
      })}

      {/* Future integrations teaser */}
      <div className="border border-dashed border-border-subtle rounded-lg p-4 text-center">
        <p className="text-xs text-text-muted">
          More integrations coming soon — Playwright MCP, Docker MCP, Supabase MCP, Sentry MCP…
        </p>
        <p className="text-[10px] text-text-muted mt-1">
          Each auto-renders here and as a pill in the chat bar.
        </p>
      </div>
    </div>
  )
}
