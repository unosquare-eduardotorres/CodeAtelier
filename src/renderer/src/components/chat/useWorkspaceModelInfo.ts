/**
 * useWorkspaceModelInfo — shared hook for loading model routing info,
 * local model info, and platform info from workspace settings.
 *
 * Used by both NewChatPage and NewConversationModal so they can render
 * the ModelPicker with consistent data.
 */

import { useState, useEffect } from 'react'
import type { LLMProvider, ModelRoleMap, PlatformInfo } from '../../../../shared/types'

export interface LocalModelInfo {
  backend: string
  model: string
}

export function useWorkspaceModelInfo(workspaceId: string | undefined): {
  /** @deprecated Use derivedProvider — kept for backend compat */
  llmProvider: LLMProvider
  /** Workspace-level model roles (from settings) */
  modelRoles: ModelRoleMap
  /** Workspace-level Claude model overrides (legacy) */
  claudeModelOverrides: Record<string, string>
  /** Provider derived from routing (plan action's provider) */
  derivedProvider: LLMProvider
  /** oMLX chat-capable model names */
  omlxModels: string[]
  localModelInfo: LocalModelInfo | null
  platformInfo: PlatformInfo | null
} {
  const [llmProvider, setLlmProvider] = useState<LLMProvider>('claude')
  const [modelRoles, setModelRoles] = useState<ModelRoleMap>({})
  const [claudeModelOverrides, setClaudeModelOverrides] = useState<Record<string, string>>({})
  const [omlxModels, setOmlxModels] = useState<string[]>([])
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
        setModelRoles((s.modelRoles as ModelRoleMap) ?? {})
        setClaudeModelOverrides((s.modelOverrides as Record<string, string>) ?? {})
        const backend = (s.localLlmBackend as string) ?? 'ollama'
        setLocalModelInfo({
          backend,
          model: (s.localModel as string) ?? (s.ollamaModel as string) ?? 'unknown'
        })

        // Attempt silent oMLX model list fetch for chat creation dropdowns
        if (backend === 'omlx') {
          const host = (s.localHost as string) ?? '127.0.0.1'
          const port = (s.localPort as number) ?? 8000
          window.api.omlxCheckStatus({ baseUrl: `http://${host}:${port}`, apiKey: (s.localApiKey as string) || undefined })
            .then((status) => {
              if (!cancelled && status.running) {
                // Filter out embedding/reranker models by name heuristic
                const chatModels = status.models.filter((m: string) => !/embed|bge|rerank/i.test(m))
                setOmlxModels(chatModels)
              }
            })
            .catch(() => { /* silent — oMLX may not be running */ })
        }
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

  // Derive provider from routing — reads plan action's provider from modelRoles
  const planRole = modelRoles['specialist:plan']
  const derivedProvider: LLMProvider = planRole?.provider ?? llmProvider

  return {
    llmProvider,
    modelRoles,
    claudeModelOverrides,
    derivedProvider,
    omlxModels,
    localModelInfo,
    platformInfo
  }
}
