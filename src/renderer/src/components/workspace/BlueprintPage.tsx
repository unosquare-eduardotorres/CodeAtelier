import { useState, useEffect, useRef, useCallback, useMemo, type JSX } from 'react'
import BlueprintFilterBar, { type BlueprintFilter } from './blueprints/BlueprintFilterBar'
import { BookOpen, Plus, Send, SkipForward, AlertTriangle, X, PlayCircle } from 'lucide-react'
import { useBlueprintStore, type BlueprintChatMessage } from '@renderer/store/blueprint.store'
import { rendererLog } from '@renderer/utils/logger'
import { ConfirmDialog } from '@renderer/components/common'
import { useWorkspaceStore } from '@renderer/store/workspace.store'
import { BlueprintPhaseTimeline, BlueprintApprovalGate, BlueprintHistoryItem } from './blueprints'
import { BlueprintClarifyGateCard } from './blueprints/BlueprintClarifyGateCard'
import { PHASE_ICONS, type PhaseIconKey } from './blueprints/phase-icons'
import BlueprintChatView, { BlueprintQuestionFooter } from './blueprints/BlueprintChatView'
import BlueprintExecutionPanel from './blueprints/BlueprintExecutionPanel'
import { BlueprintRunHeader } from './blueprints/BlueprintRunHeader'
import { readBlueprintBranchName } from './blueprints/detail/reference-docs'
import { BlueprintDetailView } from './blueprints/detail/BlueprintDetailView'
import { BlueprintInputView } from './blueprints/BlueprintInputView'
import { BlueprintDeliverablesView } from './blueprints/BlueprintDeliverablesView'
import type { BlueprintPhaseType, BlueprintStatus } from '../../../../shared/blueprint-types'

// ── View States ──

type ViewState = 'landing' | 'input' | 'active' | 'detail'

// ── Blueprint Page ──

interface BlueprintPageProps {
  onNavigateToChat?: () => void
}

// ── getEffectiveView ──

function getEffectiveView(
  viewState: ViewState,
  isRunning: boolean,
  pendingApproval: unknown,
  selectedId: string | null
): ViewState {
  if (isRunning || pendingApproval) return 'active'
  if (selectedId) return 'detail'
  return viewState
}

// ── BlueprintActiveView ──

function BlueprintActiveView({
  pendingApproval,
  currentPhase,
  currentWave,
  waveTasks,
  phaseStartedAt,
  isRunning,
  blueprintTitle,
  pipelineStartedAt,
  phaseDurations,
  chatMessages,
  clarifyAwaitingInput,
  clarifyFindings,
  clarifyQuestions,
  clarifyGateReady,
  currentGoal,
  taskGoals,
  runningTasks,
  phaseCompletions,
  totalTaskCount,
  totalWaves,
  currentBlueprint,
  onApprove,
  onReject,
  onCancel,
  onRerunPreflight,
  onSendClarifyAnswer,
  onSkipClarify,
  onProceedGate,
  onIterateClarify
}: {
  pendingApproval: {
    blueprintId: string
    planSummary: string
    completion?: Record<string, unknown>
    reviewMarkdown?: string
    preflight?: {
      result: {
        checks: Array<{
          id: string
          name: string
          kind: string
          status: string
          message: string
          remediation?: string
          sources: string[]
        }>
        ranAt: string
        hasBlockers: boolean
        hasWarnings: boolean
      }
      overridden: boolean
    }
  } | null
  onRerunPreflight?: () => void
  currentPhase: BlueprintPhaseType | null
  currentWave: { wave: number; taskCount: number } | null
  waveTasks: Record<string, import('../../../../shared/blueprint-types').BlueprintTaskStatus>
  phaseStartedAt: number | null
  isRunning: boolean
  blueprintTitle: string | null
  pipelineStartedAt: number | null
  phaseDurations: Partial<Record<BlueprintPhaseType, number>>
  chatMessages: BlueprintChatMessage[]
  clarifyAwaitingInput: boolean
  clarifyFindings:
    import('../../../../shared/blueprint-clarify-parsers').ClarifyFindingsBlock | null
  clarifyQuestions:
    import('../../../../shared/blueprint-clarify-parsers').ClarifyQuestionsBlock | null
  clarifyGateReady: boolean
  currentGoal: string | null
  taskGoals: Record<string, string>
  runningTasks: Record<string, { taskId: string; description: string }>
  phaseCompletions: Partial<Record<BlueprintPhaseType, Record<string, unknown>>>
  totalTaskCount: number
  totalWaves: number
  currentBlueprint: ReturnType<typeof useBlueprintStore.getState>['currentBlueprint']
  onApprove: () => void
  onReject: (feedback: string) => void
  onCancel: () => void
  onSendClarifyAnswer: (
    message: string,
    answers?: Record<
      string,
      import('../../../../shared/blueprint-clarify-parsers').QuestionAnswerState
    >
  ) => void
  onSkipClarify: () => void
  onProceedGate: () => void
  onIterateClarify: () => void
}): JSX.Element {
  // Tab state: execution (3-col grid) vs deliverables (full-width phase view)
  const [activeTab, setActiveTab] = useState<'execution' | 'deliverables'>('execution')

  // Execution panel toggle + width (persist to localStorage)
  const [panelOpen, setPanelOpen] = useState(() => {
    const saved = localStorage.getItem('blueprint-panel-open')
    return saved === 'true'
  })
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem('blueprint-panel-width')
    return saved ? Math.min(560, Math.max(280, parseInt(saved, 10))) : 320
  })

  // Persist panel open state
  useEffect(() => {
    localStorage.setItem('blueprint-panel-open', String(panelOpen))
  }, [panelOpen])

  // Extract plan artifact from currentBlueprint for the execution panel
  const planArtifact = useMemo(() => {
    if (!currentBlueprint) return null
    const planPhase = currentBlueprint.phases.find((p) => p.phase === 'plan')
    if (!planPhase) return null
    const planArt = planPhase.artifactsJson?.find(
      (a) => a.type === 'plan' || a.type === 'blueprint-plan'
    )
    return (planArt?.contentJson as Record<string, unknown>) ?? null
  }, [currentBlueprint])

  // Overall progress (tasks done / total)
  const tasksDone = currentBlueprint
    ? currentBlueprint.tasks.filter((t) => {
        const status = waveTasks[t.taskId] ?? t.status
        return status === 'complete'
      }).length
    : 0
  const taskTotal = totalTaskCount || (currentBlueprint?.tasks.length ?? 0)

  // Track whether any phases have completed (enables deliverables tab)
  const hasCompletedPhases = useMemo(
    () =>
      currentBlueprint?.phases.some((p) => p.status === 'complete' || p.status === 'failed') ??
      false,
    [currentBlueprint]
  )

  return (
    <>
      {/* ── Run Header (redesigned with stepper + progress) ── */}
      <BlueprintRunHeader
        isRunning={isRunning}
        currentPhase={currentPhase}
        blueprintTitle={blueprintTitle}
        branchName={readBlueprintBranchName(currentBlueprint?.settingsJson)}
        pipelineStartedAt={pipelineStartedAt}
        phaseDurations={phaseDurations}
        phaseStartedAt={phaseStartedAt}
        pendingApproval={!!pendingApproval}
        tasksDone={tasksDone}
        taskTotal={taskTotal}
        totalWaves={totalWaves}
        currentWave={currentWave}
        runningTasks={runningTasks}
        currentGoal={currentGoal}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
        onCancel={onCancel}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        hasCompletedPhases={hasCompletedPhases}
      />

      {activeTab === 'execution' ? (
        <div
          data-testid="blueprint-phase-timeline"
          className="bg-surface-raised rounded-xl border border-border-subtle overflow-hidden flex-1 min-h-0 flex flex-col"
        >
          <div
            className={`grid ${panelOpen ? '' : 'grid-cols-[200px_minmax(0,1fr)]'} grid-rows-[minmax(0,1fr)] divide-x divide-border-subtle flex-1 min-h-0`}
            style={
              panelOpen ? { gridTemplateColumns: `200px minmax(0,1fr) ${panelWidth}px` } : undefined
            }
          >
            <div className="p-3 overflow-y-auto min-h-0">
              <BlueprintPhaseTimeline
                currentPhase={currentPhase}
                awaitingApproval={!!pendingApproval}
                phaseDurations={phaseDurations}
                phaseStartedAt={phaseStartedAt}
              />
            </div>
            <div className="flex flex-col min-h-0 min-w-0">
              <BlueprintChatView
                messages={chatMessages}
                isStreaming={
                  isRunning &&
                  !clarifyGateReady &&
                  !clarifyQuestions &&
                  !clarifyAwaitingInput &&
                  !pendingApproval
                }
                runningTasks={runningTasks}
                waveTasks={waveTasks}
                currentPhase={currentPhase}
                footer={
                  <>
                    {/* Approval gate card (review → build transition) */}
                    {pendingApproval && (
                      <div
                        data-testid="blueprint-approval-gate"
                        className="bg-surface-raised rounded-xl border border-info/30 p-4"
                      >
                        <BlueprintApprovalGate
                          planSummary={pendingApproval.planSummary}
                          completion={pendingApproval.completion}
                          reviewMarkdown={pendingApproval.reviewMarkdown}
                          preflight={pendingApproval.preflight}
                          onRerunPreflight={onRerunPreflight}
                          onApprove={onApprove}
                          onReject={onReject}
                          onCancel={onCancel}
                        />
                      </div>
                    )}

                    {/* Clarify gate card (completion arrived) */}
                    {clarifyGateReady && (
                      <BlueprintClarifyGateCard
                        findings={clarifyFindings}
                        onProceed={onProceedGate}
                        onIterate={onIterateClarify}
                      />
                    )}

                    {/* Clarify question footer (structured Q&A — Grill pattern) */}
                    {clarifyQuestions && !clarifyGateReady && (
                      <BlueprintQuestionFooter
                        questions={clarifyQuestions.questions}
                        onSubmit={onSendClarifyAnswer}
                        onSkip={onSkipClarify}
                      />
                    )}

                    {/* Clarify fallback textarea (no structured questions parsed) */}
                    {clarifyAwaitingInput && !clarifyQuestions && !clarifyGateReady && (
                      <ClarifyAnswerPanel onSend={onSendClarifyAnswer} onSkip={onSkipClarify} />
                    )}
                  </>
                }
              />
            </div>

            {/* Execution panel (collapsible right column) */}
            {panelOpen && (
              <BlueprintExecutionPanel
                tasks={currentBlueprint?.tasks ?? []}
                waveTasks={waveTasks}
                taskGoals={taskGoals}
                currentWave={currentWave}
                phaseCompletions={phaseCompletions}
                planArtifact={planArtifact}
                currentGoal={currentGoal}
                currentPhase={currentPhase}
                onResize={(width) => {
                  setPanelWidth(width)
                  localStorage.setItem('blueprint-panel-width', String(width))
                }}
              />
            )}
          </div>
        </div>
      ) : (
        <BlueprintDeliverablesView
          blueprint={currentBlueprint}
          phaseDurations={phaseDurations}
          clarifyAwaitingInput={clarifyAwaitingInput}
          clarifyQuestions={!!clarifyQuestions}
          pendingApproval={!!pendingApproval}
          onSwitchToExecution={() => setActiveTab('execution')}
        />
      )}
    </>
  )
}

// ── ClarifyAnswerPanel ──

function ClarifyAnswerPanel({
  onSend,
  onSkip
}: {
  onSend: (message: string) => void
  onSkip: () => void
}): JSX.Element {
  const [answer, setAnswer] = useState('')

  const handleSend = useCallback(() => {
    const trimmed = answer.trim()
    if (!trimmed) return
    onSend(trimmed)
    setAnswer('')
  }, [answer, onSend])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  return (
    <div
      data-testid="blueprint-clarify-panel"
      className="bg-surface-raised rounded-xl border border-info/30 p-4 space-y-3"
    >
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-info animate-pulse" />
        <span className="text-xs font-medium text-info">Awaiting your answer</span>
      </div>
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type your answer to the clarifying questions above..."
        rows={3}
        className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-info resize-none"
        autoFocus
      />
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onSkip}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded-lg transition-colors"
        >
          <SkipForward size={12} />
          Skip clarification
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={!answer.trim()}
          className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-info hover:bg-info/80 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Send size={12} />
          Send Answer
        </button>
      </div>
      <p className="text-[10px] text-text-muted">Press ⌘+Enter to send</p>
    </div>
  )
}

// ── Phase 4: View-restore map (module-scoped) ──
// Remembers last-viewed blueprint per workspace to avoid bouncing to landing on re-render
const lastViewedByWorkspace = new Map<string, string>()

// ── BlueprintPage ──

export default function BlueprintPage({ onNavigateToChat }: BlueprintPageProps): JSX.Element {
  const workspace = useWorkspaceStore((s) => s.activeWorkspace)
  const workspaceId = workspace?.id ?? ''

  const {
    isRunning,
    currentPhase,
    chatMessages,
    pendingApproval,
    clarifyAwaitingInput,
    clarifyFindings,
    clarifyQuestions,
    clarifyGateReady,
    currentWave,
    waveTasks,
    currentGoal,
    taskGoals,
    runningTasks,
    phaseCompletions,
    totalTaskCount,
    totalWaves,
    history,
    currentBlueprint,
    lastError,
    phaseDurations,
    phaseStartTimestamps,
    loadHistory,
    loadBlueprint,
    startBlueprint,
    cancelBlueprint,
    deleteBlueprint,
    respondToApproval,
    rerunPreflight,
    sendClarifyAnswer,
    skipClarify,
    proceedClarifyGate,
    iterateClarify,
    retryPhase,
    loadPipelineStatus,
    resetForWorkspaceSwitch,
    hydrateTranscript,
    phaseStartedAt,
    orphanedBlueprint
  } = useBlueprintStore()

  // ── Local state ──
  const [viewState, setViewState] = useState<ViewState>('landing')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string
    title: string
    isActive: boolean
  } | null>(null)
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  // Prefill state for onboard flow (CreateProjectDialog → BlueprintPage handoff)
  const [prefillTitle, setPrefillTitle] = useState('')
  const [prefillDescription, setPrefillDescription] = useState('')

  // ── Filter & search state ──
  const [filter, setFilter] = useState<BlueprintFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const COMPLETED_STATUSES: BlueprintStatus[] = ['complete']
  const FAILED_STATUSES: BlueprintStatus[] = ['failed', 'cancelled']

  const filterCounts = useMemo(() => {
    const complete = history.filter((bp) => COMPLETED_STATUSES.includes(bp.status)).length
    const failed = history.filter((bp) => FAILED_STATUSES.includes(bp.status)).length
    const active = history.length - complete - failed
    return { all: history.length, active, complete, failed }
  }, [history])

  const filteredHistory = useMemo(() => {
    let result = history
    if (filter === 'complete')
      result = result.filter((bp) => COMPLETED_STATUSES.includes(bp.status))
    else if (filter === 'failed')
      result = result.filter((bp) => FAILED_STATUSES.includes(bp.status))
    else if (filter === 'active')
      result = result.filter(
        (bp) => !COMPLETED_STATUSES.includes(bp.status) && !FAILED_STATUSES.includes(bp.status)
      )
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (bp) =>
          bp.title.toLowerCase().includes(q) || (bp.description ?? '').toLowerCase().includes(q)
      )
    }
    return result
  }, [history, filter, searchQuery])

  const EMPTY_FILTER_MESSAGES: Record<BlueprintFilter, string> = {
    all: 'No blueprints yet. Create one to get started!',
    active: 'No active blueprints running.',
    complete: 'No completed blueprints yet.',
    failed: 'No failed blueprints — nice!'
  }

  // ── Load history + recover pipeline state on workspace change / app reopen ──
  // Phase 4: Priority-based view restore instead of unconditional landing bounce.
  // Priority: pendingOnboard > running pipeline > lastViewed > landing
  useEffect(() => {
    if (workspaceId) {
      resetForWorkspaceSwitch(workspaceId) // Clear stale state from previous workspace
      loadHistory(workspaceId)
      // Recovery: if the app was reopened mid-pipeline, restore currentPhase/isRunning
      loadPipelineStatus(workspaceId).then(() => {
        // MINOR-FIX: Stale-workspace guard — if user switched workspace while
        // loadPipelineStatus was in-flight, skip restore to avoid wrong-workspace state.
        if (useWorkspaceStore.getState().activeWorkspace?.id !== workspaceId) return

        const state = useBlueprintStore.getState()
        /* eslint-disable react-hooks/set-state-in-effect -- intentional conditional restore */
        // Priority 1: pendingOnboard handled by its own effect (skip here)
        // Priority 2: pipeline running → active view (getEffectiveView handles via isRunning)
        if (state.isRunning && state.currentBlueprint?.id) {
          setSelectedId(null)
          // Don't setViewState — getEffectiveView will force 'active'
          return
        }
        // Priority 3: restore last-viewed blueprint
        const lastViewed = lastViewedByWorkspace.get(workspaceId)
        if (lastViewed) {
          setSelectedId(lastViewed)
          setViewState('detail')
          loadBlueprint(lastViewed)
          hydrateTranscript(lastViewed)
          return
        }
        // Priority 4: landing
        setSelectedId(null)
        setViewState('landing')
        /* eslint-enable react-hooks/set-state-in-effect */
      })
    } else {
      /* eslint-disable react-hooks/set-state-in-effect -- intentional reset */
      setSelectedId(null)
      setViewState('landing')
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [
    workspaceId,
    loadHistory,
    loadPipelineStatus,
    resetForWorkspaceSwitch,
    loadBlueprint,
    hydrateTranscript
  ])

  // ── Auto-start from pendingOnboard (CreateProjectDialog → BlueprintPage handoff) ──
  const pendingOnboard = useBlueprintStore((s) => s.pendingOnboard)
  const clearPendingOnboard = useBlueprintStore((s) => s.clearPendingOnboard)
  const clarifyBlueprintId = useBlueprintStore((s) => s.clarifyBlueprintId)

  useEffect(() => {
    if (!pendingOnboard || pendingOnboard.workspaceId !== workspaceId || isRunning) {
      return
    }

    // Consume the onboard payload immediately to prevent double-fire
    const { title: onboardTitle, description: onboardDesc, referenceDocuments } = pendingOnboard
    clearPendingOnboard()

    if (onboardDesc.trim()) {
      // Auto-start the blueprint pipeline — no extra click needed
      startBlueprint({
        workspaceId,
        title: onboardTitle,
        description: onboardDesc,
        settingsJson: referenceDocuments.length > 0 ? { referenceDocuments } : undefined
      }).catch(() => {
        // Error already logged in store
      })
    } else {
      // Edge case: empty description — prefill the input view instead
      /* eslint-disable react-hooks/set-state-in-effect -- intentional prefill from external trigger */
      setPrefillTitle(onboardTitle)
      if (referenceDocuments.length > 0) {
        setPrefillDescription(
          `Reference documents attached in .context/: ${referenceDocuments.map((d) => d.name).join(', ')}`
        )
      }
      setViewState('input')
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [pendingOnboard, workspaceId, isRunning, clearPendingOnboard, startBlueprint])

  // ── Land on the finished run ──
  //
  // Nothing set `selectedId` when a pipeline ended on its own, so `getEffectiveView`
  // fell through to whatever `viewState` happened to be — usually the create form
  // the run was started from. The outcome summary and the hand-off card were then
  // only reachable by going back to the list and clicking the run again, which is
  // exactly the moment they exist for.
  const wasRunningRef = useRef(false)
  useEffect(() => {
    const finishedId = useBlueprintStore.getState().currentBlueprint?.id
    // `finishedId` is null after a workspace switch clears the store, which is
    // what keeps that reset from reading as a completion.
    if (wasRunningRef.current && !isRunning && finishedId) {
      setSelectedId(finishedId)
      setViewState('detail')
      void loadBlueprint(finishedId)
      hydrateTranscript(finishedId)
      if (workspaceId) lastViewedByWorkspace.set(workspaceId, finishedId)
    }
    wasRunningRef.current = isRunning
  }, [isRunning, loadBlueprint, hydrateTranscript, workspaceId])

  // ── Derive view state ──
  const effectiveView = getEffectiveView(viewState, isRunning, pendingApproval, selectedId)

  // ── Actions ──
  const handleStart = useCallback(
    async (params: {
      title: string
      description?: string
      settingsJson?: Record<string, unknown>
    }) => {
      if (!params.title.trim() || !workspaceId) return
      try {
        await startBlueprint({
          workspaceId,
          title: params.title,
          description: params.description,
          settingsJson: params.settingsJson
        })
        setPrefillTitle('')
        setPrefillDescription('')
      } catch {
        // Error already logged in store — go back to landing so the error banner is visible
        setViewState('landing')
      }
    },
    [workspaceId, startBlueprint]
  )

  const handleCancel = useCallback(async () => {
    if (!workspaceId) return
    const cancelledId = await cancelBlueprint(workspaceId)
    // Navigate to the detail view so user sees "Stopped" status + Resume button
    if (cancelledId) {
      setSelectedId(cancelledId)
      setViewState('detail')
      void loadBlueprint(cancelledId)
    }
  }, [workspaceId, cancelBlueprint, loadBlueprint])

  const handleApprove = useCallback(() => {
    if (pendingApproval) {
      respondToApproval(pendingApproval.blueprintId, true)
    }
  }, [pendingApproval, respondToApproval])

  const handleRerunPreflight = useCallback(() => {
    if (pendingApproval && workspaceId) {
      rerunPreflight(pendingApproval.blueprintId, workspaceId)
    }
  }, [pendingApproval, workspaceId, rerunPreflight])

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
      loadBlueprint(id)
      // Phase 1: Hydrate transcript from journal for historical run viewing
      hydrateTranscript(id)
      // Phase 4: Remember last-viewed for view restore
      if (workspaceId) lastViewedByWorkspace.set(workspaceId, id)
    },
    [loadBlueprint, hydrateTranscript, workspaceId]
  )

  const handleBackFromDetail = useCallback(() => {
    setSelectedId(null)
    setViewState('landing')
    // Phase 4: Clear last-viewed on explicit back (user chose to leave)
    if (workspaceId) lastViewedByWorkspace.delete(workspaceId)
  }, [workspaceId])

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || !workspaceId) return
    const { id } = deleteTarget
    setDeleteTarget(null)
    // Trigger exit animation
    setDeletingIds((prev) => new Set(prev).add(id))
    // Wait for animation, then actually delete
    setTimeout(async () => {
      await deleteBlueprint(id, workspaceId)
      // MINOR-FIX: Clear lastViewedByWorkspace for deleted blueprint
      // to prevent restore of a deleted run (empty detail view)
      if (lastViewedByWorkspace.get(workspaceId) === id) {
        lastViewedByWorkspace.delete(workspaceId)
      }
      setDeletingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, 260)
  }, [deleteTarget, workspaceId, deleteBlueprint])

  // Derive pipeline start time from first phase start timestamp
  const pipelineStartedAt = (() => {
    const timestamps = Object.values(phaseStartTimestamps).filter(Boolean) as number[]
    return timestamps.length > 0 ? Math.min(...timestamps) : phaseStartedAt
  })()

  // Active view goes full-bleed; landing/input/detail stay narrow for readability
  const isFullBleed = effectiveView === 'active'
  // B1: Input view gets wider max-w and flex-fill for full-height layout
  const narrowMaxW =
    effectiveView === 'input' || effectiveView === 'detail' ? 'max-w-7xl' : 'max-w-3xl'

  return (
    <div
      data-testid="blueprint-page"
      className={`flex flex-col h-full ${isFullBleed ? '' : 'overflow-y-auto'}`}
    >
      <div
        className={`w-full ${isFullBleed ? 'px-4 pt-4 pb-2 flex flex-col flex-1 min-h-0 gap-3' : `p-6 space-y-6 ${narrowMaxW} mx-auto ${effectiveView === 'input' ? 'flex flex-col flex-1 min-h-0' : ''}`}`}
      >
        {/* Header — hidden during active view (status bar replaces it) */}
        {!isFullBleed && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BookOpen size={16} className="text-accent" />
              <h3 className="text-sm font-semibold text-text-primary">Blueprints</h3>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-float text-text-muted">
                Experimental
              </span>
            </div>
          </div>
        )}
        {/* Description hidden during active view — pipeline is self-explanatory */}
        {!isFullBleed && (
          <p className="text-xs text-text-secondary">
            Define a feature and let the 7-phase pipeline specify, plan, build, and verify it
            automatically — pausing for your approval before writing code.
          </p>
        )}

        {/* ── Landing View ── */}
        {effectiveView === 'landing' && (
          <>
            {/* Error banner — shown when a blueprint start/phase failed silently */}
            {lastError && (
              <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-red-500/20 bg-red-500/5 text-red-300">
                <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                  <span className="text-sm font-medium">Blueprint failed to start</span>
                  <span className="text-xs opacity-80 break-words">{lastError.message}</span>
                </div>
                <button
                  onClick={() => useBlueprintStore.setState({ lastError: null })}
                  className="inline-flex items-center justify-center w-6 h-6 text-red-400/60 hover:text-red-300 rounded transition-colors flex-shrink-0"
                  title="Dismiss"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Empty state */}
            {history.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 px-4">
                <div className="max-w-2xl w-full space-y-6">
                  <div className="text-center space-y-2">
                    <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary-muted mb-2">
                      <BookOpen size={28} className="text-accent" />
                    </div>
                    <h2 className="text-lg font-semibold text-text-primary">Your Blueprints</h2>
                    <p className="text-sm text-text-secondary max-w-md mx-auto">
                      Describe a feature and the agent will{' '}
                      <span className="text-text-primary font-medium">
                        specify, clarify, plan, build, and verify
                      </span>{' '}
                      it through a 7-phase pipeline — pausing for your approval.
                    </p>
                  </div>

                  {/* 7-phase workflow cards */}
                  <div className="grid grid-cols-4 gap-3">
                    {(['specify', 'plan', 'build', 'verify'] as const).map((phase) => {
                      const config = PHASE_ICONS[phase as PhaseIconKey]
                      const CardIcon = config.icon
                      return (
                        <div
                          key={phase}
                          className="rounded-xl border border-border-subtle bg-surface-overlay p-3 space-y-1.5"
                        >
                          <div className="flex items-center gap-2">
                            <div className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-primary-muted">
                              <CardIcon size={14} className="text-accent" />
                            </div>
                            <span className="text-sm font-semibold text-text-primary">
                              {config.label}
                            </span>
                          </div>
                          <p className="text-xs text-text-secondary leading-relaxed">
                            {config.description}
                          </p>
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex justify-center">
                    <button
                      onClick={() => setViewState('input')}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-accent-muted hover:bg-accent/20 text-accent rounded-xl transition-colors"
                    >
                      <Plus size={16} />
                      Create Your First Blueprint
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* History list */}
            {history.length > 0 && (
              <div className="space-y-4">
                <BlueprintFilterBar
                  filter={filter}
                  searchQuery={searchQuery}
                  counts={filterCounts}
                  onFilterChange={setFilter}
                  onSearchChange={setSearchQuery}
                  onNewBlueprint={() => setViewState('input')}
                />

                {/* BP-RESUME-02: Orphaned blueprint resume banner */}
                {orphanedBlueprint && (
                  <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5 text-amber-300">
                    <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                    <div className="flex flex-col gap-0.5 flex-1">
                      <span className="text-sm font-medium">
                        &ldquo;{orphanedBlueprint.title}&rdquo; was interrupted during{' '}
                        {orphanedBlueprint.currentPhase}
                      </span>
                      <span className="text-xs opacity-80">
                        {orphanedBlueprint.totalTasks > 0
                          ? `${orphanedBlueprint.tasksCompleted}/${orphanedBlueprint.totalTasks} tasks complete`
                          : 'No tasks started yet'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => retryPhase(orphanedBlueprint.blueprintId, workspaceId)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors"
                      >
                        <PlayCircle size={12} />
                        Resume
                      </button>
                      <button
                        onClick={() => useBlueprintStore.setState({ orphanedBlueprint: null })}
                        className="inline-flex items-center justify-center w-6 h-6 text-amber-400/60 hover:text-amber-300 rounded transition-colors"
                        title="Dismiss"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                )}

                {filteredHistory.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-xs text-text-muted">
                      {searchQuery.trim()
                        ? 'No blueprints match your search.'
                        : EMPTY_FILTER_MESSAGES[filter]}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredHistory.map((bp) => (
                      <BlueprintHistoryItem
                        key={bp.id}
                        blueprint={bp}
                        onSelect={() => handleSelectBlueprint(bp.id)}
                        onDelete={() =>
                          setDeleteTarget({
                            id: bp.id,
                            title: bp.title,
                            isActive: isRunning && currentBlueprint?.id === bp.id
                          })
                        }
                        isDeleting={deletingIds.has(bp.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ── Input View ── */}
        {effectiveView === 'input' && (
          <BlueprintInputView
            workspaceId={workspaceId}
            onStart={handleStart}
            onBack={() => setViewState('landing')}
            initialTitle={prefillTitle}
            initialDescription={prefillDescription}
          />
        )}

        {/* ── Active Pipeline View ── */}
        {effectiveView === 'active' && (
          <BlueprintActiveView
            pendingApproval={pendingApproval}
            currentPhase={currentPhase}
            currentWave={currentWave}
            waveTasks={waveTasks}
            phaseStartedAt={phaseStartedAt}
            isRunning={isRunning}
            blueprintTitle={currentBlueprint?.title ?? null}
            pipelineStartedAt={pipelineStartedAt}
            phaseDurations={phaseDurations}
            chatMessages={chatMessages}
            clarifyAwaitingInput={clarifyAwaitingInput}
            clarifyFindings={clarifyFindings}
            clarifyQuestions={clarifyQuestions}
            clarifyGateReady={clarifyGateReady}
            currentGoal={currentGoal}
            taskGoals={taskGoals}
            runningTasks={runningTasks}
            phaseCompletions={phaseCompletions}
            totalTaskCount={totalTaskCount}
            totalWaves={totalWaves}
            currentBlueprint={currentBlueprint}
            onApprove={handleApprove}
            onReject={handleReject}
            onCancel={handleCancel}
            onRerunPreflight={handleRerunPreflight}
            onSendClarifyAnswer={(message, answers) => {
              const bpId = currentBlueprint?.id ?? clarifyBlueprintId
              if (bpId && workspaceId) {
                sendClarifyAnswer(bpId, workspaceId, message, answers)
              } else {
                rendererLog.error('[blueprint] Cannot submit answer — no blueprint id in scope')
                useBlueprintStore.setState({
                  lastError: {
                    blueprintId: '',
                    message: 'Cannot submit answer — no blueprint id in scope'
                  }
                })
              }
            }}
            onSkipClarify={() => {
              const bpId = currentBlueprint?.id ?? clarifyBlueprintId
              if (bpId) {
                skipClarify(bpId)
              } else {
                rendererLog.error('[blueprint] Cannot skip clarify — no blueprint id in scope')
              }
            }}
            onProceedGate={() => {
              const bpId = currentBlueprint?.id ?? clarifyBlueprintId
              if (bpId && workspaceId) {
                proceedClarifyGate(bpId, workspaceId)
              } else {
                rendererLog.error('[blueprint] Cannot proceed gate — no blueprint id in scope')
              }
            }}
            onIterateClarify={() => {
              const bpId = currentBlueprint?.id ?? clarifyBlueprintId
              if (bpId && workspaceId) {
                iterateClarify(bpId, workspaceId)
              } else {
                rendererLog.error('[blueprint] Cannot iterate clarify — no blueprint id in scope')
              }
            }}
          />
        )}

        {/* ── Detail View (past blueprint) ── */}
        {effectiveView === 'detail' && selectedId && (
          <BlueprintDetailView
            selectedId={selectedId}
            currentBlueprint={currentBlueprint}
            lastError={lastError}
            isRunning={isRunning}
            workspaceId={workspaceId || null}
            onBack={handleBackFromDetail}
            onNavigateToChat={onNavigateToChat}
            onRetryPhase={() => {
              if (selectedId && workspaceId) {
                retryPhase(selectedId, workspaceId)
              }
            }}
          />
        )}
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete Blueprint"
        message={
          deleteTarget?.isActive
            ? 'The running pipeline will be cancelled first. This permanently removes the blueprint, its phases and tasks.'
            : 'This permanently removes the blueprint, its phases and tasks.'
        }
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
