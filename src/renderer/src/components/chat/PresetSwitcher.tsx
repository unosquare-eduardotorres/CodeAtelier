/**
 * PresetSwitcher — Compact pill/dropdown for switching the active preset
 * on a conversation mid-flight. Shown in the chat panel floating pill bar.
 *
 * When switching to a different provider, shows a confirmation warning
 * about context handoff before applying.
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Settings2, ChevronDown, AlertTriangle } from 'lucide-react'
import { usePresetStore } from '@renderer/store/preset.store'
import { useWorkspaceStore, useToastStore } from '@renderer/store'
import type { Conversation, LLMPreset } from '../../../../shared/types'

interface PresetSwitcherProps {
  conversation: Conversation
  disabled?: boolean
}

export default function PresetSwitcher({
  conversation,
  disabled
}: PresetSwitcherProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const { presets, fetchPresets } = usePresetStore()
  const addToast = useToastStore((s) => s.addToast)

  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<LLMPreset | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Fetch presets if not loaded
  useEffect(() => {
    if (activeWorkspace && presets.length === 0) {
      fetchPresets(activeWorkspace.id)
    }
  }, [activeWorkspace?.id, presets.length, fetchPresets])

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
        setConfirming(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const currentPreset = presets.find((p) => p.id === conversation.presetId)
  const presetLabel = currentPreset?.name ?? 'Default'

  const handleSelect = useCallback(
    async (preset: LLMPreset) => {
      if (preset.id === conversation.presetId) {
        setOpen(false)
        return
      }

      try {
        const result = (await window.api.switchConversationPreset({
          conversationId: conversation.id,
          presetId: preset.id
        })) as { success?: boolean; requiresHandoff?: boolean; error?: string }

        if (result.error) {
          addToast({ message: result.error, type: 'error' })
          return
        }

        if (result.requiresHandoff) {
          addToast({
            message: `Switched to "${preset.name}" — provider changed, context handoff applied`,
            type: 'info'
          })
        } else {
          addToast({
            message: `Switched to "${preset.name}"`,
            type: 'success'
          })
        }

        setOpen(false)
        setConfirming(null)
      } catch (error) {
        addToast({ message: 'Failed to switch preset', type: 'error' })
      }
    },
    [conversation.id, conversation.presetId, addToast]
  )

  const handlePresetClick = useCallback(
    (preset: LLMPreset) => {
      if (preset.id === conversation.presetId) {
        setOpen(false)
        return
      }

      // Check if this would change the chat provider (requiring handoff)
      const currentProvider = currentPreset
        ? Object.values(currentPreset.actionConfig).find(
            (c) => c?.provider
          )?.provider ?? 'claude'
        : 'claude'
      const newProvider =
        Object.values(preset.actionConfig).find((c) => c?.provider)?.provider ??
        'claude'

      if (currentProvider !== newProvider) {
        setConfirming(preset)
      } else {
        handleSelect(preset)
      }
    },
    [conversation.presetId, currentPreset, handleSelect]
  )

  if (presets.length === 0) return <></>

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Pill button */}
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-border-secondary bg-bg-secondary/80 text-text-secondary backdrop-blur-sm shadow-lg transition-all hover:border-border-primary hover:text-text-primary disabled:opacity-50"
      >
        <Settings2 className="w-3 h-3" />
        <span className="max-w-[100px] truncate">{presetLabel}</span>
        <ChevronDown className="w-3 h-3" />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-56 rounded-lg border border-border-secondary bg-bg-primary shadow-2xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-border-secondary">
            <span className="text-[11px] font-medium text-text-tertiary">Switch Preset</span>
          </div>

          {/* Confirmation warning */}
          {confirming && (
            <div className="px-3 py-2 bg-yellow-500/10 border-b border-yellow-500/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-[11px] text-yellow-300 font-medium">Provider Change</p>
                  <p className="text-[10px] text-yellow-400/80 mt-0.5">
                    Switching to "{confirming.name}" will change the chat provider.
                    Context will be summarized and handed off.
                  </p>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => setConfirming(null)}
                      className="px-2 py-0.5 rounded text-[10px] text-text-secondary hover:text-text-primary border border-border-secondary"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handleSelect(confirming)}
                      className="px-2 py-0.5 rounded text-[10px] text-yellow-300 hover:text-yellow-200 bg-yellow-500/20 border border-yellow-500/30"
                    >
                      Switch & Handoff
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Preset list */}
          <div className="max-h-48 overflow-y-auto py-1">
            {presets.map((preset) => {
              const isActive = preset.id === conversation.presetId
              return (
                <button
                  key={preset.id}
                  onClick={() => handlePresetClick(preset)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                    isActive
                      ? 'bg-accent-primary/10 text-accent-primary'
                      : 'text-text-secondary hover:bg-bg-secondary hover:text-text-primary'
                  }`}
                >
                  <Settings2 className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{preset.name}</span>
                  {isActive && (
                    <span className="ml-auto text-[10px] text-accent-primary">✓</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
