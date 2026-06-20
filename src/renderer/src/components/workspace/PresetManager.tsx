/**
 * PresetManager — Workspace-level LLM preset management.
 *
 * Displays saved presets as cards, allows creating/editing/deleting custom presets,
 * and setting the workspace default. Lives in the Models settings tab alongside
 * the existing ModelConfigTab.
 */

import { useEffect, useState, useCallback } from 'react'
import { Star, Plus, Pencil, Trash2, Cloud, Monitor, Settings2 } from 'lucide-react'
import { usePresetStore } from '@renderer/store/preset.store'
import { useWorkspaceStore, useToastStore } from '@renderer/store'
import type { LLMPreset } from '../../../../shared/types'
import PresetEditor from './PresetEditor'

export default function PresetManager(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const addToast = useToastStore((s) => s.addToast)
  const {
    presets,
    defaultPresetId,
    loading,
    editingPreset,
    fetchPresets,
    deletePreset,
    setDefault,
    setEditingPreset
  } = usePresetStore()

  const [showEditor, setShowEditor] = useState(false)

  // Fetch presets on workspace change
  useEffect(() => {
    if (activeWorkspace) {
      fetchPresets(activeWorkspace.id)
    }
  }, [activeWorkspace?.id, fetchPresets])

  const handleSetDefault = useCallback(
    async (presetId: string) => {
      if (!activeWorkspace) return
      await setDefault(activeWorkspace.id, presetId)
      addToast({ message: 'Default preset updated', type: 'success' })
    },
    [activeWorkspace, setDefault, addToast]
  )

  const handleDelete = useCallback(
    async (preset: LLMPreset) => {
      if (preset.isBuiltIn) return
      const deleted = await deletePreset(preset.id)
      if (deleted) {
        addToast({ message: `Preset "${preset.name}" deleted`, type: 'success' })
      } else {
        addToast({ message: 'Cannot delete built-in presets', type: 'error' })
      }
    },
    [deletePreset, addToast]
  )

  const handleEdit = useCallback(
    (preset: LLMPreset) => {
      setEditingPreset(preset)
      setShowEditor(true)
    },
    [setEditingPreset]
  )

  const handleCreateNew = useCallback(() => {
    setEditingPreset(null)
    setShowEditor(true)
  }, [setEditingPreset])

  const handleEditorClose = useCallback(() => {
    setShowEditor(false)
    setEditingPreset(null)
    if (activeWorkspace) {
      fetchPresets(activeWorkspace.id)
    }
  }, [setEditingPreset, activeWorkspace, fetchPresets])

  if (!activeWorkspace) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-sm text-text-secondary">Select a workspace to manage presets.</p>
      </div>
    )
  }

  const defaultPreset = presets.find((p) => p.id === defaultPresetId)

  return (
    <div className="w-full" data-testid="preset-manager">
      {/* ── Section Header ── */}
      <div className="mb-4 mt-8 border-t border-border-secondary pt-6">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <Settings2 className="w-4 h-4 text-accent-primary" />
          LLM Presets
        </h3>
        <p className="text-xs text-text-secondary mt-1">
          Create named configurations that assign specific models to each action.
          Select a preset when creating new chats.
        </p>
      </div>

      {/* ── Active Default ── */}
      {defaultPreset && (
        <div className="mb-4 rounded-lg border border-accent-primary/30 bg-accent-primary/5 px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-accent-primary font-medium">
            <Star className="w-3.5 h-3.5 fill-current" />
            <span>Active Default: {defaultPreset.name}</span>
          </div>
          <p className="text-[11px] text-text-tertiary mt-0.5">
            Used when creating new chats without a preset override.
          </p>
        </div>
      )}

      {/* ── Preset Cards Grid ── */}
      {loading ? (
        <div className="text-xs text-text-secondary py-8 text-center">Loading presets…</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {presets.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              isDefault={preset.id === defaultPresetId}
              onSetDefault={() => handleSetDefault(preset.id)}
              onEdit={() => handleEdit(preset)}
              onDelete={() => handleDelete(preset)}
            />
          ))}

          {/* ── Create New Card ── */}
          <button
            onClick={handleCreateNew}
            data-testid="preset-create-btn"
            className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-secondary p-4 text-text-tertiary hover:border-accent-primary hover:text-accent-primary transition-colors min-h-[120px]"
          >
            <Plus className="w-5 h-5" />
            <span className="text-xs font-medium">Create Preset</span>
          </button>
        </div>
      )}

      {/* ── Preset Editor Modal ── */}
      {showEditor && (
        <PresetEditor
          preset={editingPreset}
          workspaceId={activeWorkspace.id}
          onClose={handleEditorClose}
        />
      )}
    </div>
  )
}

// ── Preset Card ──

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
  const actionCount = Object.keys(preset.actionConfig).length
  const hasLocalActions = Object.values(preset.actionConfig).some(
    (c) => c?.provider === 'local-llm'
  )
  const hasClaudeActions =
    actionCount === 0 || Object.values(preset.actionConfig).some((c) => c?.provider === 'claude')

  return (
    <div
      data-testid={`preset-card-${preset.id}`}
      className={`relative rounded-lg border p-4 transition-colors ${
        isDefault
          ? 'border-accent-primary/40 bg-accent-primary/5'
          : 'border-border-secondary bg-bg-secondary hover:border-border-primary'
      }`}
    >
      {/* Icon + Name */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          {preset.isBuiltIn && preset.name === 'Full Claude' && (
            <Cloud className="w-4 h-4 text-blue-400" />
          )}
          {preset.isBuiltIn && preset.name === 'Full Local' && (
            <Monitor className="w-4 h-4 text-green-400" />
          )}
          {!preset.isBuiltIn && <Settings2 className="w-4 h-4 text-text-tertiary" />}
          <span className="text-sm font-medium text-text-primary">{preset.name}</span>
        </div>
        {isDefault && <Star className="w-3.5 h-3.5 text-accent-primary fill-current" />}
      </div>

      {/* Provider badges */}
      <div className="flex gap-1.5 mb-3">
        {hasClaudeActions && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] bg-blue-500/10 text-blue-400">
            <Cloud className="w-2.5 h-2.5" />
            Claude
          </span>
        )}
        {hasLocalActions && (
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] bg-green-500/10 text-green-400">
            <Monitor className="w-2.5 h-2.5" />
            Local
          </span>
        )}
      </div>

      {/* Subtitle */}
      <p className="text-[11px] text-text-tertiary mb-3">
        {preset.isBuiltIn && preset.name === 'Full Claude' && 'All actions use Claude defaults'}
        {preset.isBuiltIn && preset.name === 'Full Local' && 'All actions use local LLM'}
        {!preset.isBuiltIn &&
          (actionCount === 0
            ? 'No custom overrides'
            : `${actionCount} action${actionCount > 1 ? 's' : ''} configured`)}
      </p>

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        {!isDefault && (
          <button
            onClick={onSetDefault}
            data-testid={`preset-default-btn-${preset.id}`}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-text-secondary hover:text-accent-primary hover:bg-accent-primary/10 transition-colors"
          >
            <Star className="w-3 h-3" />
            Set Default
          </button>
        )}
        <button
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-tertiary transition-colors"
        >
          <Pencil className="w-3 h-3" />
          {preset.isBuiltIn ? 'View' : 'Edit'}
        </button>
        {!preset.isBuiltIn && (
          <button
            onClick={onDelete}
            data-testid={`preset-delete-btn-${preset.id}`}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-text-secondary hover:text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Delete
          </button>
        )}
      </div>
    </div>
  )
}
