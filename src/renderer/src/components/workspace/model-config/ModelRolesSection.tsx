/**
 * ModelRolesSection — "Model Routing" card.
 *
 * Cross-provider model role assignment: every selector is a grouped <select>
 * dropdown with <optgroup label="Claude"> and <optgroup label="oMLX">.
 * Changes persist immediately on selection (no Save bar).
 *
 * Sections: Chat roles (Plan / Build / Background) + Blueprint roles
 * (unified selector + per-phase expander).
 */

import { useState, useMemo, useCallback } from 'react'
import { ChevronDown, ChevronRight, Layers, AlertTriangle, AlertCircle, Lock } from 'lucide-react'
import { SettingsCard } from '@renderer/components/common'
import {
  DEFAULT_MODEL_CONFIG,
  MODEL_ROLE_ROWS
} from '../../../../../shared/constants'
import { isOptionalRoleAction } from '../../../../../shared/model-role-binding'
import type {
  LLMProvider,
  LocalLLMBackend,
  ModelAction,
  ModelRoleAssignment,
  ModelRoleMap,
  ModelRoleRowDef
} from '../../../../../shared/types'
import {
  buildAssignment,
  buildModelOptions,
  localBackendLabel,
  type ModelOption
} from './model-roles-assignment'

// ─── Types ───────────────────────────────────────────────

export interface ModelRolesSectionProps {
  modelRoles: ModelRoleMap
  claudeModelOverrides: Record<string, string>
  workspaceProvider: LLMProvider
  /** Chat-capable models from the last connection test (embedding models excluded) */
  omlxModels: string[]
  /**
   * The local backend the user is actually on. Recorded on every local-llm
   * assignment — hardcoding it wrote Ollama users' routing down as oMLX.
   */
  localBackend: LocalLLMBackend
  /** Persists both roles + overrides */
  onModelRolesChange: (roles: ModelRoleMap, overrides: Record<string, string>) => void
  /** Workspace-level fallback model */
  fallbackModel: string | undefined
  /** Persists the fallback model */
  onFallbackModelChange: (modelId: string) => void
}

// ─── Role Definitions ────────────────────────────────────

/** The catalogue is shared with main so both enumerate the same roles. */
const rolesInGroup = (group: ModelRoleRowDef['group']): ModelRoleRowDef[] =>
  MODEL_ROLE_ROWS.filter((r) => r.group === group)

const CHAT_ROLES = rolesInGroup('chat')
const BLUEPRINT_ROLES = rolesInGroup('blueprint')
const QUALITY_ROLES = rolesInGroup('quality')
const COUNCIL_ROLES = rolesInGroup('council')
const BACKGROUND_ROLES = rolesInGroup('background')

// ─── Role Row Component ─────────────────────────────────

interface RoleRowProps {
  role: ModelRoleRowDef
  modelRoles: ModelRoleMap
  claudeModelOverrides: Record<string, string>
  workspaceProvider: LLMProvider
  modelOptions: ModelOption[]
  localBackend: LocalLLMBackend
  onAssign: (actions: ModelAction[], assignment: ModelRoleAssignment | null) => void
}

function RoleRow({
  role,
  modelRoles,
  claudeModelOverrides,
  workspaceProvider,
  modelOptions,
  localBackend,
  onAssign
}: RoleRowProps): React.JSX.Element {
  // Resolve effective model
  const effective = useMemo(() => {
    const roleAssignment = modelRoles[role.primaryAction]
    if (roleAssignment) {
      return {
        modelId: roleAssignment.modelId,
        provider: roleAssignment.provider,
        source: 'roles' as const
      }
    }
    const override = claudeModelOverrides[role.primaryAction]
    if (override) {
      return {
        modelId: override,
        provider: workspaceProvider,
        source: 'override' as const
      }
    }
    return {
      modelId: DEFAULT_MODEL_CONFIG[role.primaryAction] ?? 'claude-opus-4-8',
      provider: 'claude' as LLMProvider,
      source: 'default' as const
    }
  }, [modelRoles, claudeModelOverrides, workspaceProvider, role.primaryAction])

  // M9.1 — optional roles (peer-review, code-review) are OFF until bound.
  // The row then shows an explicit "Off" selection instead of a phantom model.
  const isOptional = isOptionalRoleAction(role.primaryAction)
  const isOff =
    isOptional &&
    !modelRoles[role.primaryAction] &&
    !claudeModelOverrides[role.primaryAction]

  // M9.1 — decorrelation warning: an adversarial reviewer running the same
  // model as the layer it reviews loses the independence the layer exists for.
  const decorrelationWarning = useMemo(() => {
    if (isOff || role.primaryAction !== 'blueprint:code-review') return null
    const lead = modelRoles['blueprint:lead-review']
    const leadModel =
      lead?.modelId ?? claudeModelOverrides['blueprint:lead-review'] ?? null
    if (!leadModel) return null
    return effective.modelId === leadModel
      ? 'Same model as Lead Review — an independent reviewer catches different bugs'
      : null
  }, [isOff, modelRoles, claudeModelOverrides, role.primaryAction, effective.modelId])

  const selectedId = effective.modelId
  const claudeOptions = useMemo(
    () => modelOptions.filter((o) => o.group === 'claude'),
    [modelOptions]
  )
  const localOptions = useMemo(
    () => modelOptions.filter((o) => o.group === 'local'),
    [modelOptions]
  )

  // Check if the selected local model is missing from the current server list
  const isUnavailable =
    effective.provider === 'local-llm' && !localOptions.some((o) => o.id === selectedId)

  const handleSelect = useCallback(
    (optId: string) => {
      // M9.1 — the explicit "Off" option for optional roles: binds
      // { disabled: true } so "turned off" is distinguishable from
      // "never configured" (see model-role-binding.ts).
      if (optId === '__off__') {
        onAssign(role.actions, {
          provider: workspaceProvider,
          modelId: '',
          disabled: true
        })
        return
      }
      const opt = modelOptions.find((o) => o.id === optId)
      if (opt) {
        onAssign(role.actions, buildAssignment(opt, localBackend))
      }
    },
    [modelOptions, onAssign, role.actions, localBackend, workspaceProvider]
  )

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-medium text-text-primary">{role.label}</h4>
        <p className="text-xs text-text-secondary truncate">{role.description}</p>
        {/* M9.1 — decorrelation hint for the adversarial reviewer */}
        {decorrelationWarning && (
          <p className="text-[10px] text-warning mt-0.5 flex items-center gap-1">
            <AlertTriangle size={10} className="inline" />
            {decorrelationWarning}
          </p>
        )}
      </div>

      <select
        value={isOff ? '__off__' : selectedId}
        onChange={(e) => handleSelect(e.target.value)}
        aria-label={role.label}
        className="bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-xs font-medium text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 shrink-0 max-w-xs"
      >
        {/* M9.1 — explicit Off option for optional roles */}
        {isOptional && (
          <option value="__off__">Off — skip this layer</option>
        )}
        <optgroup label="Claude">
          {claudeOptions.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </optgroup>
        {(localOptions.length > 0 || isUnavailable) && (
          <optgroup label={`Local (${localBackendLabel(localBackend)})`}>
            {localOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.id}
              </option>
            ))}
            {isUnavailable && <option value={selectedId}>⚠ {selectedId} (unavailable)</option>}
          </optgroup>
        )}
      </select>
      {/* Thinking Budget — Phase C placeholder */}
      <select
        disabled
        aria-label={`${role.label} thinking budget`}
        title="Thinking Budget — coming in a future release"
        className="bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-xs font-medium text-text-muted focus:outline-none shrink-0 w-24 opacity-50 cursor-not-allowed"
      >
        <option>Medium</option>
      </select>
      {isUnavailable && (
        <AlertTriangle
          size={14}
          className="text-amber-400 shrink-0"
          aria-label="Model not found on current server"
        />
      )}
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────

export default function ModelRolesSection({
  modelRoles,
  claudeModelOverrides,
  workspaceProvider,
  omlxModels,
  localBackend,
  onModelRolesChange,
  fallbackModel,
  onFallbackModelChange
}: ModelRolesSectionProps): React.JSX.Element {
  const [blueprintExpanded, setBlueprintExpanded] = useState(false)

  const modelOptions = useMemo(() => buildModelOptions(omlxModels), [omlxModels])

  // Check if all blueprint actions use the same model
  const blueprintAllSame = useMemo(() => {
    const allActions = BLUEPRINT_ROLES.flatMap((r) => r.actions)
    const models = allActions.map((a) => {
      const role = modelRoles[a]
      if (role) return role.modelId
      const override = claudeModelOverrides[a]
      if (override) return override
      return DEFAULT_MODEL_CONFIG[a] ?? 'claude-opus-4-8'
    })
    return models.every((m) => m === models[0])
  }, [modelRoles, claudeModelOverrides])

  const blueprintPrimaryModel = useMemo(() => {
    const role = modelRoles['blueprint:specify']
    if (role) return role.modelId
    const override = claudeModelOverrides['blueprint:specify']
    if (override) return override
    return DEFAULT_MODEL_CONFIG['blueprint:specify'] ?? 'claude-opus-4-8'
  }, [modelRoles, claudeModelOverrides])

  // Cross-provider warning: plan and build use different providers
  const crossProviderWarning = useMemo(() => {
    const planProvider = modelRoles['specialist:plan']?.provider
    const buildProvider = modelRoles['specialist:build']?.provider
    if (planProvider && buildProvider && planProvider !== buildProvider) {
      return planProvider === 'claude' ? 'Claude' : 'Local LLM'
    }
    return null
  }, [modelRoles])

  // Check if selected blueprint model is unavailable
  const blueprintProvider = modelRoles['blueprint:specify']?.provider
  const claudeOptions = useMemo(
    () => modelOptions.filter((o) => o.group === 'claude'),
    [modelOptions]
  )
  const localOptions = useMemo(
    () => modelOptions.filter((o) => o.group === 'local'),
    [modelOptions]
  )
  const isBlueprintUnavailable =
    blueprintProvider === 'local-llm' && !localOptions.some((o) => o.id === blueprintPrimaryModel)

  // Check if selected fallback model is unavailable
  const isFallbackUnavailable =
    !!fallbackModel &&
    !claudeOptions.some((o) => o.id === fallbackModel) &&
    !localOptions.some((o) => o.id === fallbackModel)

  /** Assign a model to multiple actions — builds overrides and calls instant-persist */
  const handleAssign = useCallback(
    (actions: ModelAction[], assignment: ModelRoleAssignment | null) => {
      const updated = { ...modelRoles }
      const updatedOverrides = { ...claudeModelOverrides }

      for (const action of actions) {
        if (assignment) {
          updated[action] = assignment
          if (assignment.provider === 'claude') {
            updatedOverrides[action] = assignment.modelId
          } else {
            delete updatedOverrides[action]
          }
        } else {
          delete updated[action]
          delete updatedOverrides[action]
        }
      }

      onModelRolesChange(updated, updatedOverrides)
    },
    [modelRoles, claudeModelOverrides, onModelRolesChange]
  )

  /** Assign all blueprint actions at once (collapsed mode) */
  const handleBlueprintUnified = useCallback(
    (optId: string) => {
      const opt = modelOptions.find((o) => o.id === optId)
      if (!opt) return
      const allActions = BLUEPRINT_ROLES.flatMap((r) => r.actions)
      handleAssign(allActions, buildAssignment(opt, localBackend))
    },
    [modelOptions, handleAssign, localBackend]
  )

  return (
    <div data-testid="model-roles-section" className="space-y-6 mb-6">
      {/* ── Section Header ── */}
      <div className="flex items-center gap-2">
        <Layers size={14} className="text-text-muted" />
        <h3 className="text-sm text-text-secondary uppercase tracking-wider font-medium">
          Model Routing
        </h3>
        <span className="inline-flex items-center gap-1 text-xs text-text-muted ml-auto">
          Applies to all providers · saved with the rest of this tab
        </span>
      </div>

      {/* ── Chat Roles ── */}
      <div>
        <h4 className="text-xs font-medium text-text-secondary mb-2">Chat</h4>
        <SettingsCard>
          <div className="mb-2">
            <p className="text-xs text-text-secondary">
              Choose which model handles each type of task. Changes apply to new conversations.
            </p>
          </div>
          <div className="divide-y divide-border-subtle">
            {CHAT_ROLES.map((role) => (
              <RoleRow
                key={role.label}
                role={role}
                modelRoles={modelRoles}
                claudeModelOverrides={claudeModelOverrides}
                workspaceProvider={workspaceProvider}
                modelOptions={modelOptions}
                localBackend={localBackend}
                onAssign={handleAssign}
              />
            ))}
          </div>
        </SettingsCard>
      </div>

      {/* ── Blueprint Roles ── */}
      <div>
        <h4 className="text-xs font-medium text-text-secondary mb-2">Blueprint</h4>
        <SettingsCard>
          {/* Unified selector */}
          <div className="flex items-center justify-between gap-4 py-2">
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-medium text-text-primary">Blueprints</h4>
              <p className="text-xs text-text-secondary truncate">
                All specification, planning, and build phases
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={blueprintAllSame ? blueprintPrimaryModel : ''}
                onChange={(e) => handleBlueprintUnified(e.target.value)}
                aria-label="Blueprint model"
                className="bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-xs font-medium text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 shrink-0 max-w-xs"
              >
                {!blueprintAllSame && (
                  <option value="" disabled>
                    Mixed — customize below
                  </option>
                )}
                <optgroup label="Claude">
                  {claudeOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
                {(localOptions.length > 0 || isBlueprintUnavailable) && (
                  <optgroup label={`Local (${localBackendLabel(localBackend)})`}>
                    {localOptions.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.id}
                      </option>
                    ))}
                    {isBlueprintUnavailable && (
                      <option value={blueprintPrimaryModel}>
                        ⚠ {blueprintPrimaryModel} (unavailable)
                      </option>
                    )}
                  </optgroup>
                )}
              </select>
              {isBlueprintUnavailable && (
                <AlertTriangle
                  size={14}
                  className="text-amber-400 shrink-0"
                  aria-label="Model not found on current server"
                />
              )}
            </div>
          </div>

          {/* Custom expander */}
          <button
            onClick={() => setBlueprintExpanded(!blueprintExpanded)}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors mt-1 mb-1"
          >
            {blueprintExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {blueprintExpanded ? 'Hide' : 'Customize'} per-phase models
          </button>

          {/* Expanded per-phase rows */}
          {blueprintExpanded && (
            <div className="divide-y divide-border-subtle border-t border-border-subtle mt-1 pt-1">
              {BLUEPRINT_ROLES.map((role) => (
                <RoleRow
                  key={role.label}
                  role={role}
                  modelRoles={modelRoles}
                  claudeModelOverrides={claudeModelOverrides}
                  workspaceProvider={workspaceProvider}
                  modelOptions={modelOptions}
                  localBackend={localBackend}
                  onAssign={handleAssign}
                />
              ))}
            </div>
          )}
        </SettingsCard>
      </div>

      {/* ── Quality & Review ── */}
      <div>
        <h4 className="text-xs font-medium text-text-secondary mb-2">Quality & Review</h4>
        <SettingsCard>
          <div className="divide-y divide-border-subtle">
            {QUALITY_ROLES.map((role) => (
              <RoleRow
                key={role.label}
                role={role}
                modelRoles={modelRoles}
                claudeModelOverrides={claudeModelOverrides}
                workspaceProvider={workspaceProvider}
                modelOptions={modelOptions}
                localBackend={localBackend}
                onAssign={handleAssign}
              />
            ))}
          </div>
        </SettingsCard>
      </div>

      {/* ── Council ── */}
      <div>
        <h4 className="text-xs font-medium text-text-secondary mb-2">Council</h4>
        <SettingsCard>
          <div className="divide-y divide-border-subtle">
            {COUNCIL_ROLES.map((role) => (
              <RoleRow
                key={role.label}
                role={role}
                modelRoles={modelRoles}
                claudeModelOverrides={claudeModelOverrides}
                workspaceProvider={workspaceProvider}
                modelOptions={modelOptions}
                localBackend={localBackend}
                onAssign={handleAssign}
              />
            ))}
          </div>
        </SettingsCard>
      </div>

      {/* ── Background Tasks ── */}
      <div>
        <h4 className="text-xs font-medium text-text-secondary mb-2">Background Tasks</h4>
        <SettingsCard>
          <div className="flex items-center gap-2 mb-2">
            <p className="text-xs text-text-muted italic flex items-center gap-1">
              <Lock size={10} />
              Thinking Budget — per-action reasoning depth control coming soon
            </p>
          </div>
          <div className="divide-y divide-border-subtle">
            {BACKGROUND_ROLES.map((role) => (
              <RoleRow
                key={role.label}
                role={role}
                modelRoles={modelRoles}
                claudeModelOverrides={claudeModelOverrides}
                workspaceProvider={workspaceProvider}
                modelOptions={modelOptions}
                localBackend={localBackend}
                onAssign={handleAssign}
              />
            ))}
          </div>
        </SettingsCard>
      </div>

      {/* ── Cross-provider warning ── */}
      {crossProviderWarning && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <AlertCircle size={14} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-300">
            <span className="font-medium">Mixed providers</span> — all actions will use the Plan
            model&apos;s provider ({crossProviderWarning}) in the same conversation. Full
            cross-provider support coming soon.
          </p>
        </div>
      )}

      {/* ── Fallback Model ── */}
      <div>
        <h4 className="text-xs font-medium text-text-secondary mb-2">Fallback</h4>
        <SettingsCard>
          <div className="flex items-center justify-between gap-4 py-2">
            <div className="flex-1 min-w-0">
              <h4 className="text-sm font-medium text-text-primary">Fallback model</h4>
              <p className="text-xs text-text-secondary truncate">
                Used when an assigned model is unavailable
              </p>
            </div>
            <select
              value={fallbackModel ?? DEFAULT_MODEL_CONFIG['specialist']}
              onChange={(e) => onFallbackModelChange(e.target.value)}
              aria-label="Fallback model"
              className="bg-surface-base border border-border-subtle rounded-lg px-3 py-1.5 text-xs font-medium text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 shrink-0 max-w-xs"
            >
              <optgroup label="Claude">
                {claudeOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </optgroup>
              {(localOptions.length > 0 || isFallbackUnavailable) && (
                <optgroup label={`Local (${localBackendLabel(localBackend)})`}>
                  {localOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.id}
                    </option>
                  ))}
                  {isFallbackUnavailable && (
                    <option value={fallbackModel}>⚠ {fallbackModel} (unavailable)</option>
                  )}
                </optgroup>
              )}
            </select>
            {isFallbackUnavailable && (
              <AlertTriangle
                size={14}
                className="text-amber-400 shrink-0"
                aria-label="Model not found on current server"
              />
            )}
          </div>
        </SettingsCard>
      </div>

      {/* ── Embeddings pointer ── */}
      <div className="px-1">
        <p className="text-xs text-text-muted">
          Embeddings are chosen alongside the other local models, under{' '}
          <span className="text-text-secondary font-medium">Models available</span>.
        </p>
      </div>
    </div>
  )
}
