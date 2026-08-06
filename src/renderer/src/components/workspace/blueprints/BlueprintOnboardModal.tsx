/**
 * BlueprintOnboardModal — shown when a blank project lands on the Blueprints page.
 *
 * Welcome / instructions only — explains the Blueprint pipeline with a visual
 * illustration and offers two actions:
 *   • "Create Your First Blueprint" → navigates to the input view (pre-populated)
 *   • "I'll explore first"          → dismisses without pre-populating
 *
 * The modal does NOT contain a form. Title, description, and reference docs are
 * pre-populated into the input view by BlueprintPage when the user proceeds.
 */

import { X } from 'lucide-react'
import { PHASE_CONFIG } from './phase-config'
import type { BlueprintPhaseType } from '../../../../../shared/blueprint-types'

interface BlueprintOnboardModalProps {
  isOpen: boolean
  onDismiss: () => void
  onProceedToInput: () => void
}

// ── Pipeline Illustration (div-based with lucide icons) ─────────────────────

const ONBOARD_PHASES: BlueprintPhaseType[] = ['specify', 'plan', 'build', 'verify']

function PipelineIllustration(): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-3 max-w-sm mx-auto">
      {ONBOARD_PHASES.map((phase, i) => {
        const config = PHASE_CONFIG[phase]
        const Icon = config.icon
        return (
          <div key={phase} className="flex items-center gap-2">
            {/* Connector dashes (before all except first) */}
            {i > 0 && <div className="w-6 border-t-2 border-dashed border-border-subtle" />}
            {/* Phase circle + label */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className="flex items-center justify-center w-12 h-12 rounded-full border-[1.5px]"
                style={{
                  borderColor: config.hexColor,
                  backgroundColor: `${config.hexColor}15`
                }}
              >
                <Icon size={20} className={`text-[${config.hexColor}]`} />
              </div>
              <span className="text-[10px] font-medium text-text-secondary">{config.label}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Component ───────────────────────────────────────────────────────────────

export default function BlueprintOnboardModal({
  isOpen,
  onDismiss,
  onProceedToInput
}: BlueprintOnboardModalProps): React.JSX.Element | null {
  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      /* No outside-click dismiss — prevents accidental close on paste / mis-click */
    >
      <div
        data-testid="blueprint-onboard-modal"
        className="w-full max-w-md bg-surface-raised border border-border-subtle rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
          <h2 className="text-sm font-semibold text-text-primary">
            Start Building with Blueprints
          </h2>
          <button
            type="button"
            onClick={onDismiss}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-text-muted
                       hover:text-text-primary hover:bg-surface-overlay transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-5">
          {/* Illustration */}
          <PipelineIllustration />

          {/* Explanation */}
          <div className="text-center space-y-1.5">
            <p className="text-sm text-text-primary leading-relaxed">
              As this is a blank project, the{' '}
              <span className="font-semibold text-accent">Blueprint pipeline</span> can help you
              generate a project skeleton, plan features, and build them step by step.
            </p>
            <p className="text-xs text-text-secondary">
              Describe what you want to build and the 7-phase pipeline will specify, plan, build,
              and verify it — pausing for your approval before writing code.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border-subtle bg-surface-overlay/30">
          <button
            type="button"
            onClick={onDismiss}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            I&apos;ll explore first
          </button>
          <button
            type="button"
            onClick={onProceedToInput}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white
                       bg-button-primary-bg hover:bg-button-primary-hover rounded-lg transition-colors
                       focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            Create Your First Blueprint
          </button>
        </div>
      </div>
    </div>
  )
}
