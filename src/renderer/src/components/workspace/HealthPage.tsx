import { useEffect, useState, useCallback } from 'react'
import { ShieldCheck, Loader2 } from 'lucide-react'
import { useWorkspaceStore, useAuditStore } from '@renderer/store'
import { AUDIT_TRACKS } from '../../../../shared/constants'
import type { AuditMode, AuditTrackId, AuditFinding, LLMProvider } from '../../../../shared/types'
import HealthAuditControls from './HealthAuditControls'
import HealthTrackSidebar from './HealthTrackSidebar'
import HealthDetailPanel from './HealthDetailPanel'
import AuditModelModal from './AuditModelModal'
import ScoreGauge from './ScoreGauge'

interface HealthPageProps {
  onNavigateToChat: () => void
  onFixInNewChat: () => void
}

const ALL_TRACK_IDS = Object.keys(AUDIT_TRACKS) as AuditTrackId[]

export default function HealthPage({ onNavigateToChat: _onNavigateToChat, onFixInNewChat }: HealthPageProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const {
    currentRun,
    isRunning,
    isPaused,
    rerunningTrackId,
    selectedFindings,
    loadLatest,
    startAudit,
    cancelAudit,
    pauseAudit,
    resumeAudit,
    rerunTrack,
    toggleFinding,
    clearSelectedFindings,
    setPendingFixContext,
    handleProgress,
    handleResult,
    handleComplete,
    handleStreamChunk,
    handleIntermediate
  } = useAuditStore()

  const [mode, setMode] = useState<AuditMode>('light')
  const [selectedTracks, setSelectedTracks] = useState<Set<AuditTrackId>>(new Set(ALL_TRACK_IDS))
  const [showModelModal, setShowModelModal] = useState(false)
  const [activeTrackId, setActiveTrackId] = useState<AuditTrackId | null>(null)

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

  // Auto-select the running track so detail panel shows live stream
  useEffect(() => {
    if (!isRunning && !rerunningTrackId) return
    const runningTrack = currentRun?.results.find((r) => r.status === 'running')
    if (runningTrack) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional auto-follow
      setActiveTrackId(runningTrack.trackId)
    }
  }, [currentRun?.results, isRunning, rerunningTrackId])

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

  const handleStart = useCallback(() => {
    setShowModelModal(true)
  }, [])

  const handleConfirmAudit = useCallback(
    async (provider: LLMProvider) => {
      if (!workspaceId) return
      setShowModelModal(false)
      const tracks = ALL_TRACK_IDS.filter((id) => selectedTracks.has(id))
      await startAudit(workspaceId, mode, tracks, provider)
    },
    [workspaceId, selectedTracks, mode, startAudit]
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
        {/* Left: title */}
        <div className="flex items-center gap-2">
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
          onSelectTrack={setActiveTrackId}
          results={currentRun?.results ?? []}
          isRunning={effectivelyRunning}
          allSelected={allSelected}
          onToggleAll={handleToggleAll}
        />
        <HealthDetailPanel
          activeTrackId={activeTrackId}
          currentRun={currentRun}
          mode={mode}
          rerunningTrackId={rerunningTrackId}
          selectedFindings={selectedFindings}
          onToggleFinding={toggleFinding}
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

      {/* Model selection modal */}
      <AuditModelModal
        open={showModelModal}
        defaultProvider="claude"
        selectedTrackCount={selectedTracks.size}
        mode={mode}
        onConfirm={handleConfirmAudit}
        onCancel={() => setShowModelModal(false)}
      />
    </div>
  )
}
