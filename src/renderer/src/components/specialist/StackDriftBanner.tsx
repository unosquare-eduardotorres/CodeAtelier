/**
 * StackDriftBanner — non-intrusive banner shown at the top of ChatPanel when
 * the workspace's tech stack has changed since the Project Specialist was
 * last built. Offers one-click "Rebuild prompt" / "Update skills only" / "Dismiss".
 *
 * Phase 2 of the Project Specialist refactor.
 */
import { useEffect } from 'react'
import { AlertTriangle, Hammer, Sparkles, X } from 'lucide-react'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'

interface StackDriftBannerProps {
  workspaceId: string | null
}

export default function StackDriftBanner({
  workspaceId
}: StackDriftBannerProps): React.JSX.Element | null {
  const drift = useProjectSpecialistStore((s) =>
    workspaceId ? s.driftByWorkspace[workspaceId] : null
  )
  const specialist = useProjectSpecialistStore((s) =>
    workspaceId ? s.byWorkspace[workspaceId] : null
  )
  const rebuildPrompt = useProjectSpecialistStore((s) => s.rebuildPrompt)
  const rebuildSkills = useProjectSpecialistStore((s) => s.rebuildSkills)
  const checkDrift = useProjectSpecialistStore((s) => s.checkDrift)

  useEffect(() => {
    if (workspaceId) void checkDrift(workspaceId)
  }, [workspaceId, checkDrift])

  if (!drift?.drifted || !specialist) return null

  const { added, removed } = drift

  return (
    <div data-testid="stack-drift-banner" className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <div className="flex-1">
        <div className="font-medium text-amber-900 dark:text-amber-200">
          Your project&apos;s tech stack has changed
        </div>
        <div className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-200/70">
          {added.length > 0 && <span>Added: {added.join(', ')}. </span>}
          {removed.length > 0 && <span>Removed: {removed.join(', ')}.</span>}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void rebuildPrompt(specialist.id)}
            className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2 py-1 text-xs font-medium text-white hover:bg-amber-700"
          >
            <Hammer className="h-3 w-3" /> Rebuild prompt
          </button>
          <button
            type="button"
            onClick={() => void rebuildSkills(specialist.id)}
            className="inline-flex items-center gap-1 rounded-md border border-amber-600/40 px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-500/10 dark:text-amber-200"
          >
            <Sparkles className="h-3 w-3" /> Update skills only
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          // Dismiss locally by clearing the store entry.
          useProjectSpecialistStore.setState((state) => ({
            driftByWorkspace: {
              ...state.driftByWorkspace,
              [drift.workspaceId]: { ...drift, drifted: false }
            }
          }))
        }}
        aria-label="Dismiss"
        className="text-amber-700 hover:text-amber-900"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
