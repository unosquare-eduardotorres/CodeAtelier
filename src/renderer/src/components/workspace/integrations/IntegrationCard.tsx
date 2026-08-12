import { useState, useCallback } from 'react'
import {
  Smartphone,
  SquareKanban,
  Puzzle,
  ExternalLink,
  Check,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Shield,
  Zap,
  Lightbulb,
  Loader2
} from 'lucide-react'
import { Button, StatPill, Switch } from '@renderer/components/common/ui'
import type { ExternalMcpDefinition } from '../../../../../shared/constants'
import type { IntegrationCredentialStatus } from '../../../../../shared/integration-credentials.types'
import TokenImpactBadge from './TokenImpactBadge'
import UseCaseGrid from './UseCaseGrid'
import ToolsList from './ToolsList'
import IntegrationCredentialsForm from './IntegrationCredentialsForm'
import { deriveReadiness, isToggleBlocked, READINESS_META } from './integration-readiness'

/** Registry `icon` name → component. Falls back to a generic plug-in icon. */
const ICON_MAP: Record<string, typeof Smartphone> = {
  Smartphone,
  SquareKanban
}

const READINESS_ICON = {
  ready: <Check size={11} />,
  'setup-required': <AlertTriangle size={11} />,
  'cli-missing': <AlertTriangle size={11} />,
  checking: <Loader2 size={11} className="animate-spin" />
}

export default function IntegrationCard({
  integration,
  available,
  cliStatus,
  onToggle,
  savingId,
  workspaceId,
  credentialStatus,
  onCredentialStatusChange,
  onCredentialsCleared
}: {
  integration: ExternalMcpDefinition
  available: boolean
  cliStatus: { checked: boolean; found: boolean; path?: string }
  onToggle: (id: string, enabled: boolean) => void
  savingId: string | null
  workspaceId: string | null
  credentialStatus?: IntegrationCredentialStatus
  onCredentialStatusChange?: (integrationId: string, status: IntegrationCredentialStatus) => void
  /** Clearing credentials also disables the integration — the page must re-read settings. */
  onCredentialsCleared?: () => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [showEnvVars, setShowEnvVars] = useState(false)
  const isSaving = savingId === integration.id
  const Icon = ICON_MAP[integration.icon] ?? Puzzle
  const needsCredentials = !!integration.credentialFields?.length

  const readiness = deriveReadiness({ integration, cliStatus, workspaceId, credentialStatus })
  const blockedByCredentials = isToggleBlocked({
    integration,
    workspaceId,
    credentialStatus,
    available
  })
  const meta = READINESS_META[readiness]

  const readinessTitle =
    readiness === 'cli-missing'
      ? `CLI not found — install ${integration.command}`
      : readiness === 'ready' && !integration.bundledServerEntry && cliStatus.path
        ? `CLI detected: ${cliStatus.path}`
        : readiness === 'ready' && integration.bundledServerEntry
          ? 'Bundled — no install needed'
          : readiness === 'setup-required'
            ? workspaceId
              ? 'Credentials required — open Setup'
              : `Open a workspace to configure ${integration.displayName}`
            : 'Checking availability…'

  // Stable identity: this is fed into the form's load effect via `onStatusChange`.
  const handleStatusChange = useCallback(
    (status: IntegrationCredentialStatus) => onCredentialStatusChange?.(integration.id, status),
    [onCredentialStatusChange, integration.id]
  )

  return (
    // Two testids by design: E2E suites are split between the generic
    // `integration-card` selector and a `integration-card-<id>` prefix selector,
    // and one element can only carry one value. The outer wrapper serves the
    // per-integration id (so a suite can scope to Jira); the card itself keeps
    // the generic one.
    <div data-testid={`integration-card-${integration.id}`}>
      <div
        data-testid="integration-card"
        className="bg-surface-overlay rounded-lg border border-border-subtle"
      >
        {/* ── Collapsed row: everything the user needs to decide, and nothing else ── */}
        <div className="flex items-center gap-3 p-3">
          <button
            type="button"
            data-testid={`integration-expand-${integration.id}`}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="flex items-center gap-3 flex-1 min-w-0 text-left group"
          >
            {expanded ? (
              <ChevronDown size={14} className="text-text-muted shrink-0" />
            ) : (
              <ChevronRight size={14} className="text-text-muted shrink-0" />
            )}
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                available ? 'bg-accent/15 text-accent' : 'bg-surface-base text-text-muted'
              }`}
            >
              <Icon size={16} />
            </div>
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-text-primary group-hover:text-accent transition-colors">
                {integration.displayName}
              </h4>
              <p className="text-[11px] text-text-secondary truncate">{integration.description}</p>
            </div>
          </button>

          <div className="flex items-center gap-2 shrink-0">
            {/* One readiness value, one pill. `setup-required` expands straight to
                Setup so first-run discovery survives the collapse. */}
            <StatPill
              icon={READINESS_ICON[readiness]}
              label={meta.label}
              tone={meta.tone}
              title={readinessTitle}
              onClick={readiness === 'ready' ? undefined : () => setExpanded(true)}
            />
            <TokenImpactBadge impact={integration.tokenImpact} toolCount={integration.toolCount} />
            <Switch
              hideLabel
              checked={available}
              onChange={(next) => onToggle(integration.id, next)}
              disabled={isSaving || blockedByCredentials}
              label={`Enable ${integration.displayName} for this workspace`}
              title={
                blockedByCredentials
                  ? 'Add and save credentials first'
                  : available
                    ? 'Disable for this workspace'
                    : 'Make available for this workspace'
              }
            />
          </div>
        </div>

        {/* ── Expanded body: action-first — Setup → Capabilities → Tools → Docs ── */}
        {expanded && (
          <div className="border-t border-border-subtle p-3 space-y-4">
            {/* State-driven callouts, only meaningful once enabled */}
            {integration.tokenImpact === 'high' && available && (
              <div
                data-testid="integration-warning-high-impact"
                className="flex items-start gap-2 bg-warning-muted border border-warning/20 rounded-md p-2.5 text-xs text-text-secondary"
              >
                <Shield size={12} className="text-warning mt-0.5 flex-shrink-0" />
                <span>
                  <strong className="text-warning">High token impact:</strong> This integration
                  injects {integration.toolCount} tool definitions into the context window. Toggle
                  it OFF per-chat when not needed to save tokens.
                </span>
              </div>
            )}

            {available && (
              <div
                data-testid="integration-info-per-chat"
                className="flex items-start gap-2 bg-info-muted border border-info/20 rounded-md p-2.5 text-xs text-text-secondary"
              >
                <Lightbulb size={12} className="text-info mt-0.5 flex-shrink-0" />
                <span>
                  <strong className="text-info">Per-chat control:</strong> A{' '}
                  <span className="font-semibold">{integration.displayName}</span> pill will appear
                  next to the Plan/Build mode toggle in every chat. Toggle it ON/OFF per message —
                  tools are only injected when active.
                </span>
              </div>
            )}

            {available && integration.id === 'maestro' && (
              <div className="flex items-start gap-2 bg-surface-base border border-border-subtle rounded-md p-2.5 text-xs text-text-secondary">
                <Zap size={12} className="text-accent mt-0.5 flex-shrink-0" />
                <div>
                  <strong className="text-text-primary">Speed tip for Expo / React Native:</strong>{' '}
                  Use a <strong>release or preview build</strong> (not Expo Go) for dramatically
                  faster test execution. Dev mode&apos;s hot-reload polling, error overlays, and
                  LogBox create constant UI churn that slows down Maestro&apos;s element detection.
                  Run{' '}
                  <code className="text-[11px] bg-surface-overlay px-1 rounded">
                    npx expo run:ios --configuration Release
                  </code>{' '}
                  or{' '}
                  <code className="text-[11px] bg-surface-overlay px-1 rounded">
                    eas build --profile preview --platform ios
                  </code>{' '}
                  for best results.
                </div>
              </div>
            )}

            {/* ── Setup ── */}
            <section className="space-y-2">
              <h5 className="text-xs font-semibold text-text-primary">Setup</h5>

              {/* The registry's workflow steps read as setup instructions, so they
                  belong immediately above the form they describe. */}
              {integration.workflowSteps && integration.workflowSteps.length > 0 && (
                <ol data-testid="workflow-stepper" className="space-y-1.5">
                  {integration.workflowSteps.map((ws, i) => (
                    <li key={ws.step} className="flex gap-2 text-[11px] leading-relaxed">
                      <span className="font-mono tabular-nums text-accent shrink-0">{i + 1}.</span>
                      <span>
                        <span className="font-semibold text-text-primary">{ws.step}</span>
                        <span className="text-text-muted"> — {ws.description}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              {needsCredentials && workspaceId && (
                <IntegrationCredentialsForm
                  integration={integration}
                  workspaceId={workspaceId}
                  onStatusChange={handleStatusChange}
                  onCleared={onCredentialsCleared}
                />
              )}
              {blockedByCredentials && (
                <p className="text-[11px] text-warning">
                  {workspaceId
                    ? `Save the required credentials above before enabling ${integration.displayName}.`
                    : `Open a workspace to configure ${integration.displayName} credentials.`}
                </p>
              )}

              {/* Env vars (collapsible) — only for integrations without a credential form */}
              {!needsCredentials && integration.envKeys && integration.envKeys.length > 0 && (
                <>
                  <button
                    data-testid={`integration-env-toggle-${integration.id}`}
                    onClick={() => setShowEnvVars(!showEnvVars)}
                    className="flex items-center gap-1.5 text-[11px] text-text-secondary hover:text-text-primary transition-colors"
                  >
                    {showEnvVars ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    <span>Environment variables ({integration.envKeys.length})</span>
                  </button>
                  {showEnvVars && (
                    <div
                      data-testid="integration-env-list"
                      className="bg-surface-base rounded-md p-2 space-y-1"
                    >
                      {integration.envKeys.map((key) => (
                        <div
                          key={key}
                          className="flex items-center gap-2 text-[11px] text-text-secondary"
                        >
                          <code className="text-text-primary font-mono">{key}</code>
                          <span className="text-text-muted">— set in your shell environment</span>
                        </div>
                      ))}
                      <p className="text-[11px] text-text-muted mt-1">
                        These are read from your environment at runtime. Set them in ~/.zshrc or
                        ~/.bash_profile.
                      </p>
                    </div>
                  )}
                </>
              )}
            </section>

            {/* ── Capabilities ── */}
            {(integration.longDescription ||
              (integration.useCases && integration.useCases.length > 0)) && (
              <section className="space-y-2">
                <h5 className="text-xs font-semibold text-text-primary">
                  Why use {integration.displayName}?
                </h5>
                {integration.longDescription && (
                  <p className="text-[11px] text-text-secondary leading-relaxed">
                    {integration.longDescription}
                  </p>
                )}
                {integration.useCases && integration.useCases.length > 0 && (
                  <UseCaseGrid useCases={integration.useCases} />
                )}
              </section>
            )}

            {/* ── Tools ── */}
            <ToolsList integration={integration} />

            {/* ── Docs ── */}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => window.open(integration.docsUrl, '_blank', 'noopener,noreferrer')}
            >
              <ExternalLink size={11} />
              {integration.displayName} Documentation
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
