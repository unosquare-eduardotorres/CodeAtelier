import { useEffect, useRef, type JSX } from 'react'
import { Terminal } from 'lucide-react'
import { PHASE_CONFIG } from './constants'
import type { MpaPhaseType } from '../../../../../shared/mpa-types'

interface GoalPhaseStreamProps {
  phaseType: string
  streamText: string
}

export default function GoalPhaseStream({
  phaseType,
  streamText
}: GoalPhaseStreamProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [streamText])

  const config = PHASE_CONFIG[phaseType as MpaPhaseType]
  const phaseLabel = config ? `${config.emoji} ${config.agentLabel}` : phaseType

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle">
        <Terminal size={14} className="text-text-muted" />
        <span className="text-xs font-medium text-text-secondary">
          {phaseLabel} Output
        </span>
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
