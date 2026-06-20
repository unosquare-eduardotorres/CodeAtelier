/**
 * Extracted hooks for HealthPage — reduces cyclomatic complexity by
 * isolating action callbacks and derived run-status computations.
 */

import { useCallback, useMemo } from 'react'
import { useAuditStore, useMpaStore } from '@renderer/store'
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
import { auditPlanToStructuredPlan } from '../../utils/audit-plan-converter'

const ALL_TRACK_IDS = Object.keys(AUDIT_TRACKS) as AuditTrackId[]

// ── useHealthPageActions ─────────────────────────────────────────────────

interface UseHealthPageActionsOpts {
  workspaceId: string | undefined
  mode: AuditMode
  setMode: (mode: AuditMode) => void
  selectedTracks: Set<AuditTrackId>
  setSelectedTracks: React.Dispatch<React.SetStateAction<Set<AuditTrackId>>>
  setActiveTrackId: (id: AuditTrackId | null) => void
  setView: (view: 'landing' | 'configure' | 'active' | 'plan') => void
  followLiveRef: React.MutableRefObject<boolean>
  onFixInNewChat: () => void
  onSendPlanToGrill?: (title: string, description: string) => void
  onNavigateToCouncil?: () => void
  onNavigateToGoals?: () => void
}

export interface HealthPageActions {
  handleToggleAll: () => void
  handleToggleTrack: (trackId: AuditTrackId) => void
  handleSelectTrack: (id: AuditTrackId | null) => void
  handleStart: () => void
  handleConfigureRun: (config: {
    mode: AuditMode
    tracks: AuditTrackId[]
    provider: LLMProvider
    selectedSkills: AuditSelectedSkills
  }) => Promise<void>
  handleConvert: () => void
  handleRerunTrack: (trackId: AuditTrackId) => Promise<void>
  handleAutoFix: (finding: AuditFinding, trackName: string) => void
  handleExport: () => Promise<void>
  handleExportPlan: () => Promise<void>
  handleResume: () => Promise<void>
  handleNewAudit: () => void
  handleOpenRun: (run: AuditRun) => void
  handleRerunRun: (run: AuditRun) => Promise<void>
  handleBackToHistory: () => void
  handleBuildPlan: () => void
  handleSendPlanToChat: () => void
  handleSendPlanToCouncil: () => void
  handleSendPlanToGoals: () => void
  handleSendPlanToGrill: () => void
  handleBackToResults: () => void
}

export function useHealthPageActions(opts: UseHealthPageActionsOpts): HealthPageActions {
  const {
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
  } = opts

  const {
    currentRun,
    selectedFindings,
    currentPlan,
    startAudit,
    resumeAudit,
    rerunTrack,
    clearSelectedFindings,
    setPendingFixContext,
    generatePlan,
    clearPlan,
    reset,
    openRun
  } = useAuditStore()

  const allSelected = selectedTracks.size === ALL_TRACK_IDS.length

  const planDoc = currentPlan?.plan.requirementDocument ?? currentPlan?.plan.summary ?? ''
  const planTitle = currentPlan?.plan.title ?? 'Audit Remediation Plan'

  // ── Toggle helpers ──

  const handleToggleAll = useCallback(() => {
    if (allSelected) {
      setSelectedTracks(new Set())
    } else {
      setSelectedTracks(new Set(ALL_TRACK_IDS))
    }
  }, [allSelected, setSelectedTracks])

  const handleToggleTrack = useCallback(
    (trackId: AuditTrackId) => {
      setSelectedTracks((prev) => {
        const next = new Set(prev)
        if (next.has(trackId)) {
          next.delete(trackId)
        } else {
          next.add(trackId)
        }
        return next
      })
    },
    [setSelectedTracks]
  )

  const handleSelectTrack = useCallback(
    (id: AuditTrackId | null) => {
      followLiveRef.current = false
      setActiveTrackId(id)
    },
    [followLiveRef, setActiveTrackId]
  )

  // ── Navigation ──

  const handleStart = useCallback(() => {
    setView('configure')
  }, [setView])

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
    [workspaceId, startAudit, followLiveRef, setMode, setSelectedTracks, setActiveTrackId, setView]
  )

  // ── Finding actions ──

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

  // ── Run management ──

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

  const handleExportPlan = useCallback(async () => {
    if (!workspaceId) return
    try {
      await window.api.auditExportPlanMarkdown({ workspaceId })
    } catch {
      // Non-critical — user may have cancelled the save dialog
    }
  }, [workspaceId])

  const handleResume = useCallback(async () => {
    if (!workspaceId) return
    try {
      await resumeAudit(workspaceId)
    } catch {
      // error already logged in store
    }
  }, [workspaceId, resumeAudit])

  const handleNewAudit = useCallback(() => {
    reset()
    followLiveRef.current = true
    setActiveTrackId(null)
    setSelectedTracks(new Set(ALL_TRACK_IDS))
    setMode('light')
    setView('configure')
  }, [reset, followLiveRef, setActiveTrackId, setSelectedTracks, setMode, setView])

  const handleOpenRun = useCallback(
    (run: AuditRun) => {
      openRun(run)
      setMode(run.mode)
      setSelectedTracks(new Set(run.selectedTracks))
      setActiveTrackId(null)
      setView('active')
    },
    [openRun, setMode, setSelectedTracks, setActiveTrackId, setView]
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
    [workspaceId, startAudit, followLiveRef, setMode, setSelectedTracks, setActiveTrackId, setView]
  )

  const handleBackToHistory = useCallback(() => {
    setActiveTrackId(null)
    setView('landing')
  }, [setActiveTrackId, setView])

  // ── Plan ──

  const handleBuildPlan = useCallback(() => {
    if (!workspaceId) return
    setView('plan')
    generatePlan(workspaceId).catch(() => {
      setView('active')
    })
  }, [workspaceId, generatePlan, setView])

  const handleSendPlanToChat = useCallback(() => {
    if (!currentPlan) return
    const structuredPlan = auditPlanToStructuredPlan(currentPlan.plan)
    const planBlock = '```plan\n' + JSON.stringify(structuredPlan, null, 2) + '\n```'
    setPendingFixContext({
      title: `🔧 ${planTitle}`,
      description: planBlock
    })
    clearSelectedFindings()
    onFixInNewChat()
  }, [currentPlan, planTitle, setPendingFixContext, clearSelectedFindings, onFixInNewChat])

  const handleSendPlanToCouncil = useCallback(() => {
    if (!workspaceId || !currentPlan) return
    const councilStore = useCouncilStore.getState()
    councilStore.startCouncil()
    const structuredPlan = auditPlanToStructuredPlan(currentPlan.plan)
    window.api
      .councilStart({
        workspaceId,
        inputType: 'plan',
        planContent: planDoc,
        structuredPlan,
        originalUserRequest: planTitle,
        conversationId: undefined
      })
      .then(({ sessionId }) => {
        councilStore.setSessionIdentity(sessionId, workspaceId)
        councilStore.setInputTitle(planTitle)
      })
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
  }, [clearPlan, setView])

  return {
    handleToggleAll,
    handleToggleTrack,
    handleSelectTrack,
    handleStart,
    handleConfigureRun,
    handleConvert,
    handleRerunTrack,
    handleAutoFix,
    handleExport,
    handleExportPlan,
    handleResume,
    handleNewAudit,
    handleOpenRun,
    handleRerunRun,
    handleBackToHistory,
    handleBuildPlan,
    handleSendPlanToChat,
    handleSendPlanToCouncil,
    handleSendPlanToGoals,
    handleSendPlanToGrill,
    handleBackToResults
  }
}

// ── useAuditRunStatus ────────────────────────────────────────────────────

export interface AuditRunStatus {
  completedCount: number
  totalCount: number
  percentage: number
  effectivelyRunning: boolean
  canResume: boolean
  incompleteTrackCount: number
  showTray: boolean
  auditorCount: number
}

export function useAuditRunStatus(
  currentRun: AuditRun | null,
  isRunning: boolean,
  rerunningTrackId: AuditTrackId | null,
  selectedFindings: AuditFinding[]
): AuditRunStatus {
  return useMemo(() => {
    const completedCount = currentRun?.results.filter((r) => r.status === 'completed').length ?? 0
    const totalCount = currentRun?.selectedTracks.length ?? 0
    const percentage = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
    const hasRunningTrack = currentRun?.results.some((r) => r.status === 'running') ?? false
    const effectivelyRunning = isRunning || !!rerunningTrackId || hasRunningTrack

    const incompleteTrackCount =
      currentRun?.results.filter(
        (r) => r.status === 'cancelled' || r.status === 'pending' || r.status === 'failed'
      ).length ?? 0
    const canResume =
      !effectivelyRunning &&
      currentRun != null &&
      (currentRun.status === 'partial' || currentRun.status === 'cancelled') &&
      incompleteTrackCount > 0

    const selectedIds = new Set(selectedFindings.map((f) => f.id))
    const auditorCount =
      currentRun?.results.filter((r) => r.findings.some((f) => selectedIds.has(f.id))).length ?? 0
    const showTray = !effectivelyRunning && selectedFindings.length > 0

    return {
      completedCount,
      totalCount,
      percentage,
      effectivelyRunning,
      canResume,
      incompleteTrackCount,
      showTray,
      auditorCount
    }
  }, [currentRun, isRunning, rerunningTrackId, selectedFindings])
}
