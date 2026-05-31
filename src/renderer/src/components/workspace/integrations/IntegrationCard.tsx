import { useState } from 'react'
import {
  Smartphone,
  ExternalLink,
  Check,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Shield,
  Zap
} from 'lucide-react'
import type { ExternalMcpDefinition } from '../../../../../shared/constants'
import TokenImpactBadge from './TokenImpactBadge'
import UseCaseGrid from './UseCaseGrid'
import WorkflowStepper from './WorkflowStepper'
import ToolsList from './ToolsList'

export default function IntegrationCard({
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
