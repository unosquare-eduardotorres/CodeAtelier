import { useEffect, useRef, type JSX } from 'react'
import { Terminal } from 'lucide-react'
import type { BlueprintPhaseType } from '../../../../../shared/blueprint-types'

// ── Phase Labels ──

const PHASE_LABELS: Record<BlueprintPhaseType, { emoji: string; label: string }> = {
  specify: { emoji: '📋', label: 'Specifier' },
  clarify: { emoji: '❓', label: 'Clarifier' },
  plan: { emoji: '🗺️', label: 'Planner' },
  tasks: { emoji: '📝', label: 'Task Builder' },
  review: { emoji: '🔍', label: 'Reviewer' },
  build: { emoji: '🏗️', label: 'Builder' },
  verify: { emoji: '✅', label: 'Verifier' }
}

interface BlueprintPhaseStreamProps {
  phaseType: string
  streamText: string
}

export default function BlueprintPhaseStream({
  phaseType,
  streamText
}: BlueprintPhaseStreamProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [streamText])

  const config = PHASE_LABELS[phaseType as BlueprintPhaseType]
  const phaseLabel = config ? `${config.emoji} ${config.label}` : phaseType

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
        <Terminal size={14} className="text-text-muted" />
        <span className="text-xs font-medium text-text-secondary">{phaseLabel} Output</span>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 font-mono text-xs text-text-secondary leading-relaxed whitespace-pre-wrap"
      >
        {streamText || (
          <span className="text-text-muted animate-pulse">Waiting for agent output...</span>
        )}
      </div>
    </div>
  )
}
