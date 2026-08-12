import { useState, useEffect, useCallback } from 'react'
import { useWorkspaceStore } from '@renderer/store'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../../../shared/constants'
import type { IntegrationCredentialStatus } from '../../../../shared/integration-credentials.types'
import { McpExplainerBanner, IntegrationCard } from './integrations'

const CATEGORIES = [
  { key: 'testing' as const, label: 'Testing' },
  { key: 'deployment' as const, label: 'Deployment' },
  { key: 'monitoring' as const, label: 'Monitoring' },
  { key: 'other' as const, label: 'Other' }
]

/** Below this many integrations, category headers are pure overhead. */
const CATEGORY_HEADER_THRESHOLD = 5

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

  const renderCard = (
    integration: (typeof EXTERNAL_MCP_INTEGRATIONS)[number]
  ): React.JSX.Element => (
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
  )

  // Category headers cost a row each and say nothing while every category holds
  // a single item — two headers over two integrations, one of them "OTHER".
  // They earn their place once the list is long enough to need scanning.
  const showCategories = EXTERNAL_MCP_INTEGRATIONS.length >= CATEGORY_HEADER_THRESHOLD

  return (
    <div data-testid="integrations-page" className="p-6 space-y-4 max-w-4xl">
      <McpExplainerBanner />

      {showCategories ? (
        CATEGORIES.map((cat) => {
          const integrations = EXTERNAL_MCP_INTEGRATIONS.filter((i) => i.category === cat.key)
          if (integrations.length === 0) return null
          return (
            <div key={cat.key}>
              <h4 className="text-[11px] text-text-muted uppercase tracking-wider font-medium mb-2">
                {cat.label}
              </h4>
              <div className="space-y-2">{integrations.map(renderCard)}</div>
            </div>
          )
        })
      ) : (
        <div className="space-y-2">{EXTERNAL_MCP_INTEGRATIONS.map(renderCard)}</div>
      )}

      <p className="text-[11px] text-text-muted border border-dashed border-border-subtle rounded-lg px-3 py-2">
        More coming soon — Playwright, Docker, Supabase, Sentry. Each auto-renders here and as a
        pill in the chat bar.
      </p>
    </div>
  )
}
