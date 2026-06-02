/**
 * HealthPlanStep — the 'plan' view in the Health view-state machine.
 *
 * Shows the generating state while a plan is synthesized, then renders the
 * AuditPlanCard with its route bar. Reads plan state from the audit store.
 */

import { ChevronLeft, Loader2, Wand2 } from 'lucide-react'
import { useAuditStore } from '@renderer/store'
import AuditPlanCard from './AuditPlanCard'

interface HealthPlanStepProps {
  onBack: () => void
  onSendToChat: () => void
  onSendToGrill: () => void
  onSendToGoals: () => void
  onSendToCouncil: () => void
  onExport: () => void
}

export default function HealthPlanStep({
  onBack,
  onSendToChat,
  onSendToGrill,
  onSendToGoals,
  onSendToCouncil,
  onExport
}: HealthPlanStepProps): React.JSX.Element {
  const currentPlan = useAuditStore((s) => s.currentPlan)
  const isGenerating = useAuditStore((s) => s.isGeneratingPlan)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle bg-surface-raised">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
          title="Back to results"
        >
          <ChevronLeft size={16} />
        </button>
        <Wand2 size={16} className="text-primary-text" />
        <h2 className="text-sm font-bold text-text-primary">Remediation Plan</h2>
      </div>

      {isGenerating || !currentPlan ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          {isGenerating ? (
            <>
              <Loader2 size={28} className="text-primary-text animate-spin" />
              <span className="text-sm text-text-secondary">
                Synthesizing a plan from your findings…
              </span>
              <span className="text-[11px] text-text-muted">
                This can take up to a couple of minutes.
              </span>
            </>
          ) : (
            <span className="text-sm text-text-muted italic">No plan generated yet.</span>
          )}
        </div>
      ) : (
        <AuditPlanCard
          plan={currentPlan.plan}
          onSendToChat={onSendToChat}
          onSendToGrill={onSendToGrill}
          onSendToGoals={onSendToGoals}
          onSendToCouncil={onSendToCouncil}
          onExport={onExport}
        />
      )}
    </div>
  )
}
