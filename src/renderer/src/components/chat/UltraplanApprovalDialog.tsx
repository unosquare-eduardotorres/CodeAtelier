/**
 * UltraplanApprovalDialog — teleport-back dialog shown when the user approves
 * a plan in the browser and selects "teleport back to terminal".
 *
 * Three options:
 * 1. Implement here — inject the plan into the current conversation
 * 2. Start new session — create a new conversation with the plan
 * 3. Cancel — dismiss and save the plan to a file
 */

import { useState } from 'react'
import { Cloud, Play, PlusCircle, X } from 'lucide-react'
import { useUltraplanStore } from '@renderer/store/ultraplan.store'

export default function UltraplanApprovalDialog(): React.JSX.Element | null {
  const status = useUltraplanStore((s) => s.status)
  const planContent = useUltraplanStore((s) => s.planContent)
  const reset = useUltraplanStore((s) => s.reset)
  const [responding, setResponding] = useState(false)

  if (status !== 'approved') return null

  const handleAction = async (
    action: 'implement_here' | 'new_session' | 'cancel'
  ): Promise<void> => {
    setResponding(true)
    try {
      await window.api.ultraplanRespond({ action })
    } catch (err) {
      console.error('[UltraplanApprovalDialog] Failed to respond:', err)
    } finally {
      reset()
      setResponding(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" data-testid="ultraplan-approval-dialog">
      <div className="w-full max-w-lg mx-4 rounded-xl border border-border bg-surface-primary shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-sky-500/10">
            <Cloud className="w-4 h-4 text-sky-400" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-primary">UltraPlan Ready</h2>
            <p className="text-xs text-secondary">
              Your plan has been approved and is ready to use
            </p>
          </div>
        </div>

        {/* Plan preview */}
        {planContent && (
          <div className="px-5 py-3 border-b border-border">
            <div className="max-h-48 overflow-y-auto rounded-lg bg-surface-secondary p-3 text-xs text-secondary font-mono whitespace-pre-wrap" data-testid="ultraplan-plan-preview">
              {planContent.length > 500 ? planContent.slice(0, 500) + '…' : planContent}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="px-5 py-4 space-y-2">
          <button
            type="button"
            data-testid="ultraplan-implement"
            disabled={responding}
            onClick={() => handleAction('implement_here')}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-surface-secondary hover:bg-surface-tertiary transition-colors text-left disabled:opacity-50"
          >
            <Play className="w-4 h-4 text-success shrink-0" />
            <div>
              <div className="text-sm font-medium text-primary">Implement here</div>
              <div className="text-xs text-secondary">
                Execute the plan in the current conversation
              </div>
            </div>
          </button>

          <button
            type="button"
            data-testid="ultraplan-new-session"
            disabled={responding}
            onClick={() => handleAction('new_session')}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-surface-secondary hover:bg-surface-tertiary transition-colors text-left disabled:opacity-50"
          >
            <PlusCircle className="w-4 h-4 text-sky-400 shrink-0" />
            <div>
              <div className="text-sm font-medium text-primary">Start new session</div>
              <div className="text-xs text-secondary">
                Create a fresh conversation with the plan as context
              </div>
            </div>
          </button>

          <button
            type="button"
            data-testid="ultraplan-cancel"
            disabled={responding}
            onClick={() => handleAction('cancel')}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-surface-secondary hover:bg-surface-tertiary transition-colors text-left disabled:opacity-50"
          >
            <X className="w-4 h-4 text-secondary shrink-0" />
            <div>
              <div className="text-sm font-medium text-primary">Cancel</div>
              <div className="text-xs text-secondary">Save the plan to a file and dismiss</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}
