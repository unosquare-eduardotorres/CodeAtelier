/**
 * useWorkspaceModelInfo — shared hook for loading provider, local model info,
 * and platform info from workspace settings.
 *
 * Used by both NewChatPage and NewConversationModal so they can render
 * the ModelPicker with consistent data.
 */

import { useState, useEffect, useRef } from 'react'
import type { LLMProvider, PlatformInfo } from '../../../../shared/types'

export interface LocalModelInfo {
  backend: string
  model: string
}

export function useWorkspaceModelInfo(workspaceId: string | undefined): {
  llmProvider: LLMProvider
  setLlmProvider: (p: LLMProvider) => void
  /** The workspace-level default provider (from DB settings). Use for reset-to-default. */
  defaultLlmProvider: LLMProvider
  localModelInfo: LocalModelInfo | null
  platformInfo: PlatformInfo | null
} {
  const [llmProvider, setLlmProvider] = useState<LLMProvider>('claude')
  const defaultLlmProviderRef = useRef<LLMProvider>('claude')
  const [localModelInfo, setLocalModelInfo] = useState<LocalModelInfo | null>(null)
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    window.api
      .getWorkspaceSettings({ workspaceId })
      .then((s) => {
        if (cancelled) return
        const provider = (s.llmProvider as LLMProvider) ?? 'claude'
        setLlmProvider(provider)
        defaultLlmProviderRef.current = provider
        setLocalModelInfo({
          backend: (s.localLlmBackend as string) ?? 'ollama',
          model: (s.localModel as string) ?? (s.ollamaModel as string) ?? 'unknown'
        })
      })
      .catch((err) => {
        console.warn('[useWorkspaceModelInfo] Failed to load workspace settings:', err)
      })
    window.api
      .getPlatformInfo()
      .then((info) => {
        if (!cancelled) setPlatformInfo(info)
      })
      .catch((err) => {
        console.warn('[useWorkspaceModelInfo] Failed to load platform info:', err)
      })
    return () => { cancelled = true }
  }, [workspaceId])

  return {
    llmProvider,
    setLlmProvider,
    defaultLlmProvider: defaultLlmProviderRef.current,
    localModelInfo,
    platformInfo
  }
}
