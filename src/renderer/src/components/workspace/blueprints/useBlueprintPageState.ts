import { useState, useEffect, useCallback } from 'react'
import { useBlueprintStore } from '@renderer/store/blueprint.store'
import { useWorkspaceStore } from '@renderer/store/workspace.store'
import type { Blueprint, ReferenceDocument } from '../../../../../shared/blueprint-types'
import { useBlueprintFilterState } from './useBlueprintFilterState'
import { useBlueprintFormState } from './useBlueprintFormState'

// ── View States ──

export type ViewState = 'landing' | 'input' | 'active' | 'detail'

// ── Hook return type ──

export interface BlueprintPageState {
  // Workspace
  workspaceId: string

  // Store state
  isRunning: boolean
  currentPhase: string | null
  phaseStreamText: Record<string, string>
  pendingApproval: ReturnType<typeof useBlueprintStore>['pendingApproval']
  currentWave: ReturnType<typeof useBlueprintStore>['currentWave']
  waveTasks: ReturnType<typeof useBlueprintStore>['waveTasks']
  waveTaskDescriptions: ReturnType<typeof useBlueprintStore>['waveTaskDescriptions']
  history: Blueprint[]
  currentBlueprint: Blueprint | null
  pendingOnboard: ReturnType<typeof useBlueprintStore>['pendingOnboard']
  lastError: ReturnType<typeof useBlueprintStore>['lastError']
  phaseStartedAt: ReturnType<typeof useBlueprintStore>['phaseStartedAt']
  clarifyMessages: ReturnType<typeof useBlueprintStore>['clarifyMessages']
  clarifyWaitingForInput: boolean
  retryPhase: ReturnType<typeof useBlueprintStore>['retryPhase']
  sendClarifyAnswer: ReturnType<typeof useBlueprintStore>['sendClarifyAnswer']
  skipClarify: ReturnType<typeof useBlueprintStore>['skipClarify']

  // View state
  effectiveView: ViewState
  setViewState: (v: ViewState) => void

  // Input form
  title: string
  setTitle: (v: string) => void
  description: string
  setDescription: (v: string) => void
  referenceDocuments: ReferenceDocument[]
  showFileTree: boolean
  setShowFileTree: (v: boolean) => void

  // Detail view
  selectedId: string | null
  descriptionExpanded: boolean
  setDescriptionExpanded: (v: boolean) => void
  expandedPhases: Set<string>
  togglePhaseExpand: (phaseId: string) => void
  copiedArtifact: string | null
  setCopiedArtifact: (v: string | null) => void

  // Phase browsing
  selectedPhase: string | null
  setSelectedPhase: (v: string | null) => void
  displayedStreamText: string
  displayedPhase: string | null
  isViewingLivePhase: boolean

  // Filter + search
  filter: BlueprintFilter
  setFilter: (v: BlueprintFilter) => void
  searchQuery: string
  setSearchQuery: (v: string) => void
  filteredHistory: Blueprint[]
  filterCounts: Record<BlueprintFilter, number>

  // Actions
  handleAttachments: (paths: string[]) => void
  handleWorkspaceFiles: (files: ReferenceDocument[]) => void
  handleRemoveDoc: (index: number) => void
  handleStart: () => Promise<void>
  handleCancel: () => void
  handleApprove: () => void
  handleReject: (feedback: string) => void
  handleSelectBlueprint: (id: string) => void
  handleBackFromDetail: () => void
  handleRetry: (blueprint: Blueprint) => Promise<void>
  handleDelete: (blueprintId: string) => Promise<void>
  handleOnboardProceed: () => void
  handleOnboardDismiss: () => void
}

// ── Hook ──

export function useBlueprintPageState(): BlueprintPageState {
  const workspace = useWorkspaceStore((s) => s.activeWorkspace)
  const workspaceId = workspace?.id ?? ''

  const {
    isRunning,
    currentPhase,
    phaseStreamText,
    pendingApproval,
    currentWave,
    waveTasks,
    waveTaskDescriptions,
    history,
    currentBlueprint,
    pendingOnboard,
    lastError,
    phaseStartedAt,
    clarifyMessages,
    clarifyWaitingForInput,
    loadHistory,
    loadBlueprint,
    startBlueprint,
    cancelBlueprint,
    respondToApproval,
    retryPhase,
    clearPendingOnboard,
    sendClarifyAnswer,
    skipClarify
  } = useBlueprintStore()

  // ── Local state ──
  const [viewState, setViewState] = useState<ViewState>('landing')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set())
  const [copiedArtifact, setCopiedArtifact] = useState<string | null>(null)
  const [selectedPhase, setSelectedPhase] = useState<string | null>(null)

  // ── Filter + search (extracted hook) ──
  const {
    filter, setFilter, searchQuery, setSearchQuery,
    filteredHistory, filterCounts, resetFilters
  } = useBlueprintFilterState(history)

  // ── Form state (extracted hook) ──
  const {
    title, setTitle, description, setDescription,
    referenceDocuments, showFileTree, setShowFileTree,
    handleAttachments, handleWorkspaceFiles, handleRemoveDoc,
    resetForm, prefillForm
  } = useBlueprintFormState()

  // ── Effects ──

  // Load history on workspace change
  useEffect(() => {
    if (workspaceId) {
      loadHistory(workspaceId)
    }
    /* eslint-disable react-hooks/set-state-in-effect -- intentional reset on workspace identity change */
    setSelectedId(null)
    setViewState('landing')
    resetFilters()
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [workspaceId, loadHistory])

  // Escape key to go back from detail view
  const effectiveView: ViewState = isRunning
    ? 'active'
    : pendingApproval
      ? 'active'
      : selectedId
        ? 'detail'
        : viewState

  const handleBackFromDetail = useCallback(() => {
    setSelectedId(null)
    setViewState('landing')
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && effectiveView === 'detail') {
        handleBackFromDetail()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [effectiveView, handleBackFromDetail])

  // Reset selectedPhase when currentPhase changes (follow the active phase)
  useEffect(() => {
    if (currentPhase) {
      setSelectedPhase(currentPhase)
    }
  }, [currentPhase])

  // ── Derived values ──

  const currentPhaseStream = currentPhase ? (phaseStreamText[currentPhase] ?? '') : ''
  const displayedStreamText = selectedPhase
    ? (phaseStreamText[selectedPhase] ?? '')
    : currentPhaseStream
  const displayedPhase = selectedPhase ?? currentPhase
  const isViewingLivePhase = displayedPhase === currentPhase

  // ── Callbacks ──

  const togglePhaseExpand = useCallback((phaseId: string) => {
    setExpandedPhases((prev) => {
      const next = new Set(prev)
      if (next.has(phaseId)) {
        next.delete(phaseId)
      } else {
        next.add(phaseId)
      }
      return next
    })
  }, [])

  const handleStart = useCallback(async () => {
    if (!title.trim() || !workspaceId) return
    try {
      await startBlueprint({
        workspaceId,
        title: title.trim(),
        description: description.trim() || undefined,
        settingsJson: referenceDocuments.length > 0 ? { referenceDocuments } : undefined
      })
      resetForm()
    } catch {
      // Error already logged in store
    }
  }, [title, description, referenceDocuments, workspaceId, startBlueprint, resetForm])

  const handleCancel = useCallback(() => {
    if (workspaceId) {
      cancelBlueprint(workspaceId)
    }
  }, [workspaceId, cancelBlueprint])

  const handleApprove = useCallback(() => {
    if (pendingApproval) {
      respondToApproval(pendingApproval.blueprintId, true)
    }
  }, [pendingApproval, respondToApproval])

  const handleReject = useCallback(
    (feedback: string) => {
      if (pendingApproval) {
        respondToApproval(pendingApproval.blueprintId, false, feedback)
      }
    },
    [pendingApproval, respondToApproval]
  )

  const handleSelectBlueprint = useCallback(
    (id: string) => {
      setSelectedId(id)
      setViewState('detail')
      setDescriptionExpanded(false)
      loadBlueprint(id)
    },
    [loadBlueprint]
  )

  const handleRetry = useCallback(
    async (blueprint: Blueprint) => {
      if (!workspaceId) return
      await retryPhase(blueprint.id, workspaceId)
    },
    [workspaceId, retryPhase]
  )

  const handleDelete = useCallback(
    async (blueprintId: string) => {
      const prev = useBlueprintStore.getState().history
      useBlueprintStore.setState({
        history: prev.filter((bp) => bp.id !== blueprintId)
      })
      try {
        await window.api.blueprintDelete({ id: blueprintId })
      } catch {
        if (workspaceId) {
          loadHistory(workspaceId)
        }
      }
    },
    [workspaceId, loadHistory]
  )

  const handleOnboardProceed = useCallback(() => {
    if (pendingOnboard) {
      prefillForm(pendingOnboard.title, pendingOnboard.description, pendingOnboard.referenceDocuments)
    }
    setViewState('input')
    clearPendingOnboard()
  }, [pendingOnboard, clearPendingOnboard, prefillForm])

  const handleOnboardDismiss = useCallback(() => {
    clearPendingOnboard()
  }, [clearPendingOnboard])

  return {
    workspaceId,
    isRunning,
    currentPhase,
    phaseStreamText,
    pendingApproval,
    currentWave,
    waveTasks,
    waveTaskDescriptions,
    history,
    currentBlueprint,
    pendingOnboard,
    lastError,
    phaseStartedAt,
    clarifyMessages,
    clarifyWaitingForInput,
    retryPhase,
    sendClarifyAnswer,
    skipClarify,
    effectiveView,
    setViewState,
    title,
    setTitle,
    description,
    setDescription,
    referenceDocuments,
    showFileTree,
    setShowFileTree,
    selectedId,
    descriptionExpanded,
    setDescriptionExpanded,
    expandedPhases,
    togglePhaseExpand,
    copiedArtifact,
    setCopiedArtifact,
    selectedPhase,
    setSelectedPhase,
    displayedStreamText,
    displayedPhase,
    isViewingLivePhase,
    filter,
    setFilter,
    searchQuery,
    setSearchQuery,
    filteredHistory,
    filterCounts,
    handleAttachments,
    handleWorkspaceFiles,
    handleRemoveDoc,
    handleStart,
    handleCancel,
    handleApprove,
    handleReject,
    handleSelectBlueprint,
    handleBackFromDetail,
    handleRetry,
    handleDelete,
    handleOnboardProceed,
    handleOnboardDismiss
  }
}
