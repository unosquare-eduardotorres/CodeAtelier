// @ts-nocheck — TODO: fix after blueprint refactoring
/**
 * Custom hook encapsulating HealthPage state management, effects, and computed values.
 * Extracted from HealthPage to reduce component cyclomatic complexity.
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { useAuditStore } from '@renderer/store'
import { AUDIT_TRACKS } from '../../../../../shared/constants'
import type {
  AuditMode,
  AuditTrackId,
  AuditFinding,
  AuditRun,
  AuditSelectedSkills,
  LLMProvider
} from '../../../../../shared/types'
import { useHealthPlanActions } from './useHealthPlanActions'
import { useAuditViewNavigation } from './useAuditViewNavigation'
import { useAuditActionCallbacks } from './useAuditActionCallbacks'

export type HealthView = 'landing' | 'configure' | 'active' | 'plan'

const ALL_TRACK_IDS = Object.keys(AUDIT_TRACKS) as AuditTrackId[]

interface HealthPageCallbacks {
  onFixInNewChat: () => void
  onSendPlanToGrill?: (title: string, description: string) => void
  onNavigateToCouncil?: () => void
  onNavigateToGoals?: () => void
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useHealthPageState(workspaceId: string | undefined, callbacks: HealthPageCallbacks) {
  const {
    currentRun, isRunning, isPaused, rerunningTrackId, selectedFindings,
    loadLatest, openRun, startAudit, cancelAudit, pauseAudit, resumeAudit,
    rerunTrack, toggleFinding, clearSelectedFindings, setPendingFixContext,
    reset,
    handleProgress, handleResult, handleComplete, handleStreamChunk, handleIntermediate
  } = useAuditStore()

  const [mode, setMode] = useState<AuditMode>('light')
  const [selectedTracks, setSelectedTracks] = useState<Set<AuditTrackId>>(new Set(ALL_TRACK_IDS))
  const [activeTrackId, setActiveTrackId] = useState<AuditTrackId | null>(null)
  const [view, setView] = useState<HealthView>('landing')
  const followLiveRef = useRef(true)

  // ── Effects ──

  useEffect(() => {
    if (workspaceId) loadLatest(workspaceId)
  }, [workspaceId, loadLatest])

  useEffect(() => {
    const cleanupProgress = window.api.onAuditProgress(handleProgress)
    const cleanupResult = window.api.onAuditResult(handleResult)
    const cleanupComplete = window.api.onAuditComplete(handleComplete)
    const cleanupStream = window.api.onAuditStreamChunk(handleStreamChunk)
    const cleanupIntermediate = window.api.onAuditIntermediate(handleIntermediate)
    return () => {
      cleanupProgress(); cleanupResult(); cleanupComplete()
      cleanupStream(); cleanupIntermediate()
    }
  }, [handleProgress, handleResult, handleComplete, handleStreamChunk, handleIntermediate])

  useEffect(() => {
    if (!isRunning && !rerunningTrackId) return
    if (!followLiveRef.current) return
    const runningTrack = currentRun?.results.find((r) => r.status === 'running')
    if (runningTrack) setActiveTrackId(runningTrack.trackId)
  }, [currentRun?.results, isRunning, rerunningTrackId])

  const prevStatusRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const status = currentRun?.status
    if (prevStatusRef.current === 'running' && status && status !== 'running') {
      setActiveTrackId(null)
    }
    prevStatusRef.current = status
  }, [currentRun?.status])

  useEffect(() => {
    if (isRunning || rerunningTrackId) setView('active')
  }, [isRunning, rerunningTrackId])

  // ── Track selection callbacks ──

  const allSelected = selectedTracks.size === ALL_TRACK_IDS.length

  const handleToggleAll = useCallback(() => {
    setSelectedTracks(allSelected ? new Set() : new Set(ALL_TRACK_IDS))
  }, [allSelected])

  const handleToggleTrack = useCallback((trackId: AuditTrackId) => {
    setSelectedTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [])

  const handleSelectTrack = useCallback((id: AuditTrackId | null) => {
    followLiveRef.current = false
    setActiveTrackId(id)
  }, [])

  // ── View navigation callbacks (extracted hook) ──

  const {
    handleStart, handleConfigureRun, handleNewAudit,
    handleOpenRun, handleRerunRun, handleBackToHistory
  } = useAuditViewNavigation({
    workspaceId,
    setView,
    setMode,
    setSelectedTracks,
    setActiveTrackId,
    followLiveRef,
    allTrackIds: ALL_TRACK_IDS,
    startAudit,
    openRun,
    reset
  })

  // ── Action callbacks (extracted hook) ──

  const {
    handleConvert, handleRerunTrack, handleExport,
    handleExportPlan, handleAutoFix, handleResume
  } = useAuditActionCallbacks({
    workspaceId,
    mode,
    selectedFindings,
    currentRunMode: currentRun?.mode,
    setPendingFixContext,
    clearSelectedFindings,
    rerunTrack,
    resumeAudit,
    onFixInNewChat: callbacks.onFixInNewChat
  })

  // ── Plan actions (extracted hook) ──

  const {
    currentPlan, planDoc, planTitle,
    handleBuildPlan, handleSendPlanToChat, handleSendPlanToCouncil,
    handleSendPlanToGoals, handleSendPlanToGrill, handleBackToResults
  } = useHealthPlanActions(workspaceId, callbacks, setView)

  // ── Computed values ──

  const completedCount = currentRun?.results.filter((r) => r.status === 'completed').length ?? 0
  const totalCount = currentRun?.selectedTracks.length ?? 0
  const percentage = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
  const hasRunningTrack = currentRun?.results.some((r) => r.status === 'running') ?? false
  const effectivelyRunning = isRunning || !!rerunningTrackId || hasRunningTrack
  const incompleteTrackCount = currentRun?.results.filter(
    (r) => r.status === 'cancelled' || r.status === 'pending' || r.status === 'failed'
  ).length ?? 0
  const canResume = !effectivelyRunning && currentRun != null &&
    (currentRun.status === 'partial' || currentRun.status === 'cancelled') && incompleteTrackCount > 0
  const selectedIds = new Set(selectedFindings.map((f) => f.id))
  const auditorCount = currentRun?.results.filter((r) => r.findings.some((f) => selectedIds.has(f.id))).length ?? 0
  const showTray = !effectivelyRunning && selectedFindings.length > 0

  return {
    // State
    mode, setMode, selectedTracks, activeTrackId, view,
    // Store values
    currentRun, isRunning, isPaused, rerunningTrackId,
    selectedFindings, currentPlan,
    // Track callbacks
    allSelected, handleToggleAll, handleToggleTrack, handleSelectTrack,
    // View callbacks
    handleStart, handleConfigureRun, handleNewAudit, handleOpenRun,
    handleRerunRun, handleBackToHistory,
    // Action callbacks
    handleConvert, handleRerunTrack, handleExport, handleExportPlan,
    handleAutoFix, handleResume,
    // Plan callbacks
    handleBuildPlan, handleSendPlanToChat, handleSendPlanToCouncil,
    handleSendPlanToGoals, handleSendPlanToGrill, handleBackToResults,
    // Store actions (passthrough)
    cancelAudit, pauseAudit, toggleFinding, clearSelectedFindings,
    // Computed
    effectivelyRunning, completedCount, totalCount, percentage,
    canResume, incompleteTrackCount, showTray, auditorCount, planDoc, planTitle
  }
}
