import { ArrowRight } from 'lucide-react'
import { useSpecialistStore } from '@renderer/store'

interface HandoffIndicatorProps {
  summary: string
  specialists: string[]
  mode: 'plan' | 'build'
}

export default function HandoffIndicator({
  summary,
  specialists,
  mode
}: HandoffIndicatorProps): React.JSX.Element {
  const allSpecialists = useSpecialistStore((s) => s.specialists)

  const resolveDisplayName = (id: string): string => {
    // Try matching by agentId first (slugs), then by id (UUIDs)
    const match = allSpecialists.find((s) => s.agentId === id || s.id === id)
    return match?.displayName ?? id
  }

  return (
    <div data-testid="handoff-indicator" className="flex items-center gap-3 px-5 py-4 my-2 rounded-xl bg-primary-muted border border-primary/30 shadow-sm">
      <ArrowRight size={16} className="text-primary-text flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-primary-text">Handing off to specialists</p>
        <p className="text-xs text-text-secondary mt-0.5 truncate">{summary}</p>
        {specialists.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {specialists.map((s) => (
              <span
                key={s}
                className="text-xs px-2 py-0.5 rounded-full bg-primary/20 text-primary-text border border-primary/20"
              >
                {resolveDisplayName(s)}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-text-secondary mt-1.5 italic">Assigning specialists…</p>
        )}
      </div>
      <span
        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
          mode === 'build' ? 'bg-mode-build-muted text-mode-build-text' : 'bg-mode-plan-muted text-mode-plan-text'
        }`}
      >
        {mode}
      </span>
    </div>
  )
}
