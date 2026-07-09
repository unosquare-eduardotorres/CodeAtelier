import { useState, useEffect, useCallback, useMemo, type JSX } from 'react'
import { BookOpen, Plus, Send, SkipForward, AlertTriangle, X, PlayCircle } from 'lucide-react'
import { useBlueprintStore, type BlueprintChatMessage } from '@renderer/store/blueprint.store'
import { useWorkspaceStore } from '@renderer/store/workspace.store'
import {
  BlueprintPhaseTimeline,
  BlueprintApprovalGate,
  BlueprintHistoryItem
} from './blueprints'
import { BlueprintClarifyGateCard } from './blueprints/BlueprintClarifyGateCard'
import { PHASE_ICONS, type PhaseIconKey } from './blueprints/phase-icons'
import BlueprintChatView, { BlueprintQuestionFooter } from './blueprints/BlueprintChatView'
import BlueprintExecutionPanel from './blueprints/BlueprintExecutionPanel'
import { BlueprintRunHeader } from './blueprints/BlueprintRunHeader'
import { BlueprintDetailView } from './blueprints/detail/BlueprintDetailView'
import type { BlueprintPhaseType } from '../../../../shared/blueprint-types'

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
  currentTask,
  phaseCompletions,
  totalTaskCount,
  totalWaves,
  currentBlueprint,
  onApprove,
  onReject,
  onCancel,
  onSendClarifyAnswer,
  onSkipClarify,
  onProceedGate,
  onIterateClarify
}: {
  pendingApproval: { blueprintId: string; planSummary: string } | null
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
  clarifyFindings: import('../../../../shared/blueprint-clarify-parsers').ClarifyFindingsBlock | null
  clarifyQuestions: import('../../../../shared/blueprint-clarify-parsers').ClarifyQuestionsBlock | null
  clarifyGateReady: boolean
  currentGoal: string | null
  taskGoals: Record<string, string>
  currentTask: { taskId: string; description: string } | null
  phaseCompletions: Partial<Record<BlueprintPhaseType, Record<string, unknown>>>
  totalTaskCount: number
  totalWaves: number
  currentBlueprint: ReturnType<typeof useBlueprintStore.getState>['currentBlueprint']
  onApprove: () => void
  onReject: (feedback: string) => void
  onCancel: () => void
  onSendClarifyAnswer: (message: string, answers?: Record<string, import('../../../../shared/blueprint-clarify-parsers').QuestionAnswerState>) => void
  onSkipClarify: () => void
  onProceedGate: () => void
  onIterateClarify: () => void
}): JSX.Element {
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

  return (
    <>
      {/* ── Run Header (redesigned with stepper + progress) ── */}
      <BlueprintRunHeader
        isRunning={isRunning}
        currentPhase={currentPhase}
        blueprintTitle={blueprintTitle}
        pipelineStartedAt={pipelineStartedAt}
        phaseDurations={phaseDurations}
        phaseStartedAt={phaseStartedAt}
        pendingApproval={!!pendingApproval}
        tasksDone={tasksDone}
        taskTotal={taskTotal}
        totalWaves={totalWaves}
        currentWave={currentWave}
        currentTask={currentTask}
        currentGoal={currentGoal}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
        onCancel={onCancel}
      />

      {pendingApproval && (
        <div
          data-testid="blueprint-approval-gate"
          className="bg-surface-raised rounded-xl border border-info/30 p-4"
        >
          <BlueprintApprovalGate
            planSummary={pendingApproval.planSummary}
            onApprove={onApprove}
            onReject={onReject}
            onCancel={onCancel}
          />
        </div>
      )}

      <div
        data-testid="blueprint-phase-timeline"
        className="bg-surface-raised rounded-xl border border-border-subtle overflow-hidden flex-1 min-h-0 flex flex-col"
      >
        <div
          className={`grid ${panelOpen ? '' : 'grid-cols-[200px_1fr]'} grid-rows-[minmax(0,1fr)] divide-x divide-border-subtle flex-1 min-h-0`}
          style={panelOpen ? { gridTemplateColumns: `200px 1fr ${panelWidth}px` } : undefined}
        >
          <div className="p-3 overflow-y-auto min-h-0">
            <BlueprintPhaseTimeline
              currentPhase={currentPhase}
              awaitingApproval={!!pendingApproval}
              phaseDurations={phaseDurations}
              phaseStartedAt={phaseStartedAt}
            />
          </div>
          <div className="flex flex-col min-h-0">
            <BlueprintChatView
              messages={chatMessages}
              isStreaming={isRunning && !clarifyGateReady && !clarifyQuestions && !clarifyAwaitingInput && !pendingApproval}
              footer={
                <>
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
                    <ClarifyAnswerPanel
                      onSend={onSendClarifyAnswer}
                      onSkip={onSkipClarify}
                    />
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

// ── BlueprintPage ──

export default function BlueprintPage(_props: BlueprintPageProps): JSX.Element {
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
    currentTask,
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
    respondToApproval,
    sendClarifyAnswer,
    skipClarify,
    proceedClarifyGate,
    iterateClarify,
    retryPhase,
    loadPipelineStatus,
    phaseStartedAt,
    orphanedBlueprint
  } = useBlueprintStore()

  // ── Local state ──
  const [viewState, setViewState] = useState<ViewState>('landing')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<'P1' | 'P2' | 'P3'>('P2')

  // ── Load history + recover pipeline state on workspace change / app reopen ──
  useEffect(() => {
    if (workspaceId) {
      loadHistory(workspaceId)
      // Recovery: if the app was reopened mid-pipeline, restore currentPhase/isRunning
      loadPipelineStatus(workspaceId)
    }
    /* eslint-disable react-hooks/set-state-in-effect -- intentional reset on workspace identity change */
    setSelectedId(null)
    setViewState('landing')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [workspaceId, loadHistory, loadPipelineStatus])

  // ── Derive view state ──
  const effectiveView = getEffectiveView(viewState, isRunning, pendingApproval, selectedId)

  // ── Actions ──
  const handleStart = useCallback(async () => {
    if (!title.trim() || !workspaceId) return
    try {
      await startBlueprint({
        workspaceId,
        title: title.trim(),
        description: description.trim() || undefined,
        priority
      })
      setTitle('')
      setDescription('')
      setPriority('P2')
    } catch {
      // Error already logged in store
    }
  }, [title, description, priority, workspaceId, startBlueprint])

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
    },
    [loadBlueprint]
  )

  const handleBackFromDetail = useCallback(() => {
    setSelectedId(null)
    setViewState('landing')
  }, [])

  // Derive pipeline start time from first phase start timestamp
  const pipelineStartedAt = (() => {
    const timestamps = Object.values(phaseStartTimestamps).filter(Boolean) as number[]
    return timestamps.length > 0 ? Math.min(...timestamps) : phaseStartedAt
  })()

  // Active view goes full-bleed; landing/input/detail stay narrow for readability
  const isFullBleed = effectiveView === 'active'

  return (
    <div data-testid="blueprint-page" className={`flex flex-col h-full ${isFullBleed ? '' : 'overflow-y-auto'}`}>
      <div className={`w-full ${isFullBleed ? 'px-4 pt-4 pb-2 flex flex-col flex-1 min-h-0 gap-3' : 'p-6 space-y-6 max-w-3xl mx-auto'}`}>
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
                    {(
                      ['specify', 'plan', 'build', 'verify'] as const
                    ).map((phase) => {
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
                          <p className="text-xs text-text-secondary leading-relaxed">{config.description}</p>
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
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setViewState('input')}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-accent-muted hover:bg-accent/20 text-accent rounded-lg transition-colors"
                  >
                    <Plus size={14} />
                    New Blueprint
                  </button>
                </div>

                {/* BP-RESUME-02: Orphaned blueprint resume banner */}
                {orphanedBlueprint && (
                  <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5 text-amber-300">
                    <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                    <div className="flex flex-col gap-0.5 flex-1">
                      <span className="text-sm font-medium">
                        &ldquo;{orphanedBlueprint.title}&rdquo; was interrupted during {orphanedBlueprint.currentPhase}
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

                <div className="space-y-2">
                  {history.map((bp) => (
                    <BlueprintHistoryItem
                      key={bp.id}
                      blueprint={bp}
                      onSelect={() => handleSelectBlueprint(bp.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Input View ── */}
        {effectiveView === 'input' && (
          <div className="bg-surface-raised rounded-xl border border-border-subtle p-5 space-y-4">
            <h4 className="text-sm font-semibold text-text-primary">New Blueprint</h4>

            <div className="space-y-3">
              {/* Title */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Add user notification preferences page"
                  className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
                  autoFocus
                />
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">
                  Description <span className="text-text-muted">(optional)</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the feature in detail. Include requirements, constraints, and any relevant context..."
                  rows={4}
                  className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-accent resize-none"
                />
              </div>

              {/* Priority */}
              <div>
                <label className="text-xs font-medium text-text-secondary block mb-1">
                  Priority
                </label>
                <div className="flex gap-2">
                  {(['P1', 'P2', 'P3'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                        priority === p
                          ? 'bg-accent-muted text-accent border-accent/30'
                          : 'bg-surface-base text-text-secondary border-border-subtle hover:bg-surface-hover'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
              <button
                type="button"
                onClick={() => setViewState('landing')}
                className="text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleStart}
                disabled={!title.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold text-white bg-button-primary-bg hover:bg-button-primary-hover rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Start Pipeline
              </button>
            </div>
          </div>
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
            currentTask={currentTask}
            phaseCompletions={phaseCompletions}
            totalTaskCount={totalTaskCount}
            totalWaves={totalWaves}
            currentBlueprint={currentBlueprint}
            onApprove={handleApprove}
            onReject={handleReject}
            onCancel={handleCancel}
            onSendClarifyAnswer={(message, answers) => {
              if (currentBlueprint?.id && workspaceId) {
                sendClarifyAnswer(currentBlueprint.id, workspaceId, message, answers)
              }
            }}
            onSkipClarify={() => {
              if (currentBlueprint?.id) {
                skipClarify(currentBlueprint.id)
              }
            }}
            onProceedGate={() => {
              if (currentBlueprint?.id && workspaceId) {
                proceedClarifyGate(currentBlueprint.id, workspaceId)
              }
            }}
            onIterateClarify={() => {
              if (currentBlueprint?.id && workspaceId) {
                iterateClarify(currentBlueprint.id, workspaceId)
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
            onBack={handleBackFromDetail}
            onRetryPhase={() => {
              if (selectedId && workspaceId) {
                retryPhase(selectedId, workspaceId)
              }
            }}
          />
        )}
      </div>
    </div>
  )
}
