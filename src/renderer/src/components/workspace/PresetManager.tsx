/**
 * PresetManager — workspace-level preset management panel.
 *
 * Shown in ModelConfigTab. Allows viewing, creating, editing, and deleting
 * LLM configuration presets. Built-in presets cannot be edited or deleted.
 */

import { useEffect, useState } from 'react'
import { Plus, Star, Trash2, Edit3 } from 'lucide-react'
import { usePresetStore } from '@renderer/store/preset.store'
import { useWorkspaceStore } from '@renderer/store/workspace.store'
import { ACTION_GROUPS, DEFAULT_MODEL_CONFIG, AVAILABLE_MODELS } from '../../../../shared/constants'
import type { ActionModelConfig, LLMPreset, ModelAction } from '../../../../shared/types'

// ── Main Component ─────────────────────────────────────────────────

export function PresetManager(): React.JSX.Element {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const { presets, defaultPresetId, loading, fetchPresets, deletePreset, setDefault } =
    usePresetStore()
  const [editingPreset, setEditingPreset] = useState<LLMPreset | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  useEffect(() => {
    if (activeWorkspace?.id) {
      fetchPresets(activeWorkspace.id)
    }
  }, [activeWorkspace?.id, fetchPresets])

  if (!activeWorkspace) return <></>

  return (
    <div className="mt-8 border-t border-border-subtle pt-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">LLM Presets</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Configure named model configurations for different workflows.
          </p>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary/10 text-primary
                     rounded-lg hover:bg-primary/20 transition-colors"
        >
          <Plus size={14} />
          New Preset
        </button>
      </div>

      {loading ? (
        <div className="text-xs text-text-muted py-4 text-center">Loading presets…</div>
      ) : (
        <div className="space-y-2">
          {presets.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              isDefault={preset.id === defaultPresetId}
              onSetDefault={() => setDefault(activeWorkspace.id, preset.id)}
              onEdit={() => setEditingPreset(preset)}
              onDelete={() => deletePreset(preset.id)}
            />
          ))}
        </div>
      )}

      {(isCreating || editingPreset) && (
        <PresetEditor
          preset={editingPreset}
          workspaceId={activeWorkspace.id}
          onClose={() => {
            setIsCreating(false)
            setEditingPreset(null)
          }}
        />
      )}
    </div>
  )
}

// ── Preset Card ────────────────────────────────────────────────────

function PresetCard({
  preset,
  isDefault,
  onSetDefault,
  onEdit,
  onDelete
}: {
  preset: LLMPreset
  isDefault: boolean
  onSetDefault: () => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const configuredCount = Object.keys(preset.actionConfig).length
  const totalCount = Object.keys(DEFAULT_MODEL_CONFIG).length

  return (
    <div className="flex items-center justify-between p-3 rounded-lg border border-border-subtle bg-surface-secondary">
      <div className="flex items-center gap-3">
        <button
          onClick={onSetDefault}
          className={`p-1 rounded transition-colors ${
            isDefault ? 'text-warning' : 'text-text-muted hover:text-warning/60'
          }`}
          title={isDefault ? 'Default preset' : 'Set as default'}
        >
          <Star size={16} fill={isDefault ? 'currentColor' : 'none'} />
        </button>
        <div>
          <span className="text-sm font-medium text-text-primary">{preset.name}</span>
          {preset.isBuiltIn && (
            <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded">
              Built-in
            </span>
          )}
          <p className="text-xs text-text-muted mt-0.5">
            {configuredCount === 0
              ? 'All actions use defaults'
              : `${configuredCount}/${totalCount} actions customized`}
          </p>
        </div>
      </div>
      {!preset.isBuiltIn && (
        <div className="flex items-center gap-1">
          <button
            onClick={onEdit}
            className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
            title="Edit preset"
          >
            <Edit3 size={14} />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
            title="Delete preset"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

// ── Preset Editor (inline modal) ───────────────────────────────────

function PresetEditor({
  preset,
  workspaceId,
  onClose
}: {
  preset: LLMPreset | null
  workspaceId: string
  onClose: () => void
}): React.JSX.Element {
  const { createPreset, updatePreset: updatePresetStore } = usePresetStore()
  const [name, setName] = useState(preset?.name ?? '')
  const [actionConfig, setActionConfig] = useState<Partial<Record<ModelAction, ActionModelConfig>>>(
    preset?.actionConfig ?? {}
  )

  const handleSave = async (): Promise<void> => {
    if (!name.trim()) return

    if (preset) {
      await updatePresetStore(preset.id, { name: name.trim(), actionConfig })
    } else {
      await createPreset(workspaceId, name.trim(), actionConfig)
    }
    onClose()
  }

  const updateAction = (action: ModelAction, modelId: string): void => {
    setActionConfig((prev) => ({
      ...prev,
      [action]: { provider: 'claude' as const, modelId }
    }))
  }

  const clearAction = (action: ModelAction): void => {
    setActionConfig((prev) => {
      const next = { ...prev }
      delete next[action]
      return next
    })
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative bg-surface-primary border border-border-subtle rounded-xl shadow-xl
                      w-[600px] max-h-[80vh] overflow-y-auto p-6"
      >
        <h3 className="text-sm font-semibold text-text-primary mb-4">
          {preset ? 'Edit Preset' : 'New Preset'}
        </h3>

        {/* Name */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-text-secondary mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-surface-secondary border border-border-subtle
                       rounded-lg text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
            placeholder="My Custom Preset"
          />
        </div>

        {/* Action Groups */}
        <div className="space-y-4">
          {ACTION_GROUPS.map((group) => (
            <div key={group.id} className="border border-border-subtle rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <span>{group.icon}</span>
                <span className="text-xs font-semibold text-text-primary">{group.label}</span>
                <span className="text-[10px] text-text-muted">{group.description}</span>
              </div>
              <div className="space-y-1.5">
                {group.actions.map((action) => {
                  const current = actionConfig[action]
                  return (
                    <div key={action} className="flex items-center justify-between gap-2">
                      <span className="text-xs text-text-secondary font-mono">{action}</span>
                      <div className="flex items-center gap-1.5">
                        <select
                          value={current?.modelId ?? ''}
                          onChange={(e) => {
                            if (e.target.value) {
                              updateAction(action, e.target.value)
                            } else {
                              clearAction(action)
                            }
                          }}
                          className="text-xs bg-surface-secondary border border-border-subtle rounded px-2 py-1
                                     text-text-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
                        >
                          <option value="">Default ({DEFAULT_MODEL_CONFIG[action]})</option>
                          {AVAILABLE_MODELS.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-text-secondary bg-surface-secondary
                       rounded-lg hover:bg-surface-overlay transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="px-4 py-2 text-xs font-medium text-white bg-primary rounded-lg
                       hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {preset ? 'Save Changes' : 'Create Preset'}
          </button>
        </div>
      </div>
    </div>
  )
}
