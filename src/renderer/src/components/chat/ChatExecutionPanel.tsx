/**
 * ChatExecutionPanel — collapsible right-side panel for chat task execution.
 *
 * Four tabs:
 *   - Plan: Structured plan JSON viewer from latest plan message
 *   - Tasks: Phase progress cards + task rows grouped by phase
 *   - History: Reverse-chronological list of all plan iterations
 *   - Memories: Session-captured memory facts for this conversation
 *
 * Replicates BlueprintExecutionPanel patterns: drag-resize, tab bar, wave
 * accordions with auto-open/close behavior.
 */

import { useState, useCallback, useMemo, useEffect, useRef, type JSX } from 'react'
import React from 'react'
import {
  ChevronDown,
  ChevronRight,
  ListTodo,
  FileText,
  History,
  Brain,
  CheckCircle2,
  XCircle,
  Loader2,
  GripVertical,
  X,
  Target,
  AlertTriangle
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useToastStore } from '@renderer/store/toast.store'
import {
  usePlanExecutionStore,
  type PlanExecution,
  type PhaseStatus,
  type TaskProgress
} from '@renderer/store/plan-execution.store'
import { useChatStore, useChatActions, useWorkspaceStore } from '@renderer/store'
import { useCouncilStore } from '@renderer/store/council.store'
import { PHASE_STATUS_ICON, statusDotColor } from './plan-status-icons'
import { remarkStripStrayBackticks } from './remark-plugins'
import { findPlanBlock, hasPlanBlock, hasBuildSummaryBlock } from './plan-detection'
import type { SectionKey } from './task-plan/TaskPlanSections'
import { BuildActionBar, usePlanMemos, buildSectionMap, isPlanLocked } from './task-plan'
import type { StructuredPlan, MemoryFact } from '../../../../shared/types'
import {
  derivePlanTasks,
  derivePhaseFiles,
  renderTaskManifest
} from '../../../../shared/plan-tasks'
import { modifierKey } from '@renderer/utils/platform'

// ── Constants ──────────────────────────────────────────────────────────────

const SECTION_SEQUENCE: SectionKey[] = [
  'title',
  'summary',
  'problemAnalysis',
  'rootCauses',
  'currentState',
  'decisions',
  'phases',
  'filesChanged',
  'filesInScope',
  'diagrams',
  'sections',
  'risks',
  'verification',
  'expectedOutcome',
  'deferredItems',
  'implementationOrder'
]

// ── Task Status Helpers ────────────────────────────────────────────────────

function taskStatusToPhaseKey(status: TaskProgress['status']): string {
  switch (status) {
    case 'running':
      return 'in_progress'
    case 'complete':
      return 'completed'
    default:
      return status
  }
}

// ── Task Row ───────────────────────────────────────────────────────────────

function TaskRow({ task }: { task: TaskProgress }): JSX.Element {
  const statusIcon =
    PHASE_STATUS_ICON[taskStatusToPhaseKey(task.status)] ?? PHASE_STATUS_ICON.pending
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-hover/30 transition-colors">
      <span className="flex-shrink-0">{statusIcon}</span>
      <span
        className={`flex-1 min-w-0 truncate ${
          task.status === 'complete'
            ? 'text-text-muted line-through'
            : task.status === 'running'
              ? 'text-text-body font-medium'
              : 'text-text-body'
        }`}
      >
        {task.title}
      </span>
      {task.files && task.files.length > 0 && (
        <span className="text-xs text-text-muted tabular-nums flex-shrink-0">
          {task.files.length} file{task.files.length !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  )
}

// ── Phase Accordion ────────────────────────────────────────────────────────

function PhaseAccordion({
  phase,
  defaultOpen = false
}: {
  phase: PhaseStatus
  defaultOpen?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const ref = useRef<HTMLDivElement>(null)

  const completedCount = phase.tasks.filter(
    (t) => t.status === 'complete' || t.status === 'skipped'
  ).length
  const hasRunning = phase.tasks.some((t) => t.status === 'running')
  const allComplete = completedCount === phase.tasks.length && phase.tasks.length > 0

  // Auto-open when tasks start running
  useEffect(() => {
    if (hasRunning && !open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(true)
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [hasRunning]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-collapse when all tasks complete
  useEffect(() => {
    if (allComplete && open) {
      const timer = setTimeout(() => setOpen(false), 2000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [allComplete]) // eslint-disable-line react-hooks/exhaustive-deps

  const progressColor = hasRunning ? 'text-info' : allComplete ? 'text-success' : 'text-text-muted'

  return (
    <div ref={ref} className="rounded-lg border border-border-subtle overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-surface-overlay hover:bg-surface-hover/50 transition-colors"
      >
        {open ? (
          <ChevronDown size={14} className="text-text-muted" />
        ) : (
          <ChevronRight size={14} className="text-text-muted" />
        )}
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotColor(phase.status)}`} />
        <span className="text-sm font-semibold text-text-primary truncate flex-1 text-left">
          {phase.phaseTitle}
        </span>
        {allComplete && <CheckCircle2 size={14} className="text-success flex-shrink-0" />}
        {phase.tasks.length > 0 && (
          <span className={`text-xs font-medium flex-shrink-0 ${progressColor}`}>
            {completedCount}/{phase.tasks.length}
          </span>
        )}
      </button>

      {/* Smooth expand/collapse */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-in-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden bg-surface-base">
          {phase.tasks.length > 0 ? (
            phase.tasks.map((task) => <TaskRow key={task.taskId} task={task} />)
          ) : (
            <div className="px-3 py-2 text-xs text-text-muted italic">
              {phase.status === 'completed'
                ? 'Phase completed'
                : (phase.message ?? 'No individual tasks tracked')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Phase Completion Card ──────────────────────────────────────────────────

function PhaseCompletionCard({ phase }: { phase: PhaseStatus }): JSX.Element {
  const completedTasks = phase.tasks.filter((t) => t.status === 'complete').length
  return (
    <div className="rounded-lg border border-success/20 bg-success/5 p-3 space-y-1">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={12} className="text-success" />
        <span className="text-xs font-semibold text-text-primary">
          Phase {phase.phaseId + 1}: {phase.phaseTitle}
        </span>
      </div>
      {phase.tasks.length > 0 && (
        <div className="text-[10px] text-text-muted">
          Tasks: {completedTasks}/{phase.tasks.length} completed
        </div>
      )}
      {phase.touchedFiles.length > 0 && (
        <div className="text-[10px] text-text-muted">
          Files: {phase.touchedFiles.length} touched
        </div>
      )}
    </div>
  )
}

// ── Goal Helpers ──────────────────────────────────────────────────────────

/** Derive a fallback goal from plan structure when no explicit goal exists. */
const MAX_DERIVED_GOAL_LENGTH = 3500

function deriveGoalFromPlan(plan: StructuredPlan): string {
  const parts: string[] = []
  if (plan.phases?.length) {
    parts.push(
      `Complete all ${plan.phases.length} phases: ${plan.phases.map((p) => p.title).join(', ')}`
    )
  }
  if (plan.verification?.length) {
    parts.push(`Verify: ${plan.verification.join('; ')}`)
  }
  if (plan.expectedOutcome) {
    parts.push(plan.expectedOutcome)
  }
  const result = parts.join('. ') || `Complete: ${plan.title}`
  return result.length > MAX_DERIVED_GOAL_LENGTH
    ? result.slice(0, MAX_DERIVED_GOAL_LENGTH - 1) + '…'
    : result
}

function GoalCard({
  goal,
  onChange,
  readOnly = false,
  originalGoal,
  onRegenerate,
  onReset
}: {
  goal: string
  onChange?: (goal: string) => void
  readOnly?: boolean
  originalGoal?: string
  onRegenerate?: () => void
  onReset?: () => void
}): JSX.Element {
  const isModified = !readOnly && originalGoal != null && goal.trim() !== originalGoal.trim()

  return (
    <div
      data-testid="goal-card"
      className={`rounded-lg border p-3 space-y-1.5 ${
        isModified
          ? 'border-amber-500/50 bg-amber-500/5'
          : 'border-border-subtle bg-surface-overlay'
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold text-text-muted uppercase tracking-wide">
        <Target size={12} />
        Goal
        {isModified && (
          <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[10px] font-medium normal-case tracking-normal">
            Modified
          </span>
        )}
      </div>
      {readOnly ? (
        <p className="text-sm text-text-body leading-relaxed whitespace-pre-wrap">{goal}</p>
      ) : (
        <textarea
          data-testid="goal-textarea"
          value={goal}
          onChange={(e) => onChange?.(e.target.value)}
          maxLength={4000}
          rows={4}
          className="w-full text-sm text-text-body bg-surface-base border border-border-subtle rounded-md px-2.5 py-2 resize-y min-h-[80px] leading-relaxed focus:outline-none focus:ring-1 focus:ring-accent/50 placeholder:text-text-muted/50"
          placeholder="Clear, measurable condition — what 'done' looks like..."
        />
      )}
      {!readOnly && goal.length > 3500 && (
        <span className="text-[10px] text-warning tabular-nums">{goal.length}/4000</span>
      )}
      {isModified && (
        <div className="flex items-center gap-2 pt-0.5">
          <p className="text-[11px] text-amber-400/80 flex-1">
            Goal changed — plan phases may not align.
          </p>
          {onReset && (
            <button
              type="button"
              onClick={onReset}
              className="text-[11px] text-text-muted hover:text-text-body transition-colors"
            >
              Reset
            </button>
          )}
          {onRegenerate && (
            <button
              type="button"
              data-testid="goal-regenerate-plan"
              onClick={onRegenerate}
              className="text-[11px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 transition-colors font-medium"
            >
              Regenerate Plan
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Plan Tab Content ───────────────────────────────────────────────────────

/**
 * Shown when the plan block is JSON that failed to parse — a truncated or
 * malformed emit_plan payload. Previously this dumped the whole raw string
 * through ReactMarkdown, filling the panel with unreadable JSON.
 */
function UnparseablePlanCard({ planContent }: { planContent: string }): JSX.Element {
  const [showRaw, setShowRaw] = useState(false)
  return (
    <div className="rounded-md border border-border-subtle bg-surface-raised p-3 space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
        <div className="text-xs text-text-secondary">
          <div className="text-text-primary font-medium">This plan could not be parsed</div>
          The plan block was cut short or is malformed. Ask the agent to re-emit it.
        </div>
      </div>
      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        className="text-xs text-text-tertiary hover:text-text-primary"
      >
        {showRaw ? 'Hide' : 'Show'} raw content ({planContent.length.toLocaleString()} chars)
      </button>
      {showRaw && (
        <pre className="max-h-64 overflow-auto text-[10px] leading-tight text-text-tertiary whitespace-pre-wrap break-all">
          {planContent}
        </pre>
      )}
    </div>
  )
}

function PlanTabContent({
  planContent,
  conversationId
}: {
  planContent: string | null
  conversationId: string
}): JSX.Element {
  const { sendMessage, updateMode, appendLocalMessage } = useChatActions()

  const activeMode = useChatStore((s) => s.activeConversation?.mode)
  const isCurrentlyStreaming = useChatStore((s) => s.isStreaming)

  // Whether execution has actually started for this conversation. This is the
  // precise signal the BuildActionBar needs — mode was only ever a proxy for it,
  // and gating on `activeMode === 'plan'` also hid the bar in build mode, where
  // the Plan tab itself stays visible.
  const execution = usePlanExecutionStore(
    useCallback(
      (s: { executions: Record<string, PlanExecution> }) => s.executions[conversationId],
      [conversationId]
    )
  )

  // BUG-HINT-BAR-FIX: Debounce the retry hint bar by 2 seconds.
  // Between build phases, isStreaming is briefly false (50-200ms) while the
  // agent transitions between tasks — causing the hint bar to flash.
  // Only show the hint after the build has been truly idle for 2 seconds.
  const [retryHintStable, setRetryHintStable] = useState(false)
  useEffect(() => {
    if (activeMode === 'build' && !isCurrentlyStreaming) {
      const timer = setTimeout(() => setRetryHintStable(true), 2000)
      return () => clearTimeout(timer)
    }
    setRetryHintStable(false)
    return undefined
  }, [activeMode, isCurrentlyStreaming])

  // A build that left a phase 'in_progress' must not lock the NEXT plan forever.
  // 2s of genuine idle distinguishes "build finished/interrupted" from the
  // 50-200ms inter-phase gaps where isStreaming drops.
  const [buildIdleStable, setBuildIdleStable] = useState(false)
  useEffect(() => {
    if (!isCurrentlyStreaming) {
      const timer = setTimeout(() => setBuildIdleStable(true), 2000)
      return () => clearTimeout(timer)
    }
    setBuildIdleStable(false)
    return undefined
  }, [isCurrentlyStreaming])

  // Parse structured plan
  const structuredPlan = useMemo<StructuredPlan | null>(() => {
    if (!planContent) return null
    try {
      const parsed = JSON.parse(planContent)
      if (parsed && typeof parsed === 'object' && typeof parsed.title === 'string') {
        return parsed as StructuredPlan
      }
      return null
    } catch {
      return null
    }
  }, [planContent])

  const planMemos = usePlanMemos(structuredPlan)
  const isSimplePlan = !structuredPlan?.phases?.length
  const sectionMap = useMemo(
    () => buildSectionMap({ structuredPlan, ...planMemos, isSimplePlan, conversationId }),
    [structuredPlan, planMemos, isSimplePlan, conversationId]
  )

  // Check if action already taken for this plan
  const messages = useChatStore((s) => s.messages)
  const latestPlanMsg = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (
        messages[i].role !== 'user' &&
        messages[i].contentMd &&
        hasPlanBlock(messages[i].contentMd) &&
        !hasBuildSummaryBlock(messages[i].contentMd)
      ) {
        return messages[i]
      }
    }
    return null
  }, [messages])

  const planActionTaken = latestPlanMsg?.planAction

  // Hide the action bar / lock the goal card when this specific plan has been
  // actioned, or a build is actively running. See build-bar-visibility.ts for
  // why neither `activeMode` nor `!!execution` is the right signal.
  const planLocked = isPlanLocked({
    planAction: planActionTaken,
    execution,
    buildIdle: buildIdleStable
  })

  // Goal state: user edit → plan's goal → derived fallback
  const [editedGoal, setEditedGoal] = useState<string | null>(null)
  const effectiveGoal = useMemo(
    () =>
      editedGoal ??
      structuredPlan?.goal ??
      (structuredPlan ? deriveGoalFromPlan(structuredPlan) : ''),
    [editedGoal, structuredPlan]
  )

  // Original goal reference for modification detection
  const originalGoal = useMemo(
    () => structuredPlan?.goal ?? (structuredPlan ? deriveGoalFromPlan(structuredPlan) : ''),
    [structuredPlan]
  )

  // Reset the edited goal when a new plan message is detected. Button
  // visibility is no longer reset here — it is derived from the execution
  // record, which is what stopped a mid-build `emit_plan` from re-showing
  // "Build Now".
  useEffect(() => {
    setEditedGoal(null)
  }, [latestPlanMsg?.id])

  const handleBuildNow = useCallback((): void => {
    if (latestPlanMsg && !latestPlanMsg.planAction) {
      useChatStore.setState((state) => ({
        messages: state.messages.map((m) =>
          m.id === latestPlanMsg.id ? { ...m, planAction: 'build' } : m
        )
      }))
      window.api
        .chatSetPlanAction({ messageId: latestPlanMsg.id, action: 'build' })
        .catch(console.error)
    }

    // Initialize plan execution tracking. derivePlanTasks/derivePhaseFiles are the
    // SAME helpers used to render the task manifest sent to the model below —
    // this is what makes agent-reported taskIds actually match what the UI tracks.
    // Always create an execution record — including phase-less plans. The record
    // is the single "execution has started" signal the action bar gates on, so
    // skipping it for a simple plan would leave "Build Now" visible for the
    // whole build. A zero-phase record is safe: TaskSummaryBadge guards on
    // totalPhases > 0, and updatePhase raises totalPhases if the agent later
    // reports real phases via emit_phase_progress.
    const { startExecution } = usePlanExecutionStore.getState()
    startExecution(conversationId, {
      planId: null,
      title: structuredPlan?.title ?? 'Plan',
      planGoal: effectiveGoal || undefined,
      phases: structuredPlan?.phases?.length ? derivePlanTasks(structuredPlan) : [],
      phaseFiles: structuredPlan?.phases?.length ? derivePhaseFiles(structuredPlan) : undefined
    })
    // Backfill the DB-persisted plan ID (the plan row was written when
    // emit_plan fired, before this button existed) — fire-and-forget so
    // Build Now isn't blocked on an IPC round-trip. Without this, exec.planId
    // stays null for the whole live session and memory extraction on
    // completion can't tell this execution is DB-backed.
    window.api
      .getPhaseProgress({ conversationId })
      .then((phaseData) => {
        if (phaseData?.planId) {
          usePlanExecutionStore.getState().setPlanId(conversationId, phaseData.planId)
        }
      })
      .catch(() => {})

    void updateMode('build')

    // Build the kickoff message with an explicit task manifest so the model
    // reports emit_phase_progress taskId/taskStatus against the SAME taskIds
    // the panel already created via startExecution above — without this the
    // model invents its own IDs (or skips task-level reporting entirely) and
    // task rows never update.
    const manifest = structuredPlan?.phases?.length ? renderTaskManifest(structuredPlan) : ''
    const buildKickoffMessage = manifest
      ? [
          'Build the plan. Report phase progress using emit_phase_progress as you work through each phase.',
          '',
          'Task manifest — use these EXACT taskId values when reporting taskId/taskTitle/taskStatus ' +
            '(call with taskStatus "running" before starting a task and "complete"/"failed" after):',
          manifest
        ].join('\n')
      : 'Build the plan. Report phase progress using emit_phase_progress as you work through each phase.'

    // Set goal on adapter before sending (enforce mode for autonomous execution)
    const goalToEnforce = effectiveGoal?.trim()
    if (goalToEnforce) {
      window.api
        .chatSetGoal({
          conversationId,
          goal: goalToEnforce,
          goalMode: 'enforce'
        })
        .then(() => {
          void sendMessage(buildKickoffMessage, undefined, { hidden: true, skipOptimizer: true })
        })
        .catch((err) => {
          console.error('[plan] Failed to set goal, sending without enforcement:', err)
          void sendMessage(buildKickoffMessage, undefined, { hidden: true, skipOptimizer: true })
        })
    } else {
      // No goal — send without enforcement (backward compat)
      void sendMessage(buildKickoffMessage, undefined, { hidden: true, skipOptimizer: true })
    }
  }, [conversationId, structuredPlan, effectiveGoal, latestPlanMsg, sendMessage, updateMode])

  const handleRefine = useCallback((): void => {
    if (latestPlanMsg && !latestPlanMsg.planAction) {
      useChatStore.setState((state) => ({
        messages: state.messages.map((m) =>
          m.id === latestPlanMsg.id ? { ...m, planAction: 'refine' } : m
        )
      }))
      window.api
        .chatSetPlanAction({ messageId: latestPlanMsg.id, action: 'refine' })
        .catch(console.error)
    }
    appendLocalMessage("Refine this plan — tell me what to change and I'll update it.")
  }, [latestPlanMsg, appendLocalMessage])

  const handleSaveAsIdea = useCallback((): void => {
    if (latestPlanMsg && !latestPlanMsg.planAction) {
      useChatStore.setState((state) => ({
        messages: state.messages.map((m) =>
          m.id === latestPlanMsg.id ? { ...m, planAction: 'save_as_idea' } : m
        )
      }))
      window.api
        .chatSetPlanAction({ messageId: latestPlanMsg.id, action: 'save_as_idea' })
        .catch(console.error)
    }
    const title = structuredPlan?.title ?? 'Implementation Plan'
    const description = planContent ?? ''
    const workspaceId = useWorkspaceStore.getState().activeWorkspace?.id
    if (workspaceId) {
      window.api
        .createIdea({ workspaceId, title, description })
        .then(() => {
          useToastStore.getState().addToast({
            type: 'success',
            message: `Saved "${title}" as an idea`
          })
        })
        .catch(console.error)
    }
  }, [latestPlanMsg, structuredPlan, planContent])

  const handleResetGoal = useCallback((): void => {
    setEditedGoal(null)
  }, [])

  const handleRegeneratePlan = useCallback((): void => {
    const {
      isStreaming,
      sendingConversationIds,
      activeConversation: conv
    } = useChatStore.getState()
    if (isStreaming || sendingConversationIds.has(conv?.id ?? '')) {
      useToastStore.getState().addToast({
        type: 'info',
        message: 'Chat is busy — wait for the current response to finish'
      })
      return
    }

    // Mark current plan as refined
    if (latestPlanMsg && !latestPlanMsg.planAction) {
      useChatStore.setState((state) => ({
        messages: state.messages.map((m) =>
          m.id === latestPlanMsg.id ? { ...m, planAction: 'refine' } : m
        )
      }))
      window.api
        .chatSetPlanAction({ messageId: latestPlanMsg.id, action: 'refine' })
        .catch(console.error)
    }

    void sendMessage(
      `I've updated the goal to:\n\n${effectiveGoal}\n\n` +
        'Regenerate the plan to achieve this updated goal. ' +
        "Include the new goal in the plan's `goal` field. " +
        'Output the updated plan in a ```plan``` block.',
      undefined,
      { hidden: true, skipOptimizer: true }
    )
  }, [effectiveGoal, latestPlanMsg, sendMessage])

  const handleCouncilReview = useCallback((): void => {
    if (!planContent) return
    if (latestPlanMsg && !latestPlanMsg.planAction) {
      useChatStore.setState((state) => ({
        messages: state.messages.map((m) =>
          m.id === latestPlanMsg.id ? { ...m, planAction: 'council' } : m
        )
      }))
      window.api
        .chatSetPlanAction({ messageId: latestPlanMsg.id, action: 'council' })
        .catch(console.error)
    }
    const workspaceId = useWorkspaceStore.getState().activeWorkspace?.id
    if (!workspaceId) return
    const councilStore = useCouncilStore.getState()
    councilStore.startCouncil()
    window.api
      .councilStart({
        workspaceId,
        inputType: 'plan',
        planContent,
        structuredPlan: structuredPlan
          ? { ...structuredPlan, goal: effectiveGoal || structuredPlan.goal }
          : undefined,
        originalUserRequest: latestPlanMsg?.contentMd ?? '',
        conversationId
      })
      .then(({ sessionId }: { sessionId: string }) => {
        councilStore.setSessionIdentity(sessionId, workspaceId)
        councilStore.setOriginConversationId(conversationId)
      })
      .catch((err) => {
        console.error('[council-review] Failed to start council:', err)
        councilStore.reset()
        useToastStore.getState().addToast({
          type: 'error',
          message: 'Failed to start council review'
        })
      })
  }, [planContent, structuredPlan, effectiveGoal, latestPlanMsg, conversationId])

  if (!planContent) {
    return (
      <div className="text-center py-12">
        <FileText size={24} className="text-text-muted mx-auto mb-2" />
        <p className="text-sm text-text-secondary mb-1">No plan yet</p>
        <p className="text-xs text-text-muted max-w-[220px] mx-auto">
          A plan will appear here when the agent generates one.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Goal card — editable before build, read-only after */}
      {structuredPlan && effectiveGoal && (
        <GoalCard
          goal={effectiveGoal}
          onChange={planLocked ? undefined : setEditedGoal}
          readOnly={planLocked}
          originalGoal={originalGoal}
          onRegenerate={planLocked ? undefined : handleRegeneratePlan}
          onReset={planLocked ? undefined : handleResetGoal}
        />
      )}

      {/* Plan content. Markdown plans are legitimate (hand-written blocks), so
          the fallback keys off shape: JSON that didn't parse is a defect, not
          content — dumping 20K of raw JSON into the panel helps nobody. */}
      {structuredPlan ? (
        <div className="space-y-3">
          {SECTION_SEQUENCE.map((key) => (
            <React.Fragment key={key}>{sectionMap[key]}</React.Fragment>
          ))}
        </div>
      ) : planContent.trimStart().startsWith('{') ? (
        <UnparseablePlanCard planContent={planContent} />
      ) : (
        <div className="prose prose-sm prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>
            {planContent}
          </ReactMarkdown>
        </div>
      )}

      {/* Action bar — after content so sticky bottom-0 works correctly.
         Gated on whether this plan was actioned / a build is running rather than
         on conversation mode: the bar stays available in build mode (where the
         Plan tab is already visible) and disappears the moment execution starts.
         `buildRunning` is what keeps it hidden across the 50-200ms gaps where
         isStreaming drops between phases, including after a mid-build emit_plan
         replaces latestPlanMsg. */}
      {!planLocked && !isCurrentlyStreaming && (
        <BuildActionBar
          onBuildNow={handleBuildNow}
          onRefine={handleRefine}
          onSaveAsIdea={handleSaveAsIdea}
          onCouncilReview={handleCouncilReview}
          savedToPlans
        />
      )}
      {/* Hint bar when build finished/failed — guide user back to plan mode to retry.
         BUG-HINT-BAR-FIX: Uses debounced `retryHintStable` to prevent 50-200ms flash
         between build phases when isStreaming is briefly false.
         BUG-PLATFORM-KEY-FIX: Uses platform-detected modifier key. */}
      {retryHintStable && (
        <div
          data-testid="task-plan-retry-hint"
          className="sticky bottom-0 flex items-center gap-2 px-5 py-2.5 border-t border-border-subtle bg-surface-overlay/90 backdrop-blur-sm text-xs text-text-secondary"
        >
          <span>Press</span>
          <kbd className="px-1.5 py-0.5 rounded bg-surface-float border border-border-subtle font-mono text-[11px] text-text-muted">
            {modifierKey}.
          </kbd>
          <span>to switch to Plan mode and retry the build</span>
        </div>
      )}
    </div>
  )
}

// ── Completed Plan Banner ─────────────────────────────────────────────────────

function formatExecutionDuration(startMs: number, endMs: number): string {
  const secs = Math.floor((endMs - startMs) / 1000)
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  const s = secs % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}

function CompletedPlanBanner({
  execution,
  onDismiss
}: {
  execution: PlanExecution
  onDismiss: () => void
}): JSX.Element {
  const completedPhases = execution.phases.filter((p) => p.status === 'completed').length
  const failedPhases = execution.phases.filter((p) => p.status === 'failed').length
  const allFailed =
    execution.phases.length > 0 && execution.phases.every((p) => p.status === 'failed')

  // Compute duration from in-memory timestamps
  const durationStr = execution.completedAt
    ? formatExecutionDuration(execution.startedAt, execution.completedAt)
    : null

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle text-xs flex-shrink-0 ${
        allFailed ? 'bg-error/5' : 'bg-success/5'
      }`}
    >
      {allFailed ? (
        <XCircle size={12} className="text-error" />
      ) : (
        <CheckCircle2 size={12} className="text-success" />
      )}
      <span className="text-text-primary font-medium">Execution complete</span>
      <span className="text-text-muted">
        {completedPhases}/{execution.totalPhases} phases
        {failedPhases > 0 && <span className="text-error ml-1">({failedPhases} failed)</span>}
      </span>
      {durationStr && <span className="text-text-muted">· {durationStr}</span>}
      {execution.planGoal && (
        <span className="text-text-muted truncate max-w-[200px]" title={execution.planGoal}>
          🎯{' '}
          {execution.planGoal.length > 50
            ? execution.planGoal.slice(0, 47) + '...'
            : execution.planGoal}
        </span>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="ml-auto p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
        title="Dismiss"
        aria-label="Dismiss execution"
      >
        <X size={12} />
      </button>
    </div>
  )
}

// ── Plan History Tab ─────────────────────────────────────────────────────────

function PlanHistoryTab({
  conversationId: _conversationId
}: {
  conversationId: string
}): JSX.Element {
  const messages = useChatStore((s) => s.messages)

  const planMessages = useMemo(() => {
    return messages
      .filter(
        (m) =>
          m.role !== 'user' &&
          m.contentMd &&
          hasPlanBlock(m.contentMd) &&
          !hasBuildSummaryBlock(m.contentMd)
      )
      .map((m) => {
        const block = findPlanBlock(m.contentMd)
        let title = 'Plan'
        if (block?.content) {
          try {
            const parsed = JSON.parse(block.content)
            if (parsed.title) title = parsed.title
          } catch {
            /* use default */
          }
        }
        return {
          id: m.id,
          title,
          timestamp: m.createdAt,
          action: m.planAction ?? null
        }
      })
      .reverse() // newest first
  }, [messages])

  if (planMessages.length === 0) {
    return (
      <div className="text-center py-12">
        <History size={24} className="text-text-muted mx-auto mb-2" />
        <p className="text-sm text-text-secondary mb-1">No plan history</p>
        <p className="text-xs text-text-muted max-w-[220px] mx-auto">
          Plan iterations will appear here as the agent generates them.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {planMessages.map((plan, i) => (
        <div key={plan.id} className="rounded-lg border border-border-subtle p-3 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text-primary truncate">{plan.title}</span>
            {i === 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary-text">
                Latest
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span>{new Date(plan.timestamp).toLocaleTimeString()}</span>
            {plan.action && (
              <span className="px-1.5 py-0.5 rounded bg-surface-overlay text-text-secondary capitalize">
                {plan.action.replace('_', ' ')}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Session Memories Tab ─────────────────────────────────────────────────────

function SessionMemoriesTab({ conversationId }: { conversationId: string }): JSX.Element {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspace?.id)
  const [memories, setMemories] = useState<MemoryFact[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!workspaceId) {
      setLoading(false)
      return
    }
    setLoading(true)
    window.api
      .memoryFactsList({ workspaceId })
      .then((facts) => {
        setMemories(facts.filter((f) => f.sourceRef === conversationId))
      })
      .catch(() => setMemories([]))
      .finally(() => setLoading(false))
  }, [workspaceId, conversationId])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 size={20} className="animate-spin text-text-muted" />
      </div>
    )
  }

  if (memories.length === 0) {
    return (
      <div className="text-center py-12">
        <Brain size={24} className="text-text-muted mx-auto mb-2" />
        <p className="text-sm text-text-secondary mb-1">No memories yet</p>
        <p className="text-xs text-text-muted max-w-[220px] mx-auto">
          Memories captured by the agent during this chat will appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {memories.map((fact) => (
        <div key={fact.id} className="rounded-lg border border-border-subtle p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text-primary">{fact.title}</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                fact.tier >= 2 ? 'bg-success/20 text-success' : 'bg-surface-overlay text-text-muted'
              }`}
            >
              T{fact.tier}
            </span>
          </div>
          <p className="text-xs text-text-body leading-relaxed line-clamp-3">{fact.content}</p>
          <div className="flex items-center gap-2 text-[10px] text-text-muted">
            <span className="capitalize">{fact.category}</span>
            <span>·</span>
            <span>{new Date(fact.createdAt).toLocaleTimeString()}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Main Panel ─────────────────────────────────────────────────────────────

type PanelTab = 'tasks' | 'plan' | 'history' | 'memories'

interface ChatExecutionPanelProps {
  conversationId: string
  onResize?: (width: number) => void
  initialTab?: PanelTab
  onClose?: () => void
}

export default function ChatExecutionPanel({
  conversationId,
  onResize,
  initialTab,
  onClose
}: ChatExecutionPanelProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<PanelTab>(initialTab ?? 'plan')

  // ── Data sources (ALL hooks called unconditionally) ──
  const selectExecution = useCallback(
    (s: { executions: Record<string, PlanExecution> }) => s.executions[conversationId],
    [conversationId]
  )
  const execution = usePlanExecutionStore(selectExecution)

  const planContent = usePlanExecutionStore(
    useCallback(
      (s: { latestPlanContent: Record<string, string> }) =>
        s.latestPlanContent[conversationId] ?? null,
      [conversationId]
    )
  )

  // ── Resize drag handle ──
  const dragListenersRef = useRef<{ move: (ev: MouseEvent) => void; up: () => void } | null>(null)

  useEffect(() => {
    return () => {
      if (dragListenersRef.current) {
        window.removeEventListener('mousemove', dragListenersRef.current.move)
        window.removeEventListener('mouseup', dragListenersRef.current.up)
        dragListenersRef.current = null
      }
    }
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!onResize) return
      e.preventDefault()
      const startX = e.clientX
      const panel = (e.target as HTMLElement).closest('[data-panel-root]') as HTMLElement | null
      const startWidth = panel?.offsetWidth ?? 320

      const onMouseMove = (ev: MouseEvent): void => {
        const delta = startX - ev.clientX
        const newWidth = Math.min(800, Math.max(280, startWidth + delta))
        onResize(newWidth)
      }
      const onMouseUp = (): void => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        dragListenersRef.current = null
      }
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
      dragListenersRef.current = { move: onMouseMove, up: onMouseUp }
    },
    [onResize]
  )

  // ── Stats ──
  const allTasks = execution?.phases.flatMap((p) => p.tasks) ?? []
  const totalDone = allTasks.filter((t) => t.status === 'complete' || t.status === 'skipped').length
  // Plan history count for tab badge
  const messages = useChatStore((s) => s.messages)
  const planMessageCount = useMemo(() => {
    return messages.filter(
      (m) =>
        m.role !== 'user' &&
        m.contentMd &&
        hasPlanBlock(m.contentMd) &&
        !hasBuildSummaryBlock(m.contentMd)
    ).length
  }, [messages])

  // Completed phases for completion cards
  const completedPhases = execution?.phases.filter((p) => p.status === 'completed') ?? []

  return (
    <div
      data-panel-root
      data-testid="chat-execution-panel"
      className="flex flex-col h-full min-h-0 bg-surface-base border-l border-border-subtle relative"
    >
      {/* Completion banner — above tabs, does NOT replace them */}
      {execution?.completedAt && (
        <CompletedPlanBanner
          execution={execution}
          onDismiss={() => {
            usePlanExecutionStore.getState().dismissExecution(conversationId)
            onClose?.()
          }}
        />
      )}

      {/* Drag handle */}
      {onResize && (
        <div
          onMouseDown={handleMouseDown}
          className="absolute left-0 top-0 bottom-0 w-3 cursor-col-resize z-10 flex items-center justify-center hover:bg-accent/20 transition-colors group"
          title="Drag to resize"
        >
          <GripVertical
            size={12}
            className="text-text-muted/30 group-hover:text-text-muted transition-colors"
          />
        </div>
      )}

      {/* Tab bar */}
      <div
        role="tablist"
        aria-label="Execution panel tabs"
        className="flex border-b border-border-subtle px-2 pt-2 gap-1 flex-shrink-0"
      >
        <button
          type="button"
          role="tab"
          id="exec-tab-plan"
          aria-selected={activeTab === 'plan'}
          data-testid="chat-execution-tab-plan"
          onClick={() => setActiveTab('plan')}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors ${
            activeTab === 'plan'
              ? 'bg-surface-raised text-text-primary border border-border-subtle border-b-transparent -mb-px'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          <FileText size={14} />
          Plan
          {planContent && (
            <span
              className={`w-2 h-2 rounded-full bg-plan-card flex-shrink-0${activeTab !== 'plan' ? ' animate-pulse' : ''}`}
            />
          )}
        </button>
        <button
          type="button"
          role="tab"
          id="exec-tab-tasks"
          aria-selected={activeTab === 'tasks'}
          data-testid="chat-execution-tab-tasks"
          onClick={() => setActiveTab('tasks')}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors ${
            activeTab === 'tasks'
              ? 'bg-surface-raised text-text-primary border border-border-subtle border-b-transparent -mb-px'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          <ListTodo size={14} />
          Tasks
          {allTasks.length > 0 && (
            <span className="text-[11px] font-mono text-text-muted">
              {totalDone}/{allTasks.length}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          id="exec-tab-history"
          aria-selected={activeTab === 'history'}
          data-testid="chat-execution-tab-history"
          onClick={() => setActiveTab('history')}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors ${
            activeTab === 'history'
              ? 'bg-surface-raised text-text-primary border border-border-subtle border-b-transparent -mb-px'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          <History size={14} />
          History
          {planMessageCount > 0 && (
            <span className="text-[11px] font-mono text-text-muted">{planMessageCount}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          id="exec-tab-memories"
          aria-selected={activeTab === 'memories'}
          data-testid="chat-execution-tab-memories"
          onClick={() => setActiveTab('memories')}
          className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg transition-colors ${
            activeTab === 'memories'
              ? 'bg-surface-raised text-text-primary border border-border-subtle border-b-transparent -mb-px'
              : 'text-text-muted hover:text-text-secondary'
          }`}
        >
          <Brain size={14} />
          Memories
        </button>

        {/* Close button — pushed to right */}
        {onClose && (
          <button
            type="button"
            data-testid="chat-execution-panel-close"
            aria-label="Close execution panel"
            onClick={onClose}
            className="ml-auto flex items-center justify-center w-7 h-7 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
            title="Close panel"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Content */}
      <div
        role="tabpanel"
        id={`exec-tabpanel-${activeTab}`}
        aria-labelledby={`exec-tab-${activeTab}`}
        className="flex-1 overflow-y-auto min-h-0 p-3 space-y-2"
      >
        {/* ── Tasks tab ── */}
        {activeTab === 'tasks' && (
          <>
            {/* Phase completion cards (completed phases) */}
            {completedPhases.map((phase) => (
              <PhaseCompletionCard key={phase.phaseId} phase={phase} />
            ))}

            {/* Phase accordions (active + pending) */}
            {execution && execution.phases.length > 0 ? (
              execution.phases
                .filter((p) => p.status !== 'completed')
                .map((phase) => (
                  <PhaseAccordion
                    key={phase.phaseId}
                    phase={phase}
                    defaultOpen={phase.status === 'started' || phase.status === 'in_progress'}
                  />
                ))
            ) : (
              <div className="text-center py-12">
                <div className="w-12 h-12 rounded-full bg-surface-inset mx-auto mb-3 flex items-center justify-center">
                  <ListTodo size={20} className="text-text-muted" />
                </div>
                <p className="text-sm font-medium text-text-secondary mb-1">No tasks yet</p>
                <p className="text-xs text-text-muted max-w-[220px] mx-auto">
                  Tasks will appear here when execution starts.
                </p>
              </div>
            )}

            {/* Status legend */}
            {allTasks.length > 0 && (
              <div className="flex items-center gap-3 pt-2 border-t border-border-subtle/50">
                <span className="flex items-center gap-1 text-xs text-text-muted">
                  <Loader2 size={12} className="animate-spin text-info" /> running
                </span>
                <span className="flex items-center gap-1 text-xs text-text-muted">
                  <CheckCircle2 size={12} className="text-success" /> done
                </span>
                <span className="flex items-center gap-1 text-xs text-text-muted">
                  <XCircle size={12} className="text-danger" /> failed
                </span>
              </div>
            )}
          </>
        )}

        {/* ── Plan tab ── */}
        {activeTab === 'plan' && (
          <PlanTabContent planContent={planContent} conversationId={conversationId} />
        )}

        {/* ── History tab ── */}
        {activeTab === 'history' && <PlanHistoryTab conversationId={conversationId} />}

        {/* ── Memories tab ── */}
        {activeTab === 'memories' && <SessionMemoriesTab conversationId={conversationId} />}
      </div>
    </div>
  )
}
