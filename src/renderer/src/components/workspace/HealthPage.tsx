import { useEffect, useState, useRef } from 'react'
import { ShieldCheck, Loader2, ChevronLeft } from 'lucide-react'
import { useWorkspaceStore, useAuditStore } from '@renderer/store'
import { AUDIT_TRACKS } from '../../../../shared/constants'
import type { AuditMode, AuditTrackId } from '../../../../shared/types'
import HealthAuditControls from './HealthAuditControls'
import HealthTrackSidebar from './HealthTrackSidebar'
import HealthDetailPanel from './HealthDetailPanel'
import ScoreGauge from './ScoreGauge'
import HealthLanding from './health/HealthLanding'
import HealthConfigure from './health/HealthConfigure'
import HealthPlanStep from './health/HealthPlanStep'
import SelectionTrayBar from './health/SelectionTrayBar'
import { useHealthPageActions, useAuditRunStatus } from './useHealthPageHooks'

type HealthView = 'landing' | 'configure' | 'active' | 'plan'

interface HealthPageProps {
  onNavigateToChat: () => void
  onFixInNewChat: () => void
  /** Route a generated plan into a fresh Grill session (creates an idea). */
  onSendPlanToGrill?: (title: string, description: string) => void
  /** Switch to the Council tab. */
  onNavigateToCouncil?: () => void
  /** Switch to the Goals tab. */
  onNavigateToGoals?: () => void
}

export default function HealthPage({
  onNavigateToChat: _onNavigateToChat,
  onFixInNewChat,
  onSendPlanToGrill,
  onNavigateToCouncil,
  onNavigateToGoals
}: HealthPageProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const {
    currentRun,
    isRunning,
    isPaused,
    rerunningTrackId,
    selectedFindings,
    loadLatest,
    cancelAudit,
    pauseAudit,
    toggleFinding,
    clearSelectedFindings,
    handleProgress,
    handleResult,
    handleComplete,
    handleStreamChunk,
    handleIntermediate
  } = useAuditStore()

  const [mode, setMode] = useState<AuditMode>('light')
  const [selectedTracks, setSelectedTracks] = useState<Set<AuditTrackId>>(
    new Set(Object.keys(AUDIT_TRACKS) as AuditTrackId[])
  )
  const [activeTrackId, setActiveTrackId] = useState<AuditTrackId | null>(null)
  const [view, setView] = useState<HealthView>('landing')
  const followLiveRef = useRef(true)

  const workspaceId = activeWorkspace?.id

  // ── Extracted hooks ──
  const actions = useHealthPageActions({
    workspaceId,
    mode,
    setMode,
    selectedTracks,
    setSelectedTracks,
    setActiveTrackId,
    setView,
    followLiveRef,
    onFixInNewChat,
    onSendPlanToGrill,
    onNavigateToCouncil,
    onNavigateToGoals
  })

  const {
    completedCount,
    totalCount,
    percentage,
    effectivelyRunning,
    canResume,
    incompleteTrackCount,
    showTray,
    auditorCount
  } = useAuditRunStatus(currentRun, isRunning, rerunningTrackId, selectedFindings)

  // Load latest on mount
  useEffect(() => {
    if (workspaceId) {
      loadLatest(workspaceId)
    }
  }, [workspaceId, loadLatest])

  // Wire IPC event listeners
  useEffect(() => {
    const cleanupProgress = window.api.onAuditProgress(handleProgress)
    const cleanupResult = window.api.onAuditResult(handleResult)
    const cleanupComplete = window.api.onAuditComplete(handleComplete)
    const cleanupStream = window.api.onAuditStreamChunk(handleStreamChunk)
    const cleanupIntermediate = window.api.onAuditIntermediate(handleIntermediate)

    return () => {
      cleanupProgress()
      cleanupResult()
      cleanupComplete()
      cleanupStream()
      cleanupIntermediate()
    }
  }, [handleProgress, handleResult, handleComplete, handleStreamChunk, handleIntermediate])

  // Auto-select the running track so detail panel shows live stream
  useEffect(() => {
    if (!isRunning && !rerunningTrackId) return
    if (!followLiveRef.current) return
    const runningTrack = currentRun?.results.find((r) => r.status === 'running')
    if (runningTrack) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional auto-follow
      setActiveTrackId(runningTrack.trackId)
    }
  }, [currentRun?.results, isRunning, rerunningTrackId])

  // When a run transitions from running to a terminal state, clear auto-follow.
  const prevStatusRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const status = currentRun?.status
    if (prevStatusRef.current === 'running' && status && status !== 'running') {
      setActiveTrackId(null)
    }
    prevStatusRef.current = status
  }, [currentRun?.status])

  // When an audit is actively running, always show the active view.
  useEffect(() => {
    if (isRunning || rerunningTrackId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- follow live run
      setView('active')
    }
  }, [isRunning, rerunningTrackId])

  const allSelected = selectedTracks.size === (Object.keys(AUDIT_TRACKS) as AuditTrackId[]).length

  // ── Plan view ──
  if (view === 'plan') {
    return (
      <HealthPlanStep
        onBack={actions.handleBackToResults}
        onSendToChat={actions.handleSendPlanToChat}
        onSendToGrill={actions.handleSendPlanToGrill}
        onSendToGoals={actions.handleSendPlanToGoals}
        onSendToCouncil={actions.handleSendPlanToCouncil}
        onExport={actions.handleExportPlan}
      />
    )
  }

  // ── Landing view (history / empty state) ──
  if (view === 'landing') {
    return (
      <div data-testid="health-page" className="flex flex-col h-full">
        <HealthLanding
          onNewAudit={actions.handleNewAudit}
          onOpenRun={actions.handleOpenRun}
          onRerunRun={actions.handleRerunRun}
        />
      </div>
    )
  }

  // ── Configure view ──
  if (view === 'configure') {
    return (
      <HealthConfigure
        initialMode={mode}
        initialTracks={[...selectedTracks]}
        onRun={actions.handleConfigureRun}
        onBack={actions.handleBackToHistory}
      />
    )
  }

  // Show a loading spinner while the audit is starting and currentRun hasn't arrived yet
  if (effectivelyRunning && !currentRun) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <Loader2 size={32} className="text-primary-text animate-spin" />
        <span className="text-sm text-text-secondary">Starting audit…</span>
      </div>
    )
  }

  return (
    <div data-testid="health-page" className="flex flex-col h-full">
      {/* ── Header bar ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle bg-surface-raised">
        {/* Left: back to history + title */}
        <div className="flex items-center gap-2">
          <button
            onClick={actions.handleBackToHistory}
            disabled={effectivelyRunning}
            className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Back to audit history"
          >
            <ChevronLeft size={16} />
          </button>
          <ShieldCheck size={16} className="text-success" />
          <h2 className="text-sm font-bold text-text-primary">Workspace Health</h2>
        </div>

        {/* Center: overall score (compact, only when run exists) */}
        {currentRun?.overallScore != null && (
          <div className="flex items-center gap-2">
            <ScoreGauge score={currentRun.overallScore} size={36} />
            <span className="text-xs text-text-secondary">
              {completedCount}/{totalCount} auditors
            </span>
          </div>
        )}

        {/* Right: controls (mode toggle + run/cancel) */}
        <HealthAuditControls
          mode={mode}
          onModeChange={setMode}
          onStart={actions.handleStart}
          onCancel={cancelAudit}
          onPause={pauseAudit}
          onResume={canResume || isPaused ? actions.handleResume : undefined}
          isRunning={effectivelyRunning}
          isPaused={isPaused}
          hasSelectedTracks={selectedTracks.size > 0}
          incompleteTrackCount={canResume ? incompleteTrackCount : 0}
        />
      </div>

      {/* ── Body: sidebar + detail ── */}
      <div className="flex flex-1 min-h-0">
        <HealthTrackSidebar
          selectedTracks={selectedTracks}
          onToggleTrack={actions.handleToggleTrack}
          activeTrackId={activeTrackId}
          onSelectTrack={actions.handleSelectTrack}
          results={currentRun?.results ?? []}
          isRunning={effectivelyRunning}
          allSelected={allSelected}
          onToggleAll={actions.handleToggleAll}
          hasResults={currentRun?.results.some((r) => r.status === 'completed') ?? false}
          onShowOverview={() => actions.handleSelectTrack(null)}
        />
        <HealthDetailPanel
          activeTrackId={activeTrackId}
          currentRun={currentRun}
          mode={mode}
          rerunningTrackId={rerunningTrackId}
          selectedFindings={selectedFindings}
          onToggleFinding={toggleFinding}
          onSelectTrack={actions.handleSelectTrack}
          onConvertToChat={actions.handleConvert}
          onRerunTrack={actions.handleRerunTrack}
          onAutoFix={actions.handleAutoFix}
          onClearSelected={clearSelectedFindings}
          onExport={actions.handleExport}
        />
      </div>

      {/* ── Progress bar (during execution only) ── */}
      {effectivelyRunning && currentRun && (
        <div className="px-4 py-2 border-t border-border-subtle bg-surface-raised">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-surface-overlay rounded-full overflow-hidden">
              <div
                className="h-full bg-success rounded-full transition-all duration-500"
                style={{ width: `${percentage}%` }}
              />
            </div>
            <span className="text-[11px] text-text-secondary">
              {completedCount}/{totalCount} ({percentage}%)
            </span>
          </div>
        </div>
      )}

      {/* ── Selection tray (findings selected, not running) ── */}
      {showTray && (
        <SelectionTrayBar
          count={selectedFindings.length}
          auditorCount={auditorCount}
          isGenerating={false}
          onBuildPlan={actions.handleBuildPlan}
          onClear={clearSelectedFindings}
        />
      )}
    </div>
  )
}
