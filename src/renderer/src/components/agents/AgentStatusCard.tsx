import { useState, useEffect, useRef } from 'react'
import {
  Brain,
  Pencil,
  Eye,
  CheckCircle,
  XCircle,
  Pause,
  ChevronDown,
  ChevronUp
} from 'lucide-react'
import type { AgentStatus, ModelTier, ComplexityTier } from '../../../../shared/types'
import { AGENT_META } from '../../../../shared/constants'
import { useSpecialistStore, useAgentStore } from '@renderer/store'

// Model tier badge config
const MODEL_BADGE: Record<ModelTier, { label: string; bg: string; text: string }> = {
  haiku: { label: 'H', bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
  sonnet: { label: 'S', bg: 'bg-blue-500/15', text: 'text-blue-400' },
  opus: { label: 'O', bg: 'bg-purple-500/15', text: 'text-purple-400' }
}

// Complexity tier dot colors
const TIER_DOT: Record<ComplexityTier, string> = {
  simple: 'bg-emerald-400',
  moderate: 'bg-yellow-400',
  complex: 'bg-red-400'
}

interface AgentStatusCardProps {
  status: AgentStatus
}

const STATUS_CONFIG: Record<
  AgentStatus['status'],
  { bg: string; text: string; dot: string; icon: React.ReactNode; label: string }
> = {
  idle: {
    bg: 'bg-surface-overlay',
    text: 'text-text-secondary',
    dot: 'bg-gray-500',
    icon: <Pause size={12} />,
    label: 'Idle'
  },
  thinking: {
    bg: 'bg-yellow-500/10',
    text: 'text-yellow-400',
    dot: 'bg-yellow-400',
    icon: <Brain size={12} />,
    label: 'Thinking'
  },
  writing: {
    bg: 'bg-blue-500/10',
    text: 'text-blue-400',
    dot: 'bg-blue-400',
    icon: <Pencil size={12} />,
    label: 'Writing'
  },
  reviewing: {
    bg: 'bg-purple-500/10',
    text: 'text-purple-400',
    dot: 'bg-purple-400',
    icon: <Eye size={12} />,
    label: 'Reviewing'
  },
  completed: {
    bg: 'bg-green-500/10',
    text: 'text-green-400',
    dot: 'bg-green-400',
    icon: <CheckCircle size={12} />,
    label: 'Completed'
  },
  failed: {
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    dot: 'bg-red-400',
    icon: <XCircle size={12} />,
    label: 'Failed'
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return count.toString()
}

export default function AgentStatusCard({ status }: AgentStatusCardProps): React.JSX.Element {
  const [elapsed, setElapsed] = useState(status.elapsedMs)
  const [isExpanded, setIsExpanded] = useState(false)
  const outputRef = useRef<HTMLDivElement>(null)
  const config = STATUS_CONFIG[status.status] || STATUS_CONFIG.idle
  const { specialists } = useSpecialistStore()
  const agentOutput = useAgentStore((s) => s.agentOutputs[status.agentId] ?? '')

  // Look up metadata from DB-backed specialists first, fall back to hardcoded AGENT_META
  const dbSpecialist = specialists.find((s) => s.agentId === status.agentType)
  const meta = dbSpecialist
    ? { icon: dbSpecialist.icon, color: dbSpecialist.color, displayName: dbSpecialist.displayName }
    : AGENT_META[status.agentType]

  const isActive =
    status.status === 'thinking' || status.status === 'writing' || status.status === 'reviewing'

  useEffect(() => {
    // Sync elapsed with status when not active
    if (!isActive) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setElapsed(status.elapsedMs)
    }
  }, [isActive, status.elapsedMs])

  useEffect(() => {
    if (!isActive) return

    const startTime = Date.now() - status.elapsedMs
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime)
    }, 1000)

    return () => clearInterval(interval)
  }, [isActive, status.elapsedMs])

  // Auto-scroll output to bottom when new content arrives
  useEffect(() => {
    if (isExpanded && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [isExpanded, agentOutput])

  return (
    <div
      className="bg-surface-overlay rounded-lg p-4 border border-border-subtle border-l-2 shadow-sm hover:border-border-default transition-colors"
      style={{ borderLeftColor: meta?.color ?? '#6366F1' }}
    >
      <div
        className="flex items-center justify-between mb-2 cursor-pointer press-scale"
        onClick={() => setIsExpanded(!isExpanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setIsExpanded(!isExpanded)
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-base" role="img" aria-label={meta?.displayName ?? status.agentType}>
            {meta?.icon ?? '🔧'}
          </span>
          <span className="text-sm font-medium text-text-primary">
            {meta?.displayName ??
              status.agentType
                .split('-')
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' ')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${config.bg} ${config.text}`}
          >
            {config.icon}
            {config.label}
          </span>
          {/* Model + complexity indicators */}
          {status.model && MODEL_BADGE[status.model] && (
            <span
              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${MODEL_BADGE[status.model].bg} ${MODEL_BADGE[status.model].text}`}
              title={`Model: ${status.model} | Complexity: ${status.complexityTier ?? 'unknown'}`}
              aria-label={`Model: ${status.model}`}
            >
              {MODEL_BADGE[status.model].label}
            </span>
          )}
          {status.complexityTier && TIER_DOT[status.complexityTier] && (
            <span
              className={`w-2 h-2 rounded-full ${TIER_DOT[status.complexityTier]}`}
              title={`Complexity: ${status.complexityTier}`}
              role="img"
              aria-label={`Complexity: ${status.complexityTier}`}
            />
          )}
          {isExpanded ? (
            <ChevronUp size={14} className="text-text-muted" />
          ) : (
            <ChevronDown size={14} className="text-text-muted" />
          )}
        </div>
      </div>

      {status.currentTask && (
        <p className="text-xs text-text-secondary mb-2 truncate" title={status.currentTask}>
          {status.currentTask}
        </p>
      )}

      <div className="flex items-center gap-3 text-xs text-text-muted">
        <span>{formatElapsed(elapsed)}</span>
        <span>·</span>
        <span>{formatTokens(status.tokenUsage)} tokens</span>
      </div>

      {/* Expandable detail view */}
      {isExpanded && (
        <div className="mt-3 pt-3 border-t border-border-subtle">
          <div ref={outputRef} className="bg-surface-base rounded p-2 max-h-48 overflow-y-auto">
            <pre className="text-xs text-text-body whitespace-pre-wrap font-mono">
              {agentOutput || 'Waiting for output...'}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
