import { useState, useEffect, useRef } from 'react'
import {
  Brain,
  Pencil,
  Eye,
  CheckCircle,
  XCircle,
  Pause,
  ChevronDown,
  ChevronUp,
  Square
} from 'lucide-react'
import type { AgentStatus, ModelTier, ComplexityTier } from '../../../../shared/types'
import { getAgentMeta } from '@renderer/utils/agentMeta'
import { useSpecialistStore, useAgentStore } from '@renderer/store'
import { Avatar, PixelSpriteAvatar } from '@renderer/components/common'
import { getDefaultAvatarForRole } from '@renderer/utils/agentIdentity'
import { getSpriteAssignment } from '@renderer/components/pixel-office/agentMapping'

// Model tier badge config
const MODEL_BADGE: Record<ModelTier, { label: string; bg: string; text: string }> = {
  haiku: { label: 'H', bg: 'bg-success-muted', text: 'text-success' },
  sonnet: { label: 'S', bg: 'bg-info-muted', text: 'text-info' },
  opus: { label: 'O', bg: 'bg-mode-plan-muted', text: 'text-mode-plan-text' }
}

// Complexity tier dot colors
const TIER_DOT: Record<ComplexityTier, string> = {
  simple: 'bg-success',
  moderate: 'bg-warning',
  complex: 'bg-danger'
}

interface AgentStatusCardProps {
  status: AgentStatus
  /** When true, renders with subtle indentation to indicate this is a sub-agent of the generalist */
  isSubagent?: boolean
}

const STATUS_CONFIG: Record<
  AgentStatus['status'],
  { bg: string; text: string; dot: string; icon: React.ReactNode; label: string }
> = {
  idle: {
    bg: 'bg-surface-overlay',
    text: 'text-text-secondary',
    dot: 'bg-text-muted',
    icon: <Pause size={12} />,
    label: 'Idle'
  },
  thinking: {
    bg: 'bg-warning-muted',
    text: 'text-warning',
    dot: 'bg-warning',
    icon: <Brain size={12} />,
    label: 'Thinking'
  },
  writing: {
    bg: 'bg-info-muted',
    text: 'text-info',
    dot: 'bg-info',
    icon: <Pencil size={12} />,
    label: 'Writing'
  },
  reviewing: {
    bg: 'bg-mode-plan-muted',
    text: 'text-mode-plan-text',
    dot: 'bg-mode-plan',
    icon: <Eye size={12} />,
    label: 'Reviewing'
  },
  completed: {
    bg: 'bg-success-muted',
    text: 'text-success',
    dot: 'bg-success',
    icon: <CheckCircle size={12} />,
    label: 'Completed'
  },
  failed: {
    bg: 'bg-danger-muted',
    text: 'text-danger',
    dot: 'bg-danger',
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

export default function AgentStatusCard({
  status,
  isSubagent
}: AgentStatusCardProps): React.JSX.Element {
  const [elapsed, setElapsed] = useState(status.elapsedMs)
  const [isExpanded, setIsExpanded] = useState(false)
  const outputRef = useRef<HTMLDivElement>(null)
  const config = STATUS_CONFIG[status.status] || STATUS_CONFIG.idle
  const { specialists } = useSpecialistStore()
  const agentOutput = useAgentStore((s) => s.agentOutputs[status.agentId] ?? '')
  const gates = useAgentStore((s) => s.gateResults[status.agentId]) ?? []
  const abandonment = useAgentStore((s) => s.abandonments[status.agentId])

  // Look up metadata from DB-backed specialists
  const meta = getAgentMeta(status.agentType, specialists)
  const specialist = specialists.find((s) => s.agentId === status.agentType)

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
    if ((isExpanded || (isActive && agentOutput)) && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [isExpanded, isActive, agentOutput])

  return (
    <div
      className={`bg-surface-overlay rounded-lg border border-border-subtle border-l-2 shadow-sm hover:border-border-default transition-colors ${isSubagent ? 'ml-4 p-3' : 'p-4'}`}
      style={{ borderLeftColor: meta?.color ?? '#B8976A' }}
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
          {specialist?.pixelSpriteId || getSpriteAssignment(status.agentType).pixelSpriteId ? (
            <PixelSpriteAvatar
              spriteId={
                specialist?.pixelSpriteId ?? getSpriteAssignment(status.agentType).pixelSpriteId!
              }
              size={20}
            />
          ) : (
            <Avatar
              avatarKey={specialist?.avatarUrl ?? getDefaultAvatarForRole(status.agentType)}
              size="sm"
              accentColor={meta?.color ?? '#B8976A'}
            />
          )}
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-text-primary">
                {meta?.displayName ??
                  status.agentType
                    .split('-')
                    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                    .join(' ')}
              </span>
            </div>
            {isSubagent && (
              <span className="text-[10px] text-text-muted leading-tight">Sub-agent</span>
            )}
          </div>
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
        {/* Per-agent Stop button — uses SDK stopTask */}
        {isActive && isSubagent && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              window.api.sdkStopTask({ taskId: status.agentId }).catch(() => {
                // Silently handle — query may have ended
              })
            }}
            className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded text-danger bg-danger-muted hover:bg-danger/20 transition-colors"
            title={`Stop ${meta?.displayName ?? status.agentType}`}
          >
            <Square size={10} />
            <span>Stop</span>
          </button>
        )}
      </div>

      {/* Gate results badges */}
      {gates.length > 0 && (
        <div className="flex items-center gap-1 mt-1 flex-wrap">
          {gates.map((g, i) => (
            <span
              key={i}
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                g.passed ? 'bg-success-muted text-success' : 'bg-danger-muted text-danger'
              }`}
              title={g.summary}
            >
              {g.passed ? '✓' : '✗'} {g.type}
            </span>
          ))}
        </div>
      )}

      {/* Abandonment warning */}
      {abandonment && (
        <div className="mt-1">
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-warning-muted text-warning"
            title={`Pattern: ${abandonment.pattern}`}
          >
            ⚠ Possible abandonment
          </span>
        </div>
      )}

      {/* Expandable detail view — auto-expand for active agents */}
      {(isExpanded || (isActive && agentOutput)) && (
        <div className="mt-3 pt-3 border-t border-border-subtle">
          {isActive && !agentOutput && (
            <div className="flex items-center gap-2 text-xs text-text-muted animate-pulse">
              <span className="w-1.5 h-1.5 bg-info rounded-full animate-ping" />
              Starting up...
            </div>
          )}
          {agentOutput && (
            <div ref={outputRef} className="bg-surface-base rounded p-2 max-h-48 overflow-y-auto">
              <pre className="text-xs text-text-body whitespace-pre-wrap font-mono">
                {agentOutput}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
