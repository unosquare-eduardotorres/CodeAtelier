/**
 * CreateProjectWizard — full-screen 4-step wizard for creating a new project.
 *
 * Steps:
 *   1. Setup — name, folder, description, attachments
 *   2. Focus Areas — multi-select greenfield grill tracks (≥1 required)
 *   3. Grill — auto-advances through selected tracks with context carry-over
 *   4. Create — review decisions, finalize blueprint, choose a destination
 *
 * The workspace is created EARLY (at the end of Focus, before Grill) so the
 * greenfield grill runs workspace-backed and can hand off to Chat / Goals /
 * Council exactly like the regular Grill Me. CLAUDE.md generation is deferred
 * to the final step (so grill decisions are folded in), and an abandoned shell
 * is discarded (DB cascade + on-disk folder).
 */

import { useState, useCallback, useRef } from 'react'
import { X, Circle, CheckCircle2 } from 'lucide-react'
import { ConfirmDialog } from '@renderer/components/common'
import { useMpaStore } from '@renderer/store/mpa.store'
import { useCouncilStore } from '@renderer/store/council.store'
import { useChatStore } from '@renderer/store/chat.store'
import type { GrillDecision, GrillTrackId, GrillTrackScore } from '../../../../shared/types'
import { GREENFIELD_DEFAULT_TRACKS } from '../../../../shared/constants'
import WizardSetupStep from './wizard/WizardSetupStep'
import WizardFocusStep from './wizard/WizardFocusStep'
import WizardGrillStep from './wizard/WizardGrillStep'
import WizardSummaryStep from './wizard/WizardSummaryStep'

// ── Types ─────────────────────────────────────────────────────────────────

/** Where the user lands after the project is created. */
export type ProjectDestination = 'chat' | 'goals' | 'council'

interface CreateProjectWizardProps {
  onClose: () => void
  onCreated: (workspaceId: string, destination?: ProjectDestination) => void
}

type WizardStep = 'setup' | 'focus' | 'grill' | 'create'

const STEP_ORDER: WizardStep[] = ['setup', 'focus', 'grill', 'create']

const STEP_LABELS: Record<WizardStep, string> = {
  setup: 'Setup',
  focus: 'Focus',
  grill: 'Grill',
  create: 'Create'
}

const isMac = navigator.platform.toUpperCase().includes('MAC')

// ── Helpers ───────────────────────────────────────────────────────────────

/** Visible notice prepended to the requirement when LLM plan synthesis is
 *  unavailable, so the degraded handoff is never mistaken for a real plan. */
const DEGRADED_PLAN_NOTICE =
  '> ⚠️ Couldn’t synthesize a full plan automatically — using your decisions as constraints below. Review and refine this before generating goals.'

/** Build a plan-skeleton requirement document (Summary / Objectives /
 *  Constraints) from the project + grill decisions. Used as the goal/plan
 *  content when handing off to Goals or Council, and as the fallback when LLM
 *  plan synthesis is unavailable — a skeleton plan reads far better than a bare
 *  Q&A list. */
function buildRequirementDoc(
  name: string,
  description: string,
  decisions: GrillDecision[]
): string {
  const trimmedName = name.trim()
  const lines: string[] = [`# ${trimmedName}`, '']

  lines.push('## Summary', '')
  lines.push(description.trim() || `Greenfield project “${trimmedName}”.`, '')

  lines.push('## Objectives', '')
  lines.push(`- Deliver ${trimmedName} as described, satisfying the constraints below.`, '')

  if (decisions.length > 0) {
    lines.push('## Constraints', '')
    for (const d of decisions) {
      const opt = d.selectedOption + (d.otherText ? ` (${d.otherText})` : '')
      lines.push(`- **${d.questionText}**: ${opt}`)
    }
  }
  return lines.join('\n').trim()
}

// ── Step indicator (rendered inside content area) ────────────────────────

function WizardStepIndicator({
  currentStep,
  onGoToStep,
  lockSetup
}: {
  currentStep: WizardStep
  onGoToStep: (step: WizardStep) => void
  lockSetup: boolean
}): React.JSX.Element {
  const currentStepIndex = STEP_ORDER.indexOf(currentStep)

  return (
    <div className="flex items-center justify-center gap-2 py-6">
      {STEP_ORDER.map((step, idx) => {
        const isActive = step === currentStep
        const isDone = idx < currentStepIndex
        // Once the workspace shell exists, name/folder are fixed on disk — lock Setup.
        const isLocked = step === 'setup' && lockSetup
        const canNavigate = idx < currentStepIndex && !isLocked
        return (
          <div key={step} className="flex items-center gap-1.5">
            {idx > 0 && (
              <div className={`w-8 h-px ${isDone ? 'bg-primary' : 'bg-border-subtle'}`} />
            )}
            <button
              type="button"
              onClick={() => {
                if (canNavigate) onGoToStep(step)
              }}
              disabled={!canNavigate}
              title={isLocked ? 'Name & folder are fixed once the project is created' : undefined}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                isActive
                  ? 'text-primary-text bg-primary-muted'
                  : canNavigate
                    ? 'text-text-primary hover:bg-surface-overlay cursor-pointer'
                    : 'text-text-muted cursor-default'
              }`}
            >
              {isDone ? (
                <CheckCircle2 size={14} className="text-primary-text" />
              ) : (
                <Circle size={14} className={isActive ? 'text-primary-text' : 'text-text-muted'} />
              )}
              {STEP_LABELS[step]}
            </button>
          </div>
        )
      })}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────

export default function CreateProjectWizard({
  onClose,
  onCreated
}: CreateProjectWizardProps): React.JSX.Element {
  // ── Step state ──
  const [currentStep, setCurrentStep] = useState<WizardStep>('setup')

  // ── Wizard data ──
  const [projectName, setProjectName] = useState('')
  const [parentFolder, setParentFolder] = useState('')
  const [description, setDescription] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [selectedTracks, setSelectedTracks] = useState<GrillTrackId[]>([
    ...GREENFIELD_DEFAULT_TRACKS
  ])
  const [grillDecisions, setGrillDecisions] = useState<GrillDecision[]>([])
  const [trackScores, setTrackScores] = useState<GrillTrackScore[]>([])
  const [grillSkipped, setGrillSkipped] = useState(false)

  // ── Early-created workspace (shell) ──
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [shellError, setShellError] = useState<string | null>(null)
  const shellPromiseRef = useRef<Promise<string | null> | null>(null)
  // Once the project is committed to a destination, don't discard it on close.
  const finalizedRef = useRef(false)

  // ── Close confirmation ──
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  const hasData =
    grillDecisions.length > 0 ||
    trackScores.length > 0 ||
    attachments.length > 0 ||
    projectName.trim().length > 0 ||
    workspaceId !== null

  // ── Create the workspace shell (idempotent, concurrency-safe) ──
  const ensureShell = useCallback(async (): Promise<string | null> => {
    if (workspaceId) return workspaceId
    if (shellPromiseRef.current) return shellPromiseRef.current

    const promise = (async (): Promise<string | null> => {
      try {
        const ws = await window.api.createProjectShell({
          name: projectName.trim(),
          parentFolder,
          description,
          attachments: attachments.length > 0 ? attachments : undefined
        })
        setWorkspaceId(ws.id)
        setShellError(null)
        return ws.id
      } catch (err) {
        setShellError(err instanceof Error ? err.message : String(err))
        return null
      } finally {
        shellPromiseRef.current = null
      }
    })()
    shellPromiseRef.current = promise
    return promise
  }, [workspaceId, projectName, parentFolder, description, attachments])

  // ── Discard an abandoned shell (DB cascade + on-disk folder) ──
  const discardIfNeeded = useCallback(async (): Promise<void> => {
    if (workspaceId && !finalizedRef.current) {
      try {
        await window.api.discardProjectShell({ workspaceId })
      } catch (err) {
        console.error('discardProjectShell failed:', err)
      }
    }
  }, [workspaceId])

  // ── Navigation ──
  const handleClose = useCallback(() => {
    if (hasData) {
      setShowCloseConfirm(true)
    } else {
      onClose()
    }
  }, [hasData, onClose])

  const confirmClose = useCallback(async () => {
    setShowCloseConfirm(false)
    await discardIfNeeded()
    onClose()
  }, [discardIfNeeded, onClose])

  const goToStep = useCallback((step: WizardStep) => {
    setCurrentStep(step)
  }, [])

  // Setup → Focus
  const handleSetupNext = useCallback(() => {
    goToStep('focus')
  }, [goToStep])

  // Focus → Grill (create the workspace shell first)
  const handleFocusNext = useCallback(async () => {
    const id = await ensureShell()
    if (!id) return // shell creation failed — error surfaced, stay on Focus
    setGrillSkipped(false)
    goToStep('grill')
  }, [ensureShell, goToStep])

  // Focus → Create (skip the grill, blank project — still needs a workspace)
  const handleFocusSkip = useCallback(async () => {
    const id = await ensureShell()
    if (!id) return
    setGrillSkipped(true)
    setGrillDecisions([])
    setTrackScores([])
    goToStep('create')
  }, [ensureShell, goToStep])

  // Focus ← Setup
  const handleFocusBack = useCallback(() => {
    goToStep('setup')
  }, [goToStep])

  // Grill → Create (auto-advance or manual pause)
  const handleGrillDone = useCallback(() => {
    goToStep('create')
  }, [goToStep])

  // Grill ← Focus (pause and go back)
  const handleGrillBack = useCallback(() => {
    goToStep('create')
  }, [goToStep])

  // Create ← Grill (or ← Focus if the grill was skipped)
  const handleCreateBack = useCallback(() => {
    goToStep(grillSkipped ? 'focus' : 'grill')
  }, [goToStep, grillSkipped])

  // ── Finalize blueprint + route to the chosen destination ──
  const handleFinalize = useCallback(
    async (destination: ProjectDestination) => {
      const id = await ensureShell()
      if (!id) return

      await window.api.finalizeProjectBlueprint({
        workspaceId: id,
        projectName: projectName.trim(),
        description,
        grillDecisions: grillDecisions.length > 0 ? grillDecisions : undefined,
        trackScores: trackScores.length > 0 ? trackScores : undefined
      })
      finalizedRef.current = true

      // Synthesize a coherent plan (requirement document) from the grill
      // decisions, mirroring the regular Grill handoff. On synthesis failure /
      // empty result it degrades to a plan-skeleton doc — but flags `degraded`
      // so the degraded path stays visible and never auto-advances silently.
      const synthesizeRequirement = async (): Promise<{ text: string; degraded: boolean }> => {
        try {
          const plan = await window.api.grillGeneratePlanFromDecisions({
            projectName: projectName.trim(),
            description,
            grillDecisions,
            trackScores: trackScores.length > 0 ? trackScores : undefined,
            workspaceId: id
          })
          if (plan.requirementDocument?.trim()) {
            return { text: plan.requirementDocument, degraded: false }
          }
          console.warn('grillGeneratePlanFromDecisions returned an empty plan; using skeleton')
        } catch (err) {
          console.warn('grillGeneratePlanFromDecisions failed; using plan skeleton:', err)
        }
        const skeleton = buildRequirementDoc(projectName, description, grillDecisions)
        return { text: `${DEGRADED_PLAN_NOTICE}\n\n${skeleton}`, degraded: true }
      }

      // Prime the destination store BEFORE navigating; auto-nav listeners then
      // land the new workspace on the right tab (goals via preloadedGoal,
      // council via isActive). Chat is the default landing.
      if (destination === 'goals') {
        const { text, degraded } = await synthesizeRequirement()
        useMpaStore.getState().setPreloadedGoal({
          text,
          // Happy path: auto-decompose so the user lands on editable goals. On a
          // degraded handoff, keep the user on the describe step so they see the
          // notice and refine before generating.
          autoDecompose: !degraded,
          grillDecisions: grillDecisions.map((d) => ({
            header: d.questionText,
            selectedOption: d.selectedOption + (d.otherText ? ` (${d.otherText})` : ''),
            reason: ''
          }))
        })
      } else if (destination === 'council') {
        const { text: requirement } = await synthesizeRequirement()
        const councilStore = useCouncilStore.getState()
        councilStore.startCouncil()
        try {
          const { sessionId } = await window.api.councilStart({
            workspaceId: id,
            inputType: 'plan',
            planContent: requirement,
            originalUserRequest: projectName.trim()
          })
          councilStore.setSessionIdentity(sessionId, id)
        } catch (err) {
          console.error('councilStart failed:', err)
        }
      } else if (destination === 'chat') {
        // Seed the already-generated grill plan as a plan card so the new chat
        // lands on the same interactive plan as the regular Grill handoff.
        try {
          const plan = await window.api.grillGeneratePlanFromDecisions({
            projectName: projectName.trim(),
            description,
            grillDecisions,
            trackScores: trackScores.length > 0 ? trackScores : undefined,
            workspaceId: id
          })
          await useChatStore.getState().createConversation(id, 'plan', projectName.trim())
          const conv = useChatStore.getState().activeConversation
          if (conv) {
            await window.api.grillSeedPlanCard({ conversationId: conv.id, plan })
          }
        } catch (err) {
          console.warn('Greenfield plan seeding failed; landing on empty chat:', err)
        }
      }

      onCreated(id, destination)
    },
    [ensureShell, projectName, description, grillDecisions, trackScores, onCreated]
  )

  return (
    <div
      data-testid="wizard-container"
      className="flex flex-col bg-surface-base"
      style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999 }}
    >
      {/* Top bar — drag region + close (no stepper) */}
      <div
        className={`h-10 flex-shrink-0 border-b border-border-subtle bg-surface-overlay/50 flex items-center justify-end px-4 ${isMac ? 'pl-[80px]' : 'pl-4'}`}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            type="button"
            onClick={handleClose}
            className="flex items-center justify-center w-8 h-8 rounded-lg text-text-muted
                       hover:text-text-primary hover:bg-surface-overlay transition-colors
                       focus:outline-none focus:ring-2 focus:ring-primary/50"
            aria-label="Close wizard"
            data-testid="wizard-close-btn"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Shell creation error banner */}
      {shellError && (
        <div className="flex-shrink-0 px-6 py-2 bg-danger-muted border-b border-danger/30">
          <p className="text-xs text-danger text-center">❌ {shellError}</p>
        </div>
      )}

      {/* Step content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {currentStep === 'setup' && (
          <div data-testid="wizard-setup-step" className="flex-1 flex flex-col items-center justify-center p-8">
            <WizardStepIndicator
              currentStep={currentStep}
              onGoToStep={goToStep}
              lockSetup={workspaceId !== null}
            />
            <WizardSetupStep
              projectName={projectName}
              parentFolder={parentFolder}
              description={description}
              attachments={attachments}
              onProjectNameChange={setProjectName}
              onParentFolderChange={setParentFolder}
              onDescriptionChange={setDescription}
              onAttachmentsChange={setAttachments}
              onNext={handleSetupNext}
            />
          </div>
        )}

        {currentStep === 'focus' && (
          <div data-testid="wizard-focus-step" className="flex-1 flex flex-col items-center justify-center p-8">
            <WizardStepIndicator
              currentStep={currentStep}
              onGoToStep={goToStep}
              lockSetup={workspaceId !== null}
            />
            <WizardFocusStep
              selectedTracks={selectedTracks}
              onSelectedTracksChange={setSelectedTracks}
              onNext={handleFocusNext}
              onBack={handleFocusBack}
              onSkip={handleFocusSkip}
            />
          </div>
        )}

        {currentStep === 'grill' && workspaceId && (
          /* data-testid="wizard-grill-step" is on the WizardGrillStep root */
          <WizardGrillStep
            workspaceId={workspaceId}
            projectName={projectName}
            projectDescription={description}
            selectedTracks={selectedTracks}
            grillDecisions={grillDecisions}
            trackScores={trackScores}
            onDecisionsChange={setGrillDecisions}
            onTrackScoresChange={setTrackScores}
            onDone={handleGrillDone}
            onBack={handleGrillBack}
          />
        )}

        {currentStep === 'create' && (
          <div data-testid="wizard-summary-step" className="flex-1 flex flex-col items-center justify-center p-8">
            <WizardStepIndicator
              currentStep={currentStep}
              onGoToStep={goToStep}
              lockSetup={workspaceId !== null}
            />
            <WizardSummaryStep
              projectName={projectName}
              parentFolder={parentFolder}
              description={description}
              attachments={attachments}
              grillDecisions={grillDecisions}
              trackScores={trackScores}
              onBack={handleCreateBack}
              onFinalize={handleFinalize}
            />
          </div>
        )}
      </div>

      {/* Close confirmation */}
      <ConfirmDialog
        isOpen={showCloseConfirm}
        title="Discard Project Setup?"
        message={
          workspaceId
            ? 'This will delete the project that was created (folder and workspace). Are you sure?'
            : 'You have unsaved project setup data. Are you sure you want to close the wizard?'
        }
        confirmLabel="Discard"
        cancelLabel="Keep Editing"
        variant="danger"
        onConfirm={confirmClose}
        onCancel={() => setShowCloseConfirm(false)}
      />
    </div>
  )
}
