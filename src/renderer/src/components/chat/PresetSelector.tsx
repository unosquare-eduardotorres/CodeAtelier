/**
 * PresetSelector — dropdown for selecting an LLM preset when creating a new conversation.
 *
 * Shows built-in presets (Full Claude, Full Local) and any custom presets.
 * Selecting "Custom" in the provider dropdown should default the preset to
 * the workspace's default preset.
 */

import { useEffect } from 'react'
import { Layers } from 'lucide-react'
import { usePresetStore } from '@renderer/store/preset.store'
import type { LLMPreset } from '../../../../shared/types'

interface PresetSelectorProps {
  workspaceId: string
  presetId: string | null
  onChange: (presetId: string | null) => void
}

export function PresetSelector({
  workspaceId,
  presetId,
  onChange
}: PresetSelectorProps): React.JSX.Element {
  const { presets, defaultPresetId, loading, fetchPresets } = usePresetStore()

  useEffect(() => {
    if (workspaceId) {
      fetchPresets(workspaceId)
    }
  }, [workspaceId, fetchPresets])

  if (loading || presets.length === 0) {
    return <></>
  }

  const selected = presets.find((p) => p.id === presetId) ?? null

  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1.5">
        <Layers size={14} className="inline mr-1.5 -mt-0.5" />
        LLM Preset{' '}
        <span className="text-text-muted font-normal">(optional)</span>
      </label>
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* None / Use defaults */}
        <PresetPill
          label="Default"
          isActive={presetId === null}
          onClick={() => onChange(null)}
        />
        {presets.map((preset) => (
          <PresetPill
            key={preset.id}
            label={preset.name}
            isActive={preset.id === presetId}
            isDefault={preset.id === defaultPresetId}
            onClick={() => onChange(preset.id)}
          />
        ))}
      </div>
      {selected && (
        <p className="text-xs text-text-muted mt-1">
          {summarizePreset(selected)}
        </p>
      )}
    </div>
  )
}

function PresetPill({
  label,
  isActive,
  isDefault,
  onClick
}: {
  label: string
  isActive: boolean
  isDefault?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors
        focus-visible:ring-2 focus-visible:ring-primary/50 ${
          isActive
            ? 'bg-primary-muted text-primary-text border border-primary/20'
            : 'text-text-secondary hover:bg-surface-overlay border border-transparent'
        }`}
    >
      {label}
      {isDefault && !isActive && (
        <span className="text-[9px] text-warning ml-0.5">★</span>
      )}
    </button>
  )
}

function summarizePreset(preset: LLMPreset): string {
  const count = Object.keys(preset.actionConfig).length
  if (count === 0) return 'All actions use default models'
  return `${count} action(s) customized`
}
