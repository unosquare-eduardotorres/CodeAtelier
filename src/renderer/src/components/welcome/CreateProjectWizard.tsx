/**
 * CreateProjectWizard — full-screen 3-step wizard for creating a new project.
 *
 * Steps:
 *   1. Setup — name, folder, description
 *   2. Grill — greenfield grill session (optional — can be skipped)
 *   3. Summary & Create — read-only confirmation, triggers creation
 *
 * State is held here and passed down. The wizard overlay replaces the
 * Welcome screen when active.
 */

import { useState, useCallback } from 'react'
import { X, Circle, CheckCircle2 } from 'lucide-react'
import { ConfirmDialog } from '@renderer/components/common'
import type { GrillDecision, GrillTrackScore } from '../../../../shared/types'
import WizardSetupStep from './wizard/WizardSetupStep'
import WizardGrillStep from './wizard/WizardGrillStep'
import WizardSummaryStep from './wizard/WizardSummaryStep'

// ── Types ─────────────────────────────────────────────────────────────────

interface CreateProjectWizardProps {
  onClose: () => void
  onCreated: (workspaceId: string) => void
}

type WizardStep = 'setup' | 'grill' | 'summary'

const STEP_ORDER: WizardStep[] = ['setup', 'grill', 'summary']

const STEP_LABELS: Record<WizardStep, string> = {
  setup: 'Setup',
  grill: 'Grill',
  summary: 'Create'
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
  const [grillDecisions, setGrillDecisions] = useState<GrillDecision[]>([])
  const [trackScores, setTrackScores] = useState<GrillTrackScore[]>([])
  const [skippedGrill, setSkippedGrill] = useState(false)

  // ── Close confirmation ──
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  const hasGrillData = grillDecisions.length > 0 || trackScores.length > 0

  // ── Navigation ──
  const handleClose = useCallback(() => {
    if (hasGrillData || projectName.trim().length > 0) {
      setShowCloseConfirm(true)
    } else {
      onClose()
    }
  }, [hasGrillData, projectName, onClose])

  const goToStep = useCallback((step: WizardStep) => {
    setCurrentStep(step)
  }, [])

  // Setup → Grill
  const handleSetupNext = useCallback(() => {
    setSkippedGrill(false)
    goToStep('grill')
  }, [goToStep])

  // Setup → Summary (skip grill)
  const handleSkipGrill = useCallback(() => {
    setSkippedGrill(true)
    goToStep('summary')
  }, [goToStep])

  // Grill → Summary (pause, ready, or skip)
  const handleGrillToSummary = useCallback(() => {
    goToStep('summary')
  }, [goToStep])

  // Summary → back to grill or setup
  const handleSummaryBack = useCallback(() => {
    if (skippedGrill) {
      goToStep('setup')
    } else {
      goToStep('grill')
    }
  }, [skippedGrill, goToStep])

  // ── Create Project ──
  const handleCreateProject = useCallback(async () => {
    const workspace = await window.api.createProject({
      name: projectName.trim(),
      parentFolder,
      description,
      grillDecisions: grillDecisions.length > 0 ? grillDecisions : undefined,
      trackScores: trackScores.length > 0 ? trackScores : undefined
    })

    onCreated(workspace.id)
  }, [projectName, parentFolder, description, grillDecisions, trackScores, onCreated])

  // ── Step indicator ──
  const currentStepIndex = STEP_ORDER.indexOf(currentStep)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface-base">
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle bg-surface-overlay/50">
        {/* Step indicator */}
        <div className="flex items-center gap-2">
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
                    // Only allow navigating backwards
                    if (idx < currentStepIndex) goToStep(step)
                  }}
                  disabled={idx > currentStepIndex}
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

        {/* Close button */}
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

      {/* Step content */}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {currentStep === 'setup' && (
          <div className="flex-1 flex items-center justify-center p-8">
            <WizardSetupStep
              projectName={projectName}
              parentFolder={parentFolder}
              description={description}
              onProjectNameChange={setProjectName}
              onParentFolderChange={setParentFolder}
              onDescriptionChange={setDescription}
              onNext={handleSetupNext}
              onSkipGrill={handleSkipGrill}
            />
          </div>
        )}

        {currentStep === 'grill' && (
          <WizardGrillStep
            projectName={projectName}
            projectDescription={description}
            grillDecisions={grillDecisions}
            trackScores={trackScores}
            onDecisionsChange={setGrillDecisions}
            onTrackScoresChange={setTrackScores}
            onPauseAndCreate={handleGrillToSummary}
            onReady={handleGrillToSummary}
          />
        )}

        {currentStep === 'summary' && (
          <div className="flex-1 flex items-center justify-center p-8">
            <WizardSummaryStep
              projectName={projectName}
              parentFolder={parentFolder}
              description={description}
              grillDecisions={grillDecisions}
              trackScores={trackScores}
              skippedGrill={skippedGrill}
              onBack={handleSummaryBack}
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
