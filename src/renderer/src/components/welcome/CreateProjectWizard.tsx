/**
 * CreateProjectWizard — full-screen 4-step wizard for creating a new project.
 *
 * Steps:
 *   1. Setup — name, folder, description, attachments
 *   2. Focus Areas — multi-select greenfield grill tracks (≥1 required)
 *   3. Grill — auto-advances through selected tracks with context carry-over
 *   4. Create — review decisions summary, trigger project creation
 *
 * State is held here and passed down. The wizard overlay uses inline fixed
 * positioning for guaranteed full-viewport coverage (no createPortal needed).
 */

import { useState, useCallback } from 'react'
import { X, Circle, CheckCircle2 } from 'lucide-react'
import { ConfirmDialog } from '@renderer/components/common'
import type { GrillDecision, GrillTrackId, GrillTrackScore } from '../../../../shared/types'
import { GREENFIELD_DEFAULT_TRACKS } from '../../../../shared/constants'
import WizardSetupStep from './wizard/WizardSetupStep'
import WizardFocusStep from './wizard/WizardFocusStep'
import WizardGrillStep from './wizard/WizardGrillStep'
import WizardSummaryStep from './wizard/WizardSummaryStep'

// ── Types ─────────────────────────────────────────────────────────────────

interface CreateProjectWizardProps {
  onClose: () => void
  onCreated: (workspaceId: string) => void
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

// ── Step indicator (rendered inside content area) ────────────────────────

function WizardStepIndicator({
  currentStep,
  onGoToStep
}: {
  currentStep: WizardStep
  onGoToStep: (step: WizardStep) => void
}): React.JSX.Element {
  const currentStepIndex = STEP_ORDER.indexOf(currentStep)

  return (
    <div className="flex items-center justify-center gap-2 py-6">
      {STEP_ORDER.map((step, idx) => {
        const isActive = step === currentStep
        const isDone = idx < currentStepIndex
        return (
          <div key={step} className="flex items-center gap-1.5">
            {idx > 0 && (
              <div className={`w-8 h-px ${isDone ? 'bg-primary' : 'bg-border-subtle'}`} />
            )}
            <button
              type="button"
              onClick={() => {
                if (idx < currentStepIndex) onGoToStep(step)
              }}
              disabled={idx >= currentStepIndex}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                isActive
                  ? 'text-primary-text bg-primary-muted'
                  : isDone
                    ? 'text-text-primary hover:bg-surface-overlay cursor-pointer'
                    : 'text-text-muted cursor-default'
              }`}
            >
              {isDone ? (
                <CheckCircle2 size={14} className="text-primary-text" />
              ) : (
                <Circle
                  size={14}
                  className={isActive ? 'text-primary-text' : 'text-text-muted'}
                />
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

  // ── Close confirmation ──
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  const hasData =
    grillDecisions.length > 0 ||
    trackScores.length > 0 ||
    attachments.length > 0 ||
    projectName.trim().length > 0

  // ── Navigation ──
  const handleClose = useCallback(() => {
    if (hasData) {
      setShowCloseConfirm(true)
    } else {
      onClose()
    }
  }, [hasData, onClose])

  const goToStep = useCallback((step: WizardStep) => {
    setCurrentStep(step)
  }, [])

  // Setup → Focus
  const handleSetupNext = useCallback(() => {
    goToStep('focus')
  }, [goToStep])

  // Focus → Grill
  const handleFocusNext = useCallback(() => {
    goToStep('grill')
  }, [goToStep])

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

  // Create ← Grill
  const handleCreateBack = useCallback(() => {
    goToStep('grill')
  }, [goToStep])

  // ── Create Project ──
  const handleCreateProject = useCallback(async () => {
    const workspace = await window.api.createProject({
      name: projectName.trim(),
      parentFolder,
      description,
      attachments: attachments.length > 0 ? attachments : undefined,
      grillDecisions: grillDecisions.length > 0 ? grillDecisions : undefined,
      trackScores: trackScores.length > 0 ? trackScores : undefined
    })

    onCreated(workspace.id)
  }, [projectName, parentFolder, description, attachments, grillDecisions, trackScores, onCreated])

  return (
    <div
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
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {currentStep === 'setup' && (
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <WizardStepIndicator currentStep={currentStep} onGoToStep={goToStep} />
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
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <WizardStepIndicator currentStep={currentStep} onGoToStep={goToStep} />
            <WizardFocusStep
              selectedTracks={selectedTracks}
              onSelectedTracksChange={setSelectedTracks}
              onNext={handleFocusNext}
              onBack={handleFocusBack}
            />
          </div>
        )}

        {currentStep === 'grill' && (
          <WizardGrillStep
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
          <div className="flex-1 flex flex-col items-center justify-center p-8">
            <WizardStepIndicator currentStep={currentStep} onGoToStep={goToStep} />
            <WizardSummaryStep
              projectName={projectName}
              parentFolder={parentFolder}
              description={description}
              attachments={attachments}
              grillDecisions={grillDecisions}
              trackScores={trackScores}
              onBack={handleCreateBack}
              onCreateProject={handleCreateProject}
            />
          </div>
        )}
      </div>

      {/* Close confirmation */}
      <ConfirmDialog
        isOpen={showCloseConfirm}
        title="Discard Project Setup?"
        message="You have unsaved project setup data. Are you sure you want to close the wizard?"
        confirmLabel="Discard"
        cancelLabel="Keep Editing"
        variant="danger"
        onConfirm={() => {
          setShowCloseConfirm(false)
          onClose()
        }}
        onCancel={() => setShowCloseConfirm(false)}
      />
    </div>
  )
}
