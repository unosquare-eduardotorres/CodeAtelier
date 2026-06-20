/**
 * PresetSelector — Pill-button selector for choosing an LLM preset
 * during new conversation creation. Shows preset cards with a compact
 * model summary and a "default" badge on the workspace default.
 */

import { useEffect } from 'react'
import { Cloud, Monitor, Settings2, Plus } from 'lucide-react'
import { usePresetStore } from '@renderer/store/preset.store'
import type { LLMPreset } from '../../../../shared/types'

interface PresetSelectorProps {
  workspaceId: string
  selectedPresetId: string | null
  onSelect: (presetId: string | null) => void
}

export default function PresetSelector({
  workspaceId,
  selectedPresetId,
  onSelect
}: PresetSelectorProps): React.JSX.Element {
  const { presets, defaultPresetId, fetchPresets } = usePresetStore()

  // Fetch presets if not loaded
  useEffect(() => {
    if (presets.length === 0 && workspaceId) {
      fetchPresets(workspaceId)
    }
  }, [workspaceId, presets.length, fetchPresets])

  // Auto-select default preset if nothing selected
  useEffect(() => {
    if (!selectedPresetId && defaultPresetId) {
      onSelect(defaultPresetId)
    }
  }, [selectedPresetId, defaultPresetId, onSelect])

  if (presets.length === 0) return <></>

  return (
    <div className="mt-4">
      <label className="block text-xs font-medium text-text-secondary mb-2">
        LLM Configuration
      </label>
      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => (
          <PresetPill
            key={preset.id}
            preset={preset}
            isSelected={selectedPresetId === preset.id}
            isDefault={preset.id === defaultPresetId}
            onClick={() => onSelect(preset.id)}
          />
        ))}
      </div>

      {/* Summary of selected preset */}
      {selectedPresetId && (
        <PresetSummary presetId={selectedPresetId} presets={presets} />
      )}
    </div>
  )
}

// ── Preset Pill Button ──

function PresetPill({
  preset,
  isSelected,
  isDefault,
  onClick
}: {
  preset: LLMPreset
  isSelected: boolean
  isDefault: boolean
  onClick: () => void
}): React.JSX.Element {
  const icon =
    preset.isBuiltIn && preset.name === 'Full Claude' ? (
      <Cloud className="w-3 h-3" />
    ) : preset.isBuiltIn && preset.name === 'Full Local' ? (
      <Monitor className="w-3 h-3" />
    ) : (
      <Settings2 className="w-3 h-3" />
    )

  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors ${
        isSelected
          ? 'border-accent-primary bg-accent-primary/10 text-accent-primary'
          : 'border-border-secondary text-text-secondary hover:border-border-primary hover:text-text-primary'
      }`}
    >
      {icon}
      <span className="font-medium">{preset.name}</span>
      {isDefault && (
        <span className="ml-0.5 text-[10px] text-text-tertiary">(default)</span>
      )}
    </button>
  )
}

// ── Compact Summary ──

function PresetSummary({
  presetId,
  presets
}: {
  presetId: string
  presets: LLMPreset[]
}): React.JSX.Element | null {
  const preset = presets.find((p) => p.id === presetId)
  if (!preset) return null

  const actionCount = Object.keys(preset.actionConfig).length

  let summary: string
  if (preset.isBuiltIn && preset.name === 'Full Claude') {
    summary = 'All actions use Claude defaults'
  } else if (preset.isBuiltIn && preset.name === 'Full Local') {
    summary = 'All actions use local LLM'
  } else if (actionCount === 0) {
    summary = 'Uses Claude defaults (no custom overrides)'
  } else {
    const providers = new Set(Object.values(preset.actionConfig).map((c) => c?.provider))
    if (providers.size === 1) {
      summary = `${actionCount} action${actionCount > 1 ? 's' : ''} configured (${providers.has('local-llm') ? 'Local' : 'Claude'})`
    } else {
      summary = `${actionCount} action${actionCount > 1 ? 's' : ''} configured (mixed providers)`
    }
  }

  return (
    <p className="mt-1.5 text-[11px] text-text-tertiary">
      {summary}
    </p>
  )
}
