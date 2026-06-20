/**
 * PresetSwitcher — floating pill for switching the LLM preset on an active conversation.
 *
 * Shows in the ChatPanel toolbar. When switching from Claude → Local (or vice versa),
 * shows a confirmation dialog explaining the handoff implications.
 */

import { useState, useEffect, useRef } from 'react'
import { Layers, ChevronDown, Check, AlertTriangle } from 'lucide-react'
import { usePresetStore } from '@renderer/store/preset.store'
import type { Conversation, LLMPreset } from '../../../../shared/types'

interface PresetSwitcherProps {
  conversation: Conversation | null
  disabled?: boolean
}

export function PresetSwitcher({
  conversation,
  disabled
}: PresetSwitcherProps): React.JSX.Element | null {
  const { presets, fetchPresets } = usePresetStore()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<LLMPreset | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // Fetch presets when workspace changes
  useEffect(() => {
    if (conversation?.workspaceId) {
      fetchPresets(conversation.workspaceId)
    }
  }, [conversation?.workspaceId, fetchPresets])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (!conversation || presets.length === 0) return null

  const currentPreset = presets.find((p) => p.id === conversation.presetId)
  const label = currentPreset?.name ?? 'Default'

  const handleSelect = async (preset: LLMPreset): Promise<void> => {
    if (preset.id === conversation.presetId) {
      setOpen(false)
      return
    }

    // Check if provider is changing — show confirmation
    const result = (await window.api.switchConversationPreset({
      conversationId: conversation.id,
      presetId: preset.id
    })) as { success: boolean; requiresHandoff: boolean } | { error: string }

    if ('error' in result) return

    if (result.requiresHandoff) {
      setConfirming(preset)
    }
    setOpen(false)
  }

  return (
    <>
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen(!open)}
          disabled={disabled}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium
                     bg-surface-secondary/80 backdrop-blur border border-border-subtle
                     rounded-full hover:bg-surface-overlay transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Layers size={12} />
          {label}
          <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <div className="absolute bottom-full mb-1 left-0 w-48 bg-surface-primary border border-border-subtle
                          rounded-lg shadow-lg overflow-hidden z-50">
            {presets.map((preset) => {
              const isActive = preset.id === conversation.presetId
              return (
                <button
                  key={preset.id}
                  onClick={() => handleSelect(preset)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left
                    hover:bg-surface-overlay transition-colors ${
                      isActive ? 'text-primary font-medium' : 'text-text-secondary'
                    }`}
                >
                  {isActive && <Check size={12} />}
                  <span className={isActive ? '' : 'ml-5'}>{preset.name}</span>
                  {preset.isBuiltIn && (
                    <span className="text-[9px] text-text-muted ml-auto">built-in</span>
                  )}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Handoff confirmation dialog */}
      {confirming && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setConfirming(null)} />
          <div className="relative bg-surface-primary border border-border-subtle rounded-xl
                          shadow-xl p-5 w-[400px]">
            <div className="flex items-start gap-3">
              <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold text-text-primary mb-1">
                  Provider Change Detected
                </h4>
                <p className="text-xs text-text-secondary leading-relaxed">
                  Switching to &ldquo;{confirming.name}&rdquo; will change the chat provider.
                  A handoff context summary will be generated so the new provider can continue
                  the conversation.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setConfirming(null)}
                className="px-3 py-1.5 text-xs font-medium text-text-secondary bg-surface-secondary
                           rounded-lg hover:bg-surface-overlay transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
