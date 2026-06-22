/**
 * PresetEditor — Modal for creating or editing LLM presets.
 *
 * Shows action groups with provider/model selectors. In grouped mode,
 * changing a group applies to all actions. Advanced toggle reveals
 * per-action overrides. Enforces Chat provider parity constraint.
 */

import { useState, useMemo, useCallback } from 'react'
import { X, ChevronDown, Cloud, Monitor, AlertCircle } from 'lucide-react'
import { usePresetStore } from '@renderer/store/preset.store'
import { useToastStore } from '@renderer/store'
import { ACTION_GROUPS, AVAILABLE_MODELS, DEFAULT_MODEL_CONFIG, RECOMMENDED_LOCAL_MODELS } from '../../../../shared/constants'
import type { ActionModelConfig, LLMPreset, LLMProvider, ModelAction } from '../../../../shared/types'

interface PresetEditorProps {
  preset: LLMPreset | null // null = creating new
  workspaceId: string
  onClose: () => void
}

/** Fallback local model ID — resolved once at module level to avoid repeated optional chaining. */
const DEFAULT_LOCAL_MODEL_ID = RECOMMENDED_LOCAL_MODELS[0]?.ollamaId ?? 'qwen3-coder:30b'

/** Build an ActionModelConfig preserving the existing localBackend if present. */
function buildActionConfig(
  existing: ActionModelConfig | undefined,
  modelId: string,
  providerOverride?: LLMProvider
): ActionModelConfig {
  const provider = providerOverride ?? existing?.provider ?? 'claude'
  return {
    provider,
    modelId,
    ...(existing?.localBackend ? { localBackend: existing.localBackend } : {})
  }
}

/** Validate Chat group provider parity constraint. Returns error message or null. */
function validateChatProviderParity(
  actionConfig: Partial<Record<ModelAction, ActionModelConfig>>
): string | null {
  const chatGroup = ACTION_GROUPS.find((g) => g.id === 'chat')
  if (!chatGroup) return null

  const planActions = chatGroup.actions.filter((a) => a.includes(':plan'))
  const buildActions = chatGroup.actions.filter((a) => a.includes(':build'))
  const planProviders = new Set(planActions.map((a) => actionConfig[a]?.provider).filter(Boolean))
  const buildProviders = new Set(buildActions.map((a) => actionConfig[a]?.provider).filter(Boolean))

  if (planProviders.size > 0 && buildProviders.size > 0) {
    const all = new Set([...planProviders, ...buildProviders])
    if (all.size > 1) {
      return 'Chat Plan and Build actions must use the same provider'
    }
  }
  return null
}

/** Execute the save/create flow. Returns true on success. */
async function executePresetSave(
  isNew: boolean,
  name: string,
  actionConfig: Partial<Record<ModelAction, ActionModelConfig>>,
  presetId: string | undefined,
  workspaceId: string,
  createPreset: (wId: string, name: string, config: Partial<Record<ModelAction, ActionModelConfig>>) => Promise<unknown>,
  updatePreset: (id: string, data: { name: string; actionConfig: Partial<Record<ModelAction, ActionModelConfig>> }) => Promise<boolean>
): Promise<boolean> {
  if (isNew) {
    const result = await createPreset(workspaceId, name.trim(), actionConfig)
    return !!result
  }
  return updatePreset(presetId!, { name: name.trim(), actionConfig })
}

// ── usePresetEditorState — all state + handlers for PresetEditor ──

interface PresetEditorState {
  name: string
  setName: (name: string) => void
  actionConfig: Partial<Record<ModelAction, ActionModelConfig>>
  showAdvanced: boolean
  setShowAdvanced: (v: boolean) => void
  saving: boolean
  isNew: boolean
  isBuiltIn: boolean
  validationError: string | null
  handleGroupProviderChange: (groupId: string, provider: LLMProvider) => void
  handleGroupModelChange: (groupId: string, modelId: string) => void
  handleActionModelChange: (action: ModelAction, modelId: string) => void
  handleActionProviderChange: (action: ModelAction, provider: LLMProvider) => void
  handleClearAction: (action: ModelAction) => void
  handleSave: () => Promise<void>
}

function usePresetEditorState(
  preset: LLMPreset | null,
  workspaceId: string,
  onClose: () => void
): PresetEditorState {
  const { createPreset, updatePreset } = usePresetStore()
  const addToast = useToastStore((s) => s.addToast)

  const [name, setName] = useState(preset?.name ?? '')
  const [actionConfig, setActionConfig] = useState<Partial<Record<ModelAction, ActionModelConfig>>>(
    preset?.actionConfig ? { ...preset.actionConfig } : {}
  )
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)

  const isNew = !preset
  const isBuiltIn = preset?.isBuiltIn ?? false

  const validationError = useMemo(
    () => validateChatProviderParity(actionConfig),
    [actionConfig]
  )

  // ── Handlers ──

  const handleGroupProviderChange = useCallback(
    (groupId: string, provider: LLMProvider) => {
      const group = ACTION_GROUPS.find((g) => g.id === groupId)
      if (!group) return

      setActionConfig((prev) => {
        const next = { ...prev }
        for (const action of group.actions) {
          const defaultModelId = DEFAULT_MODEL_CONFIG[action]
          const modelId =
            provider === 'claude'
              ? (prev[action]?.provider === 'claude' ? prev[action]!.modelId : defaultModelId)
              : DEFAULT_LOCAL_MODEL_ID
          next[action] = {
            provider,
            modelId,
            ...(provider === 'local-llm' ? { localBackend: 'ollama' as const } : {})
          }
        }
        return next
      })
    },
    []
  )

  const handleGroupModelChange = useCallback(
    (groupId: string, modelId: string) => {
      const group = ACTION_GROUPS.find((g) => g.id === groupId)
      if (!group) return

      setActionConfig((prev) => {
        const next = { ...prev }
        for (const action of group.actions) {
          next[action] = buildActionConfig(prev[action], modelId)
        }
        return next
      })
    },
    []
  )

  const handleActionModelChange = useCallback(
    (action: ModelAction, modelId: string) => {
      setActionConfig((prev) => ({
        ...prev,
        [action]: buildActionConfig(prev[action], modelId)
      }))
    },
    []
  )

  const handleActionProviderChange = useCallback(
    (action: ModelAction, provider: LLMProvider) => {
      setActionConfig((prev) => ({
        ...prev,
        [action]: {
          provider,
          modelId:
            provider === 'claude'
              ? DEFAULT_MODEL_CONFIG[action]
              : DEFAULT_LOCAL_MODEL_ID,
          ...(provider === 'local-llm' ? { localBackend: 'ollama' as const } : {})
        }
      }))
    },
    []
  )

  const handleClearAction = useCallback((action: ModelAction) => {
    setActionConfig((prev) => {
      const next = { ...prev }
      delete next[action]
      return next
    })
  }, [])

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      addToast({ message: 'Preset name is required', type: 'error' })
      return
    }
    if (validationError) {
      addToast({ message: validationError, type: 'error' })
      return
    }

    setSaving(true)
    try {
      const ok = await executePresetSave(isNew, name, actionConfig, preset?.id, workspaceId, createPreset, updatePreset)
      if (ok) {
        addToast({ message: `Preset "${name}" ${isNew ? 'created' : 'updated'}`, type: 'success' })
        onClose()
      }
    } finally {
      setSaving(false)
    }
  }, [name, actionConfig, validationError, isNew, preset, workspaceId, createPreset, updatePreset, addToast, onClose])

  return {
    name, setName,
    actionConfig,
    showAdvanced, setShowAdvanced,
    saving,
    isNew, isBuiltIn,
    validationError,
    handleGroupProviderChange,
    handleGroupModelChange,
    handleActionModelChange,
    handleActionProviderChange,
    handleClearAction,
    handleSave
  }
}

// ── PresetEditorHeader — title bar with save/close buttons ──

interface PresetEditorHeaderProps {
  isNew: boolean
  isBuiltIn: boolean
  presetName: string
  saving: boolean
  validationError: string | null
  onSave: () => void
  onClose: () => void
}

function PresetEditorHeader({
  isNew, isBuiltIn, presetName, saving, validationError, onSave, onClose
}: PresetEditorHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-border-secondary px-6 py-4">
      <h2 className="text-sm font-semibold text-text-primary">
        {isNew ? 'Create Preset' : isBuiltIn ? `View: ${presetName}` : `Edit: ${presetName}`}
      </h2>
      <div className="flex items-center gap-2">
        {!isBuiltIn && (
          <button
            onClick={onSave}
            disabled={saving || !!validationError}
            data-testid="preset-save-btn"
            className="rounded-md bg-accent-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-primary/90 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
          </button>
        )}
        <button
          onClick={onClose}
          className="rounded-md p-1.5 text-text-tertiary hover:text-text-primary hover:bg-bg-secondary transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// ── Main Component ──

export default function PresetEditor({ preset, workspaceId, onClose }: PresetEditorProps): React.JSX.Element {
  const {
    name, setName,
    actionConfig,
    showAdvanced, setShowAdvanced,
    saving,
    isNew, isBuiltIn,
    validationError,
    handleGroupProviderChange,
    handleGroupModelChange,
    handleActionModelChange,
    handleActionProviderChange,
    handleClearAction,
    handleSave
  } = usePresetEditorState(preset, workspaceId, onClose)

  // ── Derived ──

  const nonAdvancedGroups = ACTION_GROUPS.filter((g) => !g.advanced)
  const advancedGroups = ACTION_GROUPS.filter((g) => g.advanced)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="preset-editor-modal">
      <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-xl border border-border-secondary bg-bg-primary shadow-2xl">
        {/* ── Header ── */}
        <PresetEditorHeader
          isNew={isNew}
          isBuiltIn={isBuiltIn}
          presetName={preset?.name ?? ''}
          saving={saving}
          validationError={validationError}
          onSave={handleSave}
          onClose={onClose}
        />

        {/* ── Body ── */}
        <div className="px-6 py-4 space-y-5">
          {/* Name */}
          {!isBuiltIn && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Preset Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Cost Saver, Full Power, Dev Mix"
                data-testid="preset-name-input"
                className="w-full rounded-md border border-border-secondary bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder-text-tertiary focus:border-accent-primary focus:outline-none"
              />
            </div>
          )}

          {/* Validation error */}
          {validationError && (
            <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {validationError}
            </div>
          )}

          {/* ── Action Groups ── */}
          {nonAdvancedGroups.map((group) => (
            <ActionGroupSection
              key={group.id}
              group={group}
              actionConfig={actionConfig}
              readOnly={isBuiltIn}
              onGroupProviderChange={(provider) => handleGroupProviderChange(group.id, provider)}
              onGroupModelChange={(modelId) => handleGroupModelChange(group.id, modelId)}
              onActionModelChange={handleActionModelChange}
              onActionProviderChange={handleActionProviderChange}
              onClearAction={handleClearAction}
              showPerAction={showAdvanced}
            />
          ))}

          {/* ── Advanced Toggle ── */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <ChevronDown
              className={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
            />
            {showAdvanced ? 'Hide per-action overrides' : 'Show per-action overrides (Advanced)'}
          </button>

          {/* ── Advanced Groups ── */}
          {showAdvanced &&
            advancedGroups.map((group) => (
              <ActionGroupSection
                key={group.id}
                group={group}
                actionConfig={actionConfig}
                readOnly={isBuiltIn}
                onGroupProviderChange={(provider) => handleGroupProviderChange(group.id, provider)}
                onGroupModelChange={(modelId) => handleGroupModelChange(group.id, modelId)}
                onActionModelChange={handleActionModelChange}
                onActionProviderChange={handleActionProviderChange}
                onClearAction={handleClearAction}
                showPerAction={true}
              />
            ))}
        </div>
      </div>
    </div>
  )
}

// ── Action Group Section ──

interface ActionGroupSectionProps {
  group: (typeof ACTION_GROUPS)[number]
  actionConfig: Partial<Record<ModelAction, ActionModelConfig>>
  readOnly: boolean
  onGroupProviderChange: (provider: LLMProvider) => void
  onGroupModelChange: (modelId: string) => void
  onActionModelChange: (action: ModelAction, modelId: string) => void
  onActionProviderChange: (action: ModelAction, provider: LLMProvider) => void
  onClearAction: (action: ModelAction) => void
  showPerAction: boolean
}

function ActionGroupSection({
  group,
  actionConfig,
  readOnly,
  onGroupProviderChange,
  onGroupModelChange,
  onActionModelChange,
  onActionProviderChange,
  onClearAction,
  showPerAction
}: ActionGroupSectionProps): React.JSX.Element {
  // Determine the "representative" config for the group
  const firstAction = group.actions[0]
  const firstConfig = firstAction ? actionConfig[firstAction] : undefined
  const groupProvider: LLMProvider = firstConfig?.provider ?? 'claude'
  const groupModelId: string = firstConfig?.modelId ?? DEFAULT_MODEL_CONFIG[firstAction ?? 'da-vinci']

  return (
    <div className="rounded-lg border border-border-secondary bg-bg-secondary/50 p-4">
      {/* Group header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base">{group.icon}</span>
        <span className="text-sm font-medium text-text-primary">{group.label}</span>
        <span className="text-[11px] text-text-tertiary">— {group.description}</span>
      </div>

      {/* Group-level controls */}
      <div className="flex flex-wrap items-center gap-3 mb-2">
        {/* Provider toggle */}
        <div className="flex items-center gap-1">
          <label className="text-[11px] text-text-tertiary mr-1">Provider:</label>
          <button
            disabled={readOnly}
            onClick={() => onGroupProviderChange('claude')}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors ${
              groupProvider === 'claude'
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                : 'text-text-tertiary hover:text-text-secondary border border-transparent'
            } ${readOnly ? 'cursor-not-allowed opacity-60' : ''}`}
          >
            <Cloud className="w-3 h-3" />
            Claude
          </button>
          <button
            disabled={readOnly}
            onClick={() => onGroupProviderChange('local-llm')}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors ${
              groupProvider === 'local-llm'
                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                : 'text-text-tertiary hover:text-text-secondary border border-transparent'
            } ${readOnly ? 'cursor-not-allowed opacity-60' : ''}`}
          >
            <Monitor className="w-3 h-3" />
            Local
          </button>
        </div>

        {/* Group model selector */}
        <div className="flex items-center gap-1">
          <label className="text-[11px] text-text-tertiary mr-1">Model:</label>
          <ModelSelect
            provider={groupProvider}
            value={groupModelId}
            onChange={(modelId) => onGroupModelChange(modelId)}
            disabled={readOnly}
          />
        </div>
      </div>

      {/* Per-action overrides (advanced mode) */}
      {showPerAction && group.actions.length > 1 && (
        <div className="mt-3 space-y-1.5 border-t border-border-secondary/50 pt-3">
          {group.actions.map((action) => {
            const config = actionConfig[action]
            const hasOverride = !!config
            const provider = config?.provider ?? groupProvider
            const modelId = config?.modelId ?? groupModelId

            return (
              <div key={action} className="flex items-center gap-2 text-[11px]">
                <span className="w-40 text-text-tertiary truncate" title={action}>
                  {action}
                </span>
                <ModelSelect
                  provider={provider}
                  value={modelId}
                  onChange={(mid) => onActionModelChange(action, mid)}
                  disabled={readOnly}
                  small
                />
                {!readOnly && (
                  <button
                    disabled={readOnly}
                    onClick={() =>
                      onActionProviderChange(
                        action,
                        provider === 'claude' ? 'local-llm' : 'claude'
                      )
                    }
                    className="text-[10px] text-text-tertiary hover:text-text-secondary"
                    title="Toggle provider"
                  >
                    {provider === 'claude' ? '☁️' : '💻'}
                  </button>
                )}
                {!readOnly && hasOverride && (
                  <button
                    onClick={() => onClearAction(action)}
                    className="text-[10px] text-text-tertiary hover:text-red-400"
                    title="Reset to group default"
                  >
                    ✕
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Model Select Dropdown ──

function ModelSelect({
  provider,
  value,
  onChange,
  disabled,
  small
}: {
  provider: LLMProvider
  value: string
  onChange: (modelId: string) => void
  disabled?: boolean
  small?: boolean
}): React.JSX.Element {
  const models =
    provider === 'claude'
      ? AVAILABLE_MODELS.map((m) => ({ id: m.id, label: m.label }))
      : RECOMMENDED_LOCAL_MODELS.map((m) => ({ id: m.ollamaId, label: m.label }))

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`rounded border border-border-secondary bg-bg-secondary text-text-primary focus:border-accent-primary focus:outline-none disabled:opacity-60 ${
        small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]'
      }`}
    >
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
      {/* Show current value if not in the list (custom model) */}
      {!models.some((m) => m.id === value) && (
        <option value={value}>{value}</option>
      )}
    </select>
  )
}
