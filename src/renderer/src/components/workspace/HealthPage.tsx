import { useEffect, useState, useCallback } from 'react'
import { HeartPulse, Loader2 } from 'lucide-react'
import { useWorkspaceStore, useAuditStore, useChatActions } from '@renderer/store'
import { AUDIT_TRACKS } from '../../../../shared/constants'
import type { AuditMode, AuditTrackId, AuditFinding, LLMProvider } from '../../../../shared/types'
import HealthAuditControls from './HealthAuditControls'
import HealthTrackSidebar from './HealthTrackSidebar'
import HealthDetailPanel from './HealthDetailPanel'
import AuditModelModal from './AuditModelModal'
import ScoreGauge from './ScoreGauge'

interface HealthPageProps {
  onNavigateToChat: () => void
}

const ALL_TRACK_IDS = Object.keys(AUDIT_TRACKS) as AuditTrackId[]

export default function HealthPage({ onNavigateToChat }: HealthPageProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const { loadConversations, selectConversation, sendMessage } = useChatActions()
  const {
    currentRun,
    isRunning,
    rerunningTrackId,
    selectedFindings,
    loadLatest,
    startAudit,
    cancelAudit,
    rerunTrack,
    toggleFinding,
    convertFindings,
    handleProgress,
    handleResult,
    handleComplete,
    handleStreamChunk
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

    return () => {
      cleanupProgress()
      cleanupResult()
      cleanupComplete()
      cleanupStream()
    }
  }, [handleProgress, handleResult, handleComplete, handleStreamChunk])

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
    async (_provider: LLMProvider) => {
      if (!workspaceId) return
      setShowModelModal(false)
      const tracks = ALL_TRACK_IDS.filter((id) => selectedTracks.has(id))
      await startAudit(workspaceId, mode, tracks)
    },
    [workspaceId, selectedTracks, mode, startAudit]
  )

  const handleConvert = useCallback(async () => {
    if (!workspaceId) return
    await convertFindings(workspaceId)
    onNavigateToChat()
  }, [workspaceId, convertFindings, onNavigateToChat])

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
    async (finding: AuditFinding, trackName: string) => {
      if (!workspaceId) return
      const result = await window.api.auditConvertFindings({
        workspaceId,
        findings: [finding]
      })
      await loadConversations(workspaceId)
      await selectConversation(result.conversationId)
      sendMessage(
        `Please analyze this ${trackName} finding and suggest a specific fix:\n\n` +
          `**[${finding.severity.toUpperCase()}] ${finding.title}**\n` +
          `${finding.description}\n` +
          (finding.filePath ? `File: \`${finding.filePath}\`\n` : '') +
          (finding.recommendation ? `Recommendation: ${finding.recommendation}\n` : '') +
          `\nProvide the exact code changes needed to fix this issue.`
      )
      onNavigateToChat()
    },
    [workspaceId, loadConversations, selectConversation, sendMessage, onNavigateToChat]
  )

  // Compute counts
  const completedCount = currentRun?.results.filter((r) => r.status === 'completed').length ?? 0
  const totalCount = currentRun?.selectedTracks.length ?? 0
  const percentage = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
  const effectivelyRunning = isRunning || !!rerunningTrackId

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
          <HeartPulse size={16} className="text-success" />
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
          isRunning={effectivelyRunning}
          hasSelectedTracks={selectedTracks.size > 0}
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
