import { useState, useEffect, useCallback } from 'react'
import { Brain } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import type { EmbeddingModelStatus, CodeGraphIndexingState } from '../../../../shared/types'
import EmbeddingModelSetupModal from './EmbeddingModelSetupModal'
import {
  CodeGraphCard,
  SemanticSearchCard,
  EmbeddingModelCard,
  SearchPlayground
} from './code-intelligence'

export default function CodeIntelligencePage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()

  // Workspace settings
  const [settings, setSettings] = useState<Record<string, unknown>>({})

  // Embedding model status
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingModelStatus | null>(null)
  const [showEmbeddingSetup, setShowEmbeddingSetup] = useState(false)

  // Code Graph state
  const [codeGraphState, setCodeGraphState] = useState<CodeGraphIndexingState | null>(null)
  const [codeGraphJustEnabled, setCodeGraphJustEnabled] = useState(false)

  // Semantic search indexing state
  const [isStartingIndex, setIsStartingIndex] = useState(false)
  const [persistedIndexStatus, setPersistedIndexStatus] = useState<{
    loaded: boolean
    symbolCount?: number
    loading: boolean
  }>({ loaded: false, loading: false })

  // ── Load workspace data on mount ──
  useEffect(() => {
    if (!activeWorkspace) return

    // Load settings
    window.api.getWorkspaceSettings({ workspaceId: activeWorkspace.id }).then((s) => {
      setSettings(s)
      // Check embedding model status if semantic search is enabled
      if (s.semanticSearchEnabled) {
        window.api
          .embeddingCheckStatus()
          .then(setEmbeddingStatus)
          .catch((err) => console.warn('[CodeIntelligence] Non-fatal: embedding status check failed:', err))
      }
    })

    // Load code graph status
    window.api
      .codeGraphGetStatus({ workspaceId: activeWorkspace.id })
      .then(setCodeGraphState)
      .catch((err) => console.warn('[CodeIntelligence] Non-fatal: code graph status load failed:', err))

    // Auto-load persisted semantic search index
    // eslint-disable-next-line react-hooks/set-state-in-effect -- optimistic loading state before async fetch
    setPersistedIndexStatus((prev) => ({ ...prev, loading: true }))
    window.api
      .loadPersistedIndex({ workspaceId: activeWorkspace.id })
      .then((result) => {
        setPersistedIndexStatus({
          loaded: result.loaded,
          symbolCount: result.symbolCount,
          loading: false
        })
      })
      .catch(() => {
        setPersistedIndexStatus({ loaded: false, loading: false })
      })

    // Also check embedding status unconditionally for the model card
    window.api
      .embeddingCheckStatus()
      .then(setEmbeddingStatus)
      .catch((err) => console.warn('[CodeIntelligence] Non-fatal: embedding status check failed:', err))
  }, [activeWorkspace])

  // ── Subscribe to code graph progress events ──
  useEffect(() => {
    if (!activeWorkspace) return
    const unsub = window.api.onCodeGraphProgress((progress) => {
      if (progress.workspaceId === activeWorkspace.id) {
        setCodeGraphState(progress)
      }
    })
    return unsub
  }, [activeWorkspace])

  // ── Settings toggle helper ──
  const handleToggleSetting = useCallback(
    async (key: string, value: boolean): Promise<void> => {
      if (!activeWorkspace) return
      const updated = { ...settings, [key]: value }
      setSettings(updated)
      await window.api.updateWorkspaceSettings({
        workspaceId: activeWorkspace.id,
        settings: updated
      })
    },
    [activeWorkspace, settings]
  )

  // ── Code Graph toggle ──
  const handleCodeGraphToggle = useCallback(
    async (v: boolean): Promise<void> => {
      await handleToggleSetting('repomapEnabled', v)
      if (v && activeWorkspace) {
        const hasIndex = await window.api.codeGraphHasIndex({
          workspaceId: activeWorkspace.id
        })
        if (!hasIndex) {
          await window.api.codeGraphIndexStart({ workspaceId: activeWorkspace.id })
        } else {
          setCodeGraphJustEnabled(true)
          setTimeout(() => setCodeGraphJustEnabled(false), 4000)
        }
      }
    },
    [activeWorkspace, handleToggleSetting]
  )

  // ── Semantic Search toggle ──
  const handleSemanticSearchToggle = useCallback(
    async (v: boolean): Promise<void> => {
      await handleToggleSetting('semanticSearchEnabled', v)
      if (v) {
        try {
          const status = await window.api.embeddingCheckStatus()
          setEmbeddingStatus(status)
          if (!status.cached) {
            setShowEmbeddingSetup(true)
          }
        } catch {
          setShowEmbeddingSetup(true)
        }
      }
    },
    [handleToggleSetting]
  )

  // ── Start indexing ──
  const handleStartIndex = useCallback(async (): Promise<void> => {
    if (!activeWorkspace) return
    setIsStartingIndex(true)
    try {
      await window.api.indexingStart({ workspaceId: activeWorkspace.id })
    } catch (e) {
      console.error('Failed to start indexing:', e)
    }
    setIsStartingIndex(false)
  }, [activeWorkspace])

  if (!activeWorkspace) return <div />

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      {/* Page header */}
      <div className="mb-2">
        <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
          <Brain size={18} className="text-cyan-400" />
          Code Intelligence
        </h2>
        <p className="text-xs text-text-secondary mt-1">
          Configure how your workspace indexes and searches code.
        </p>
      </div>

      <CodeGraphCard
        workspaceId={activeWorkspace.id}
        enabled={!!settings.repomapEnabled}
        codeGraphState={codeGraphState}
        codeGraphJustEnabled={codeGraphJustEnabled}
        onToggle={handleCodeGraphToggle}
      />

      <SemanticSearchCard
        workspaceId={activeWorkspace.id}
        enabled={!!settings.semanticSearchEnabled}
        settings={settings}
        embeddingStatus={embeddingStatus}
        persistedIndexStatus={persistedIndexStatus}
        isStartingIndex={isStartingIndex}
        onToggle={handleSemanticSearchToggle}
        onSettingToggle={handleToggleSetting}
        onStartIndex={handleStartIndex}
        onShowEmbeddingSetup={() => setShowEmbeddingSetup(true)}
      />

      <EmbeddingModelCard
        embeddingStatus={embeddingStatus}
        onShowSetup={() => setShowEmbeddingSetup(true)}
      />

      <SearchPlayground
        workspaceId={activeWorkspace.id}
        indexLoaded={persistedIndexStatus.loaded}
      />

      {/* Embedding Model Setup Modal */}
      {showEmbeddingSetup && (
        <EmbeddingModelSetupModal
          onClose={() => {
            setShowEmbeddingSetup(false)
            // Refresh embedding status after closing modal
            window.api
              .embeddingCheckStatus()
              .then(setEmbeddingStatus)
              .catch((err) => console.warn('[CodeIntelligence] Non-fatal: embedding status refresh failed:', err))
          }}
        />
      )}
    </div>
  )
}
