import { ArrowRight } from 'lucide-react'
import type { ExternalMcpDefinition } from '../../../../../shared/constants'

export default function WorkflowStepper({
  steps
}: {
  steps: NonNullable<ExternalMcpDefinition['workflowSteps']>
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <h5 className="text-xs font-semibold text-text-primary">How it works</h5>
      <div className="flex items-start gap-1 flex-wrap">
        {steps.map((ws, i) => (
          <div key={ws.step} className="flex items-center gap-1">
            <div className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-md bg-surface-base border border-border-subtle min-w-[120px] text-center">
              <span className="text-accent text-xs font-bold">
                {['①', '②', '③', '④', '⑤', '⑥'][i] ?? `${i + 1}.`}
              </span>
              <span className="text-[11px] font-semibold text-text-primary">{ws.step}</span>
              <span className="text-[10px] text-text-muted leading-tight">{ws.description}</span>
            </div>
            {i < steps.length - 1 && (
              <ArrowRight size={12} className="text-text-muted flex-shrink-0 mx-0.5" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
