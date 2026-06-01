import { useEffect, useState, useCallback, useRef } from 'react'
import { ShieldCheck, Loader2, ChevronLeft } from 'lucide-react'
import { useWorkspaceStore, useAuditStore, useMpaStore } from '@renderer/store'
import { useCouncilStore } from '@renderer/store/council.store'
import { AUDIT_TRACKS } from '../../../../shared/constants'
import type {
  AuditMode,
  AuditTrackId,
  AuditFinding,
  AuditRun,
  AuditSelectedSkills,
  LLMProvider
} from '../../../../shared/types'
import HealthAuditControls from './HealthAuditControls'
import HealthTrackSidebar from './HealthTrackSidebar'
import HealthDetailPanel from './HealthDetailPanel'
import ScoreGauge from './ScoreGauge'
import HealthLanding from './health/HealthLanding'
import HealthConfigure from './health/HealthConfigure'
import HealthPlanStep from './health/HealthPlanStep'
import SelectionTrayBar from './health/SelectionTrayBar'

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

const ALL_TRACK_IDS = Object.keys(AUDIT_TRACKS) as AuditTrackId[]

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
    openRun,
    startAudit,
    cancelAudit,
    pauseAudit,
    resumeAudit,
    rerunTrack,
    toggleFinding,
    clearSelectedFindings,
    setPendingFixContext,
    generatePlan,
    currentPlan,
    clearPlan,
    reset,
    handleProgress,
    handleResult,
    handleComplete,
    handleStreamChunk,
    handleIntermediate
  } = useAuditStore()

  const [mode, setMode] = useState<AuditMode>('light')
  const [selectedTracks, setSelectedTracks] = useState<Set<AuditTrackId>>(new Set(ALL_TRACK_IDS))
  const [activeTrackId, setActiveTrackId] = useState<AuditTrackId | null>(null)
  const [view, setView] = useState<HealthView>('landing')

  // Follow the live running track only until the user manually navigates.
  // Reset to true whenever a fresh run starts.
  const followLiveRef = useRef(true)

  const workspaceId = activeWorkspace?.id

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

  // Auto-select the running track so detail panel shows live stream — but only
  // while the user hasn't manually navigated away (followLiveRef).
  useEffect(() => {
    if (!isRunning && !rerunningTrackId) return
    if (!followLiveRef.current) return // respect manual navigation
    const runningTrack = currentRun?.results.find((r) => r.status === 'running')
    if (runningTrack) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional auto-follow
      setActiveTrackId(runningTrack.trackId)
    }
  }, [currentRun?.results, isRunning, rerunningTrackId])

  // When a run transitions from running to a terminal state, drop back to the
  // Overview dashboard (clear the auto-followed track selection).
  const prevStatusRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const status = currentRun?.status
    if (prevStatusRef.current === 'running' && status && status !== 'running') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot on completion
      setActiveTrackId(null)
    }
    prevStatusRef.current = status
  }, [currentRun?.status])

  // When an audit is actively running, always show the active view (e.g. after
  // navigating back to the page mid-run).
  useEffect(() => {
    if (isRunning || rerunningTrackId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- follow live run
      setView('active')
    }
  }, [isRunning, rerunningTrackId])

  const allSelected = selectedTracks.size === ALL_TRACK_IDS.length

  const handleToggleAll = useCallback(() => {
    if (allSelected) {
      setSelectedTracks(new Set())
    } else {
      setSelectedTracks(new Set(ALL_TRACK_IDS))
    }
  }, [allSelected])

  const handleToggleTrack = useCallback((trackId: AuditTrackId) => {
    setSelectedTracks((prev) => {
      const next = new Set(prev)
      if (next.has(trackId)) {
        next.delete(trackId)
      } else {
        next.add(trackId)
      }
      return next
    })
  }, [])

  // Manual track/overview selection — disables live-follow so the chosen panel
  // stays put even as the running auditor keeps streaming.
  const handleSelectTrack = useCallback((id: AuditTrackId | null) => {
    followLiveRef.current = false
    setActiveTrackId(id)
  }, [])

  // Header "Start" now routes to the dedicated Configure screen.
  const handleStart = useCallback(() => {
    setView('configure')
  }, [])

  const handleConfigureRun = useCallback(
    async (config: {
      mode: AuditMode
      tracks: AuditTrackId[]
      provider: LLMProvider
      selectedSkills: AuditSelectedSkills
    }) => {
      if (!workspaceId) return
      followLiveRef.current = true
      setMode(config.mode)
      setSelectedTracks(new Set(config.tracks))
      setActiveTrackId(null)
      setView('active')
      await startAudit(
        workspaceId,
        config.mode,
        config.tracks,
        config.provider,
        config.selectedSkills
      )
    },
    [workspaceId, startAudit]
  )

  const handleConvert = useCallback(() => {
    const findings = [...selectedFindings]
    const findingsContext = findings
      .map(
        (f, i) =>
          `### ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}\n${f.description}` +
          (f.filePath ? `\n**File:** \`${f.filePath}\`` : '') +
          (f.recommendation ? `\n**Recommendation:** ${f.recommendation}` : '')
      )
      .join('\n\n')

    setPendingFixContext({
      title: `🔧 Fix ${findings.length} audit finding${findings.length > 1 ? 's' : ''}`,
      description: `The following audit findings need to be addressed:\n\n${findingsContext}\n\nPlease analyze these findings and propose a plan to fix them.`
    })
    clearSelectedFindings()
    onFixInNewChat()
  }, [selectedFindings, setPendingFixContext, clearSelectedFindings, onFixInNewChat])

  const handleRerunTrack = useCallback(
    async (trackId: AuditTrackId) => {
      if (!workspaceId) return
      await rerunTrack(workspaceId, trackId, currentRun?.mode ?? mode)
    },
    [workspaceId, rerunTrack, currentRun?.mode, mode]
  )

  const handleExport = useCallback(async () => {
    if (!workspaceId) return
    try {
      await window.api.auditExportMarkdown({ workspaceId })
    } catch {
      // Non-critical — user may have cancelled the save dialog
    }
  }, [workspaceId])

  const handleAutoFix = useCallback(
    (finding: AuditFinding, trackName: string) => {
      const description =
        `Please analyze this ${trackName} finding and suggest a specific fix:\n\n` +
        `**[${finding.severity.toUpperCase()}] ${finding.title}**\n` +
        `${finding.description}\n` +
        (finding.filePath ? `File: \`${finding.filePath}\`\n` : '') +
        (finding.recommendation ? `Recommendation: ${finding.recommendation}\n` : '') +
        `\nProvide the exact code changes needed to fix this issue.`

      setPendingFixContext({
        title: `🔧 Fix: ${finding.title}`,
        description
      })
      onFixInNewChat()
    },
    [setPendingFixContext, onFixInNewChat]
  )

  const handleResume = useCallback(async () => {
    if (!workspaceId) return
    try {
      await resumeAudit(workspaceId)
    } catch {
      // error already logged in store
    }
  }, [workspaceId, resumeAudit])

  // ── View-state transitions (landing ↔ active) ──
  const handleNewAudit = useCallback(() => {
    reset()
    followLiveRef.current = true
    setActiveTrackId(null)
    setSelectedTracks(new Set(ALL_TRACK_IDS))
    setMode('light')
    setView('configure')
  }, [reset])

  const handleOpenRun = useCallback(
    (run: AuditRun) => {
      openRun(run)
      setMode(run.mode)
      setSelectedTracks(new Set(run.selectedTracks))
      setActiveTrackId(null)
      setView('active')
    },
    [openRun]
  )

  const handleRerunRun = useCallback(
    async (run: AuditRun) => {
      if (!workspaceId) return
      followLiveRef.current = true
      setMode(run.mode)
      setSelectedTracks(new Set(run.selectedTracks))
      setActiveTrackId(null)
      setView('active')
      await startAudit(workspaceId, run.mode, run.selectedTracks, undefined)
    },
    [workspaceId, startAudit]
  )

  const handleBackToHistory = useCallback(() => {
    setActiveTrackId(null)
    setView('landing')
  }, [])

  // ── Plan generation + routing ──
  const handleBuildPlan = useCallback(() => {
    if (!workspaceId) return
    setView('plan')
    generatePlan(workspaceId).catch(() => {
      // error logged in store; surface by returning to results
      setView('active')
    })
  }, [workspaceId, generatePlan])

  const planDoc = currentPlan?.plan.requirementDocument ?? currentPlan?.plan.summary ?? ''
  const planTitle = currentPlan?.plan.title ?? 'Audit Remediation Plan'

  const handleSendPlanToChat = useCallback(() => {
    if (!currentPlan) return
    setPendingFixContext({ title: `🔧 ${planTitle}`, description: planDoc })
    clearSelectedFindings()
    onFixInNewChat()
  }, [currentPlan, planTitle, planDoc, setPendingFixContext, clearSelectedFindings, onFixInNewChat])

  const handleSendPlanToCouncil = useCallback(() => {
    if (!workspaceId || !currentPlan) return
    const councilStore = useCouncilStore.getState()
    councilStore.startCouncil()
    window.api
      .councilStart({
        workspaceId,
        inputType: 'plan',
        planContent: planDoc,
        originalUserRequest: planTitle,
        conversationId: undefined
      })
      .then(({ sessionId }) => councilStore.setSessionIdentity(sessionId, workspaceId))
      .catch(() => councilStore.reset())
    onNavigateToCouncil?.()
  }, [workspaceId, currentPlan, planDoc, planTitle, onNavigateToCouncil])

  const handleSendPlanToGoals = useCallback(() => {
    if (!currentPlan) return
    useMpaStore.getState().setPreloadedGoal({ text: `${planTitle}\n\n${planDoc}` })
    onNavigateToGoals?.()
  }, [currentPlan, planTitle, planDoc, onNavigateToGoals])

  const handleSendPlanToGrill = useCallback(() => {
    if (!currentPlan) return
    onSendPlanToGrill?.(planTitle, planDoc)
  }, [currentPlan, planTitle, planDoc, onSendPlanToGrill])

  const handleBackToResults = useCallback(() => {
    clearPlan()
    setView('active')
  }, [clearPlan])

  // Compute counts
  const completedCount = currentRun?.results.filter((r) => r.status === 'completed').length ?? 0
  const totalCount = currentRun?.selectedTracks.length ?? 0
  const percentage = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
  const hasRunningTrack = currentRun?.results.some((r) => r.status === 'running') ?? false
  const effectivelyRunning = isRunning || !!rerunningTrackId || hasRunningTrack

  // Count incomplete tracks for resume button
  const incompleteTrackCount =
    currentRun?.results.filter(
      (r) => r.status === 'cancelled' || r.status === 'pending' || r.status === 'failed'
    ).length ?? 0
  const canResume =
    !effectivelyRunning &&
    currentRun != null &&
    (currentRun.status === 'partial' || currentRun.status === 'cancelled') &&
    incompleteTrackCount > 0

  // Selection tray counts — map selected findings back to their auditors.
  const selectedIds = new Set(selectedFindings.map((f) => f.id))
  const auditorCount =
    currentRun?.results.filter((r) => r.findings.some((f) => selectedIds.has(f.id))).length ?? 0
  const showTray = !effectivelyRunning && selectedFindings.length > 0

  // ── Plan view ──
  if (view === 'plan') {
    return (
      <HealthPlanStep
        onBack={handleBackToResults}
        onSendToChat={handleSendPlanToChat}
        onSendToGrill={handleSendPlanToGrill}
        onSendToGoals={handleSendPlanToGoals}
        onSendToCouncil={handleSendPlanToCouncil}
        onExport={handleExport}
      />
    )
  }

  // ── Landing view (history / empty state) ──
  if (view === 'landing') {
    return (
      <div className="flex flex-col h-full">
        <HealthLanding
          onNewAudit={handleNewAudit}
          onOpenRun={handleOpenRun}
          onRerunRun={handleRerunRun}
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
        onRun={handleConfigureRun}
        onBack={handleBackToHistory}
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
    <div className="flex flex-col h-full">
      {/* ── Header bar ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle bg-surface-raised">
        {/* Left: back to history + title */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleBackToHistory}
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
          onStart={handleStart}
          onCancel={cancelAudit}
          onPause={pauseAudit}
          onResume={canResume || isPaused ? handleResume : undefined}
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
          onToggleTrack={handleToggleTrack}
          activeTrackId={activeTrackId}
          onSelectTrack={handleSelectTrack}
          results={currentRun?.results ?? []}
          isRunning={effectivelyRunning}
          allSelected={allSelected}
          onToggleAll={handleToggleAll}
          hasResults={(currentRun?.results.some((r) => r.status === 'completed')) ?? false}
          onShowOverview={() => handleSelectTrack(null)}
        />
        <HealthDetailPanel
          activeTrackId={activeTrackId}
          currentRun={currentRun}
          mode={mode}
          rerunningTrackId={rerunningTrackId}
          selectedFindings={selectedFindings}
          onToggleFinding={toggleFinding}
          onSelectTrack={handleSelectTrack}
          onConvertToChat={handleConvert}
          onRerunTrack={handleRerunTrack}
          onAutoFix={handleAutoFix}
          onClearSelected={clearSelectedFindings}
          onExport={handleExport}
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
          onBuildPlan={handleBuildPlan}
          onClear={clearSelectedFindings}
        />
      )}
    </div>
  )
}
