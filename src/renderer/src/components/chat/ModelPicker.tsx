/**
 * ModelPicker — routing summary + optional per-conversation customization.
 *
 * Shows the workspace routing summary (Plan / Build / Background models).
 * "Customize" expander reveals per-conversation overrides via grouped selects.
 * Provider is derived from routing — no explicit provider selection.
 */

import { useState, useMemo } from 'react'
import { ChevronDown, ChevronRight, Settings, AlertCircle } from 'lucide-react'
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL_CONFIG
} from '../../../../shared/constants'
import type {
  LLMProvider,
  ModelAction,
  ModelRoleAssignment,
  ModelRoleMap
} from '../../../../shared/types'

// ── Types ──

export interface ModelPickerProps {
  /** Workspace-level model roles (from settings) */
  workspaceModelRoles: ModelRoleMap
  /** Workspace-level Claude model overrides (legacy) */
  claudeModelOverrides: Record<string, string>
  /** Workspace-level provider (derived from routing) */
  workspaceProvider: LLMProvider
  /** oMLX chat-capable models */
  omlxModels: string[]
  /** Per-conversation routing overrides — persisted on conversation creation */
  overrides: Partial<ModelRoleMap>
  /** Called when user changes per-conversation overrides */
  onOverridesChange: (overrides: Partial<ModelRoleMap>) => void
  /** Compact mode for sidebar modal */
  compact?: boolean
}

// ── Helpers ──

interface ModelOption {
  id: string
  label: string
  provider: LLMProvider
  group: 'claude' | 'local'
}

function buildModelOptions(omlxModels: string[]): ModelOption[] {
  const options: ModelOption[] = AVAILABLE_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    provider: 'claude' as const,
    group: 'claude' as const
  }))
  for (const model of omlxModels) {
    options.push({
      id: model,
      label: model,
      provider: 'local-llm',
      group: 'local'
    })
  }
  return options
}

/** Resolve the effective model for a role from overrides → workspace roles → defaults */
function resolveModel(
  action: ModelAction,
  overrides: Partial<ModelRoleMap>,
  workspaceRoles: ModelRoleMap,
  claudeOverrides: Record<string, string>,
  workspaceProvider: LLMProvider
): { modelId: string; provider: LLMProvider } {
  // Per-conversation override takes precedence
  const override = overrides[action]
  if (override) return { modelId: override.modelId, provider: override.provider }

  // Workspace model roles
  const wsRole = workspaceRoles[action]
  if (wsRole) return { modelId: wsRole.modelId, provider: wsRole.provider }

  // Legacy Claude overrides
  const legacyOverride = claudeOverrides[action]
  if (legacyOverride) return { modelId: legacyOverride, provider: workspaceProvider }

  // Default
  return {
    modelId: DEFAULT_MODEL_CONFIG[action] ?? 'claude-opus-4-8',
    provider: 'claude'
  }
}

/** Get a human-friendly label for a model ID */
function modelLabel(modelId: string): string {
  const claude = AVAILABLE_MODELS.find((m) => m.id === modelId)
  if (claude) return claude.label
  // Local models: show as-is but truncate long names
  return modelId.length > 30 ? `${modelId.slice(0, 27)}…` : modelId
}

// ── Routing summary roles ──

const SUMMARY_ROLES = [
  { label: 'Plan', action: 'da-vinci:plan' as ModelAction },
  { label: 'Build', action: 'da-vinci:build' as ModelAction },
  { label: 'Background', action: 'haiku' as ModelAction }
]

// ── Component ──

export function ModelPicker({
  workspaceModelRoles,
  claudeModelOverrides,
  workspaceProvider,
  omlxModels,
  overrides,
  onOverridesChange,
  compact
}: ModelPickerProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const modelOptions = useMemo(() => buildModelOptions(omlxModels), [omlxModels])
  const claudeOptions = useMemo(() => modelOptions.filter((o) => o.group === 'claude'), [modelOptions])
  const localOptions = useMemo(() => modelOptions.filter((o) => o.group === 'local'), [modelOptions])

  // Resolved effective models for summary
  const resolved = useMemo(
    () =>
      SUMMARY_ROLES.map((role) => ({
        ...role,
        ...resolveModel(role.action, overrides, workspaceModelRoles, claudeModelOverrides, workspaceProvider)
      })),
    [overrides, workspaceModelRoles, claudeModelOverrides, workspaceProvider]
  )

  // Check if plan and build use different providers (cross-provider warning)
  const hasMixedProviders = useMemo(() => {
    const planProvider = resolved.find((r) => r.action === 'da-vinci:plan')?.provider
    const buildProvider = resolved.find((r) => r.action === 'da-vinci:build')?.provider
    return planProvider && buildProvider && planProvider !== buildProvider
  }, [resolved])

  const hasOverrides = Object.keys(overrides).length > 0

  const handleAssign = (action: ModelAction, modelId: string): void => {
    const opt = modelOptions.find((o) => o.id === modelId)
    if (!opt) return

    const assignment: ModelRoleAssignment = {
      provider: opt.provider,
      modelId: opt.id,
      ...(opt.provider === 'local-llm' ? { localBackend: 'omlx' as const } : {})
    }

    // Set this and related actions (e.g. da-vinci:plan → project-specialist:plan)
    const updated = { ...overrides, [action]: assignment }
    onOverridesChange(updated)
  }

  const handleClearOverrides = (): void => {
    onOverridesChange({})
  }

  // ── Routing Summary (always visible) ──
  const summary = (
    <div className="flex items-center gap-1.5 flex-wrap text-xs text-text-secondary">
      {resolved.map((role, i) => (
        <span key={role.action} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-text-muted mx-0.5">·</span>}
          <span className="text-text-muted">{role.label}:</span>
          <span className="text-text-primary font-medium">{modelLabel(role.modelId)}</span>
        </span>
      ))}
      {hasOverrides && (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-primary-muted text-primary-text text-xs font-medium ml-1">
          Custom
        </span>
      )}
    </div>
  )

  // ── Compact mode (sidebar modal) ──
  if (compact) {
    return (
      <div data-testid="model-picker-compact">
        <label className="block text-sm font-medium text-text-primary mb-1.5">Model routing</label>
        {summary}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors mt-2"
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {expanded ? 'Hide' : 'Customize'} for this conversation
        </button>
        {expanded && (
          <div className="mt-2 space-y-1.5">
            {SUMMARY_ROLES.map((role) => {
              const effective = resolveModel(role.action, overrides, workspaceModelRoles, claudeModelOverrides, workspaceProvider)
              return (
                <div key={role.action} className="flex items-center justify-between gap-3">
                  <span className="text-xs text-text-secondary">{role.label}</span>
                  <select
                    value={effective.modelId}
                    onChange={(e) => handleAssign(role.action, e.target.value)}
                    className="bg-surface-base border border-border-subtle rounded-lg px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 max-w-[200px]"
                    aria-label={`${role.label} model`}
                  >
                    <optgroup label="Claude">
                      {claudeOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                      ))}
                    </optgroup>
                    {localOptions.length > 0 && (
                      <optgroup label="Local (oMLX)">
                        {localOptions.map((opt) => (
                          <option key={opt.id} value={opt.id}>{opt.id}</option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                </div>
              )
            })}
            {hasMixedProviders && (
              <div className="flex items-start gap-2 px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/20 mt-1.5">
                <AlertCircle size={12} className="text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-300">
                  <span className="font-medium">Mixed providers</span> — all actions will use the
                  Plan model&apos;s provider.
                </p>
              </div>
            )}
            {hasOverrides && (
              <button
                onClick={handleClearOverrides}
                className="text-xs text-text-muted hover:text-text-secondary transition-colors"
              >
                Reset to workspace defaults
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── Full mode (NewChatPage) ──
  return (
    <div className="w-full mb-5" data-testid="model-picker">
      <label className="block text-sm font-medium text-text-primary mb-1.5">Model routing</label>

      {/* Routing Summary */}
      {summary}

      {/* Customize expander */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors mt-2"
      >
        <Settings size={11} />
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {expanded ? 'Hide customization' : 'Customize for this conversation'}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2 bg-surface-overlay border border-border-subtle rounded-lg p-3">
          <p className="text-xs text-text-muted mb-2">
            Per-conversation overrides — changes here only affect this conversation.
          </p>
          {SUMMARY_ROLES.map((role) => {
            const effective = resolveModel(role.action, overrides, workspaceModelRoles, claudeModelOverrides, workspaceProvider)
            return (
              <div key={role.action} className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-text-primary">{role.label}</span>
                </div>
                <select
                  value={effective.modelId}
                  onChange={(e) => handleAssign(role.action, e.target.value)}
                  className="bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-xs font-medium text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 shrink-0 max-w-xs"
                  aria-label={`${role.label} model`}
                >
                  <optgroup label="Claude">
                    {claudeOptions.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                  </optgroup>
                  {localOptions.length > 0 && (
                    <optgroup label="Local (oMLX)">
                      {localOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>{opt.id}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
            )
          })}

          {/* Cross-provider warning */}
          {hasMixedProviders && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 mt-2">
              <AlertCircle size={14} className="text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-300">
                <span className="font-medium">Mixed providers</span> — all actions will use the
                Plan model&apos;s provider in the same conversation.
              </p>
            </div>
          )}

          {hasOverrides && (
            <button
              onClick={handleClearOverrides}
              className="text-xs text-text-muted hover:text-text-secondary transition-colors mt-1"
            >
              Reset to workspace defaults
            </button>
          )}
        </div>
      )}
    </div>
  )
}
