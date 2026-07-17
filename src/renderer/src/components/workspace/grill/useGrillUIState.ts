import { useState, useCallback, useEffect } from 'react'
import { useWorkspaceStore } from '@renderer/store'
import type { LLMProvider } from '../../../../../shared/types'

interface GrillUIStateResult {
  activeTab: 'chat' | 'decisions'
  condensedDocument: string | undefined
  isCondensing: boolean
  grillProvider: LLMProvider
  setActiveTab: (tab: 'chat' | 'decisions') => void
  setGrillProvider: (provider: LLMProvider) => void
  handleCondense: () => Promise<void>
}

export function useGrillUIState(requirementDocument: string): GrillUIStateResult {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)

  const [activeTab, setActiveTab] = useState<'chat' | 'decisions'>('chat')
  const [condensedDocument, setCondensedDocument] = useState<string | undefined>()
  const [isCondensing, setIsCondensing] = useState(false)
  const [grillProvider, setGrillProvider] = useState<LLMProvider>('claude')

  // Load workspace provider setting
  useEffect(() => {
    if (!activeWorkspace?.id) return
    window.api
      .getWorkspaceSettings({ workspaceId: activeWorkspace.id })
      .then((settings) => {
        setGrillProvider((settings.llmProvider as LLMProvider) ?? 'claude')
      })
      .catch((err) =>
        console.warn('[useGrillSession] Non-fatal: workspace settings load failed:', err)
      )
  }, [activeWorkspace?.id])

  const handleCondense = useCallback(async () => {
    if (isCondensing || !requirementDocument) return
    setIsCondensing(true)
    try {
      const { condensed } = await window.api.grillCondenseRequirement({
        text: requirementDocument,
        workspaceId: activeWorkspace?.id
      })
      setCondensedDocument(condensed)
    } catch (error) {
      console.error('Failed to condense requirement:', error)
    } finally {
      setIsCondensing(false)
    }
  }, [requirementDocument, isCondensing, activeWorkspace?.id])

  return {
    activeTab,
    condensedDocument,
    isCondensing,
    grillProvider,
    setActiveTab,
    setGrillProvider,
    handleCondense
  }
}
