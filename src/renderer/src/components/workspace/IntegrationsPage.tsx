import { useState, useEffect, useCallback } from 'react'
import {
  Smartphone,
  ExternalLink,
  Check,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Puzzle,
  Shield,
  Zap,
  Info,
  ArrowRight,
  FileCode,
  Eye,
  Bug,
  Layers,
  Cloud
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../../../shared/constants'
import type { ExternalMcpDefinition } from '../../../../shared/constants'

// ── Icon lookup for dynamic use-case icons ────────────────────────────────────

const ICON_MAP: Record<string, LucideIcon> = {
  FileCode,
  Eye,
  Bug,
  Layers,
  Cloud,
  Smartphone,
  Shield,
  Zap,
  Puzzle,
  Info
}

function DynamicIcon({
  name,
  size = 14,
  className
}: {
  name: string
  size?: number
  className?: string
}): React.JSX.Element {
  const Icon = ICON_MAP[name] ?? Puzzle
  return <Icon size={size} className={className} />
}

// ── MCP Explainer Banner ──────────────────────────────────────────────────────

function McpExplainerBanner(): React.JSX.Element {
  return (
    <div className="bg-surface-overlay rounded-lg border border-border-subtle p-5 space-y-4">
      {/* Title */}
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-accent/15 flex items-center justify-center">
          <Puzzle size={16} className="text-accent" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">External MCP Integrations</h3>
          <p className="text-[11px] text-text-muted">
            Extend your AI agent with external tool servers
          </p>
        </div>
      </div>

      {/* What is MCP? */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Info size={12} className="text-accent" />
          <h4 className="text-xs font-semibold text-text-primary">What is MCP?</h4>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed">
          <strong className="text-text-primary">Model Context Protocol (MCP)</strong> lets your AI
          agent connect to external tools beyond reading and writing code. When an integration is
          enabled, your agent gains new capabilities — like driving a real mobile device, deploying
          to cloud, or querying databases.
        </p>
      </div>

      {/* How it works — compact stepper */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-text-primary">How it works</h4>
        <div className="flex items-center gap-1 flex-wrap">
          {[
            { num: '①', label: 'Enable here' },
            { num: '②', label: 'Pill appears in chat bar' },
            { num: '③', label: 'Toggle ON per conversation' },
            { num: '④', label: 'Agent uses tools' }
          ].map((step, i, arr) => (
            <div key={step.num} className="flex items-center gap-1">
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-surface-base border border-border-subtle text-text-secondary">
                <span className="text-accent font-semibold">{step.num}</span> {step.label}
              </span>
              {i < arr.length - 1 && (
                <ArrowRight size={10} className="text-text-muted mx-0.5 flex-shrink-0" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Token safety callout */}
      <p className="text-[11px] text-text-muted italic">
        Tools are only loaded when the pill is active — no token cost when it&apos;s OFF.
      </p>
    </div>
  )
}

// ── Token Impact Badge ────────────────────────────────────────────────────────

function TokenImpactBadge({
  impact,
  toolCount
}: {
  impact: 'low' | 'medium' | 'high'
  toolCount: number
}): React.JSX.Element {
  const config = {
    low: { label: 'Low', bgClass: 'bg-success-muted', textClass: 'text-success' },
    medium: { label: 'Medium', bgClass: 'bg-warning-muted', textClass: 'text-warning' },
    high: { label: 'High', bgClass: 'bg-danger-muted', textClass: 'text-danger' }
  }
  const c = config[impact]
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${c.bgClass} ${c.textClass}`}
    >
      <Zap size={8} />
      {c.label} impact · {toolCount} tools
    </span>
  )
}

// ── Use Case Cards Grid ───────────────────────────────────────────────────────

function UseCaseGrid({
  useCases
}: {
  useCases: NonNullable<ExternalMcpDefinition['useCases']>
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <h5 className="text-xs font-semibold text-text-primary">What can your agent do?</h5>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {useCases.map((uc) => (
          <div
            key={uc.title}
            className="bg-surface-base rounded-md border border-border-subtle p-3 space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded flex items-center justify-center bg-accent/10">
                <DynamicIcon name={uc.icon} size={12} className="text-accent" />
              </div>
              <span className="text-xs font-semibold text-text-primary">{uc.title}</span>
            </div>
            <p className="text-[11px] text-text-secondary leading-relaxed">{uc.description}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Workflow Stepper ──────────────────────────────────────────────────────────

function WorkflowStepper({
  steps
}: {
  steps: NonNullable<ExternalMcpDefinition['workflowSteps']>
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <h5 className="text-xs font-semibold text-text-primary">How it works</h5>
      <div className="flex items-start gap-1 flex-wrap">
        {steps.map((ws, i) => (
          <div key={ws.step} className="flex items-center gap-1">
            <div className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-md bg-surface-base border border-border-subtle min-w-[120px] text-center">
              <span className="text-accent text-xs font-bold">
                {['①', '②', '③', '④', '⑤', '⑥'][i] ?? `${i + 1}.`}
              </span>
              <span className="text-[11px] font-semibold text-text-primary">{ws.step}</span>
              <span className="text-[10px] text-text-muted leading-tight">{ws.description}</span>
            </div>
            {i < steps.length - 1 && (
              <ArrowRight size={12} className="text-text-muted flex-shrink-0 mx-0.5" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Enriched Tools List (collapsible) ─────────────────────────────────────────

function ToolsList({ integration }: { integration: ExternalMcpDefinition }): React.JSX.Element {
  const [showTools, setShowTools] = useState(false)

  return (
    <div className="space-y-1">
      <button
        onClick={() => setShowTools(!showTools)}
        className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        {showTools ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <span>
          {integration.toolCount} tools ({integration.planModeToolNames.length} available in plan
          mode)
        </span>
      </button>
      {showTools && (
        <div className="bg-surface-base rounded-md p-2.5 space-y-2.5">
          {integration.toolNames.map((name) => {
            const shortName = name.replace(`mcp__${integration.id}__`, '')
            const isPlanMode = integration.planModeToolNames.includes(name)
            const description = integration.toolDescriptions?.[name]

            return (
              <div key={name} className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <code className="text-text-primary font-mono text-[11px] font-semibold">
                    {shortName}
                  </code>
                  {isPlanMode && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-mode-plan-muted text-mode-plan-text">
                      plan
                    </span>
                  )}
                  {!isPlanMode && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-mode-build-muted text-mode-build-text">
                      build only
                    </span>
                  )}
                </div>
                {description && (
                  <p className="text-[11px] text-text-muted leading-relaxed pl-0.5">
                    {description}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Integration Card ──────────────────────────────────────────────────────────

function IntegrationCard({
  integration,
  available,
  cliStatus,
  onToggle,
  savingId
}: {
  integration: ExternalMcpDefinition
  available: boolean
  cliStatus: { checked: boolean; found: boolean; path?: string }
  onToggle: (id: string, enabled: boolean) => void
  savingId: string | null
}): React.JSX.Element {
  const [showEnvVars, setShowEnvVars] = useState(false)
  const isSaving = savingId === integration.id

  return (
    <div className="bg-surface-overlay rounded-lg border border-border-subtle p-4 space-y-4">
      {/* Header: icon + name + toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center ${
              available ? 'bg-accent/15 text-accent' : 'bg-surface-base text-text-muted'
            }`}
          >
            <Smartphone size={18} />
          </div>
          <div>
            <h4 className="text-sm font-semibold text-text-primary">{integration.displayName}</h4>
            <p className="text-xs text-text-secondary">{integration.description}</p>
          </div>
        </div>
        <button
          onClick={() => onToggle(integration.id, !available)}
          disabled={isSaving}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            available ? 'bg-accent' : 'bg-surface-base border border-border-default'
          } ${isSaving ? 'opacity-50' : 'cursor-pointer'}`}
          title={available ? 'Disable for this workspace' : 'Make available for this workspace'}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white transition-transform shadow-sm ${
              available ? 'translate-x-5.5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* Why use this? — longDescription */}
      {integration.longDescription && (
        <div className="space-y-1.5">
          <h5 className="text-xs font-semibold text-text-primary">
            Why use {integration.displayName}?
          </h5>
          <p className="text-xs text-text-secondary leading-relaxed">
            {integration.longDescription}
          </p>
        </div>
      )}

      {/* Use case cards */}
      {integration.useCases && integration.useCases.length > 0 && (
        <UseCaseGrid useCases={integration.useCases} />
      )}

      {/* Workflow stepper */}
      {integration.workflowSteps && integration.workflowSteps.length > 0 && (
        <WorkflowStepper steps={integration.workflowSteps} />
      )}

      {/* Status row: CLI check + token impact */}
      <div className="flex items-center gap-3 flex-wrap">
        {cliStatus.checked && (
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium ${
              cliStatus.found ? 'text-success' : 'text-warning'
            }`}
          >
            {cliStatus.found ? <Check size={10} /> : <AlertTriangle size={10} />}
            {cliStatus.found
              ? `CLI detected: ${cliStatus.path}`
              : `CLI not found — install ${integration.command}`}
          </span>
        )}
        {!cliStatus.checked && (
          <span className="text-xs text-text-muted">Checking CLI availability…</span>
        )}

        <TokenImpactBadge impact={integration.tokenImpact} toolCount={integration.toolCount} />
      </div>

      {/* Warning banner for high-impact */}
      {integration.tokenImpact === 'high' && available && (
        <div className="flex items-start gap-2 bg-warning-muted border border-warning/20 rounded-md p-2.5 text-xs text-text-secondary">
          <Shield size={12} className="text-warning mt-0.5 flex-shrink-0" />
          <span>
            <strong className="text-warning">High token impact:</strong> This integration injects{' '}
            {integration.toolCount} tool definitions into the context window. Toggle it OFF per-chat
            when not needed to save tokens.
          </span>
        </div>
      )}

      {/* Per-chat control info */}
      {available && (
        <div className="bg-info-muted border border-info/20 rounded-md p-2.5 text-xs text-text-secondary">
          <strong className="text-info">💡 Per-chat control:</strong> A{' '}
          <span className="font-semibold">{integration.displayName}</span> pill will appear next to
          the Plan/Build mode toggle in every chat. Toggle it ON/OFF per message — tools are only
          injected when active.
        </div>
      )}

      {/* Expo/RN performance tip — shown when Maestro is enabled */}
      {available && integration.id === 'maestro' && (
        <div className="flex items-start gap-2 bg-surface-base border border-border-subtle rounded-md p-2.5 text-xs text-text-secondary">
          <Zap size={12} className="text-accent mt-0.5 flex-shrink-0" />
          <div>
            <strong className="text-text-primary">⚡ Speed tip for Expo / React Native:</strong> Use
            a <strong>release or preview build</strong> (not Expo Go) for dramatically faster test
            execution. Dev mode&apos;s hot-reload polling, error overlays, and LogBox create
            constant UI churn that slows down Maestro&apos;s element detection. Run{' '}
            <code className="text-[10px] bg-surface-overlay px-1 rounded">
              npx expo run:ios --configuration Release
            </code>{' '}
            or{' '}
            <code className="text-[10px] bg-surface-overlay px-1 rounded">
              eas build --profile preview --platform ios
            </code>{' '}
            for best results.
          </div>
        </div>
      )}

      {/* Enriched tools list (collapsible) */}
      <ToolsList integration={integration} />

      {/* Env vars (collapsible) */}
      {integration.envKeys && integration.envKeys.length > 0 && (
        <>
          <button
            onClick={() => setShowEnvVars(!showEnvVars)}
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            {showEnvVars ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <span>Environment variables ({integration.envKeys.length})</span>
          </button>
          {showEnvVars && (
            <div className="bg-surface-base rounded-md p-2 space-y-1">
              {integration.envKeys.map((key) => (
                <div key={key} className="flex items-center gap-2 text-xs text-text-secondary">
                  <code className="text-text-primary font-mono text-[11px]">{key}</code>
                  <span className="text-text-muted">— set in your shell environment</span>
                </div>
              ))}
              <p className="text-[10px] text-text-muted mt-1">
                These are read from your environment at runtime. Set them in ~/.zshrc or
                ~/.bash_profile.
              </p>
            </div>
          )}
        </>
      )}

      {/* Docs link */}
      <a
        href={integration.docsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 transition-colors"
        onClick={(e) => {
          e.preventDefault()
          window.open(integration.docsUrl, '_blank')
        }}
      >
        <ExternalLink size={10} />
        {integration.displayName} Documentation
      </a>
    </div>
  )
}

// ── Integrations Page ─────────────────────────────────────────────────────────

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

  // Load workspace settings
  useEffect(() => {
    if (!activeWorkspace) return
    window.api
      .getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      .then(setSettings)
      .catch(() => {})
  }, [activeWorkspace])

  // Check CLI availability for all integrations
  useEffect(() => {
    for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
      window.api
        .checkExternalMcp({ command: integration.command })
        .then((result) => {
          setCliStatuses((prev) => ({
            ...prev,
            [integration.id]: { checked: true, found: result.available, path: result.path }
          }))
        })
        .catch(() => {
          setCliStatuses((prev) => ({
            ...prev,
            [integration.id]: { checked: true, found: false }
          }))
        })
    }
  }, [])

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
    <div className="p-6 space-y-6 max-w-2xl">
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
