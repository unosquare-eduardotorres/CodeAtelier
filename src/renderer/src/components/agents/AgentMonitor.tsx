import { useState, useEffect, useCallback } from 'react'
import {
  Monitor,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  OctagonX,
  RotateCcw
} from 'lucide-react'
import { useAgentStore, useSpecialistStore, useChatStore } from '@renderer/store'
import { AgentStatusCard, BugCouncilPanel } from '@renderer/components/agents'
import SpecialistInspector from './SpecialistInspector'
import type { BugCouncilResult } from '../../../../shared/types'

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return count.toString()
}

interface AgentMonitorProps {
  isCollapsed?: boolean
  onToggleCollapse?: () => void
  variant?: 'side' | 'bottom'
}

export default function AgentMonitor({
  isCollapsed,
  onToggleCollapse,
  variant = 'side'
}: AgentMonitorProps): React.JSX.Element {
  const statuses = useAgentStore((s) => s.statuses)
  const stopAllAgents = useAgentStore((s) => s.stopAllAgents)
  const isStopping = useAgentStore((s) => s.isStopping)
  const sessionTokens = useAgentStore((s) => s.sessionTokens)
  const appendOutput = useAgentStore((s) => s.appendOutput)
  const addGateResult = useAgentStore((s) => s.addGateResult)
  const markAbandonment = useAgentStore((s) => s.markAbandonment)
  const specialists = useSpecialistStore((s) => s.specialists)
  const loadSpecialists = useSpecialistStore((s) => s.loadSpecialists)
  const activeConversation = useChatStore((s) => s.activeConversation)

  const [checkpoints, setCheckpoints] = useState<
    { id: string; label: string; gitBranch?: string; gitCommitSha?: string; createdAt: string }[]
  >([])
  const [showCheckpoints, setShowCheckpoints] = useState(false)
  const [bugCouncilResults, setBugCouncilResults] = useState<BugCouncilResult[]>([])
  const [inspecting, setInspecting] = useState<{
    sessionId: string
    subagentId: string
  } | null>(null)

  // Load specialists on mount so AgentStatusCard can read metadata from DB
  useEffect(() => {
    if (specialists.length === 0) {
      loadSpecialists()
    }
  }, [specialists.length, loadSpecialists])

  // Memoize handler to avoid re-registering listener
  const handleTaskChunk = useCallback(
    (data: { agentId: string; taskId: string; text: string }) => {
      appendOutput(data.agentId, data.text)
    },
    [appendOutput]
  )

  // Listen for agent task chunks from main process
  useEffect(() => {
    const cleanup = window.api.onAgentTaskChunk(handleTaskChunk)
    return cleanup
  }, [handleTaskChunk])

  // Listen for gate failure events
  useEffect(() => {
    const cleanup = window.api.onGateFailure((data) => {
      addGateResult(data.specialist, data.gate)
    })
    return cleanup
  }, [addGateResult])

  // Listen for abandonment detection events
  useEffect(() => {
    const cleanup = window.api.onAbandonmentDetected((data) => {
      markAbandonment(data.specialist, data.pattern)
    })
    return cleanup
  }, [markAbandonment])

  // Listen for Bug Council completion events
  useEffect(() => {
    const cleanup = window.api.onBugCouncilComplete((data) => {
      setBugCouncilResults((prev) => [data.result, ...prev])
    })
    return cleanup
  }, [])

  // Handle specialist inspection — open the inspector panel for a specialist
  const handleInspect = useCallback(
    async (agentId: string) => {
      const sessionId = activeConversation?.claudeSessionId
      if (!sessionId) return
      try {
        const subagents = await window.api.sdkListSubagents({ sessionId })
        const match = subagents.find((s) => s.includes(agentId)) || subagents[0]
        if (match) {
          setInspecting({ sessionId, subagentId: match })
        }
      } catch (err) {
        console.error('Failed to list subagents:', err)
      }
    },
    [activeConversation?.claudeSessionId]
  )

  // Fetch checkpoints when conversation changes or all agents complete
  const allComplete =
    statuses.length > 0 && statuses.every((s) => s.status === 'completed' || s.status === 'failed')

  useEffect(() => {
    if (!activeConversation?.id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCheckpoints([])
      return
    }
    const convId = activeConversation.id
    window.api
      .listCheckpoints({ conversationId: convId })
      .then(setCheckpoints)
      .catch(() => setCheckpoints([]))
  }, [activeConversation?.id, allComplete])

  const handleRestore = async (checkpointId: string): Promise<void> => {
    const confirmed = window.confirm(
      'Restore this checkpoint? This will revert files to the checkpoint state.'
    )
    if (!confirmed) return
    try {
      const result = await window.api.restoreCheckpoint({ checkpointId })
      if (!result.success) {
        console.error('Checkpoint restore failed:', result.message)
      }
    } catch (err) {
      console.error('Failed to restore checkpoint:', err)
    }
  }

  // Filter: only show agents that are active or have been used (have tokens)
  const visibleStatuses = statuses.filter((s) => s.status !== 'idle' || s.tokenUsage > 0)

  const activeCount = statuses.filter(
    (s) => s.status === 'thinking' || s.status === 'writing' || s.status === 'reviewing'
  ).length

  const completedCount = statuses.filter((s) => s.status === 'completed').length
  const failedCount = statuses.filter((s) => s.status === 'failed').length

  // Collapsed state: slim bar
  if (isCollapsed) {
    if (variant === 'bottom') {
      return (
        <div className="flex items-center gap-3 px-3 py-2 bg-surface-raised w-full">
          <button
            onClick={onToggleCollapse}
            className="p-1.5 rounded-lg hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Expand agent panel"
            title="Expand agent panel"
          >
            <ChevronUp size={14} />
          </button>
          <Monitor size={14} className="text-primary-text" />
          <span className="text-xs text-text-secondary font-medium">Agent Monitor</span>
          {activeCount > 0 && (
            <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary text-[10px] font-semibold text-surface-base">
              {activeCount}
            </span>
          )}
        </div>
      )
    }

    return (
      <div className="flex flex-col items-center w-12 bg-surface-raised border-l border-border-subtle flex-shrink-0">
        {/* Header area — matches sidebar header height for continuous border line */}
        <div className="flex items-center justify-center w-full py-3 border-b border-border-subtle">
          <button
            onClick={onToggleCollapse}
            className="p-2 rounded-lg hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Expand agent panel"
            title="Expand agent panel"
          >
            <ChevronLeft size={16} />
          </button>
        </div>
        <div className="flex flex-col items-center gap-2 py-3">
          <Monitor size={16} className="text-primary-text" />
          {activeCount > 0 && (
            <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary text-[10px] font-semibold text-surface-base">
              {activeCount}
            </span>
          )}
        </div>
      </div>
    )
  }

  const CollapseIcon = variant === 'bottom' ? ChevronDown : ChevronRight

  return (
    <div
      className={
        variant === 'bottom'
          ? 'flex flex-col h-full bg-surface-raised w-full'
          : 'flex flex-col h-full bg-surface-raised border-l border-border-subtle w-[350px] flex-shrink-0'
      }
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <Monitor size={16} className="text-primary-text" />
          <span className="text-sm font-semibold text-text-primary">Agent Monitor</span>
        </div>
        <div className="flex items-center gap-2">
          {activeCount > 0 && (
            <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-primary text-[10px] font-semibold text-surface-base">
              {activeCount}
            </span>
          )}
          {visibleStatuses.length > 0 && (
            <button
              onClick={stopAllAgents}
              disabled={isStopping}
              className="p-1.5 rounded-md hover:bg-danger-muted text-text-secondary hover:text-danger transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Stop all agents"
              title="Stop all agents"
            >
              <OctagonX size={16} className={isStopping ? 'animate-pulse' : ''} />
            </button>
          )}
          <button
            onClick={onToggleCollapse}
            className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Collapse agent panel"
            title="Collapse agent panel"
          >
            <CollapseIcon size={16} />
          </button>
        </div>
      </div>

      {/* Agent list or Specialist Inspector */}
      {inspecting ? (
        <SpecialistInspector
          sessionId={inspecting.sessionId}
          subagentId={inspecting.subagentId}
          onClose={() => setInspecting(null)}
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {visibleStatuses.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Monitor size={32} className="text-border-default mb-3" />
              <p className="text-sm text-text-secondary mb-1">No agents active</p>
              <p className="text-xs text-text-muted">
                Agents will appear here when processing tasks
              </p>
            </div>
          ) : (
            visibleStatuses.map((status) => (
              <div
                key={status.agentId}
                onClick={() => handleInspect(status.agentId)}
                className="cursor-pointer"
              >
                <AgentStatusCard
                  status={status}
                  isSubagent={status.agentId.startsWith('subagent:')}
                />
              </div>
            ))
          )}
        </div>
      )}

      {/* Bug Council results */}
      {bugCouncilResults.length > 0 && (
        <div className="px-3 py-2 space-y-2 border-t border-border-subtle">
          {bugCouncilResults.map((result) => (
            <BugCouncilPanel key={result.sessionId} result={result} />
          ))}
        </div>
      )}

      {/* Checkpoints section */}
      {checkpoints.length > 0 && (
        <div className="px-3 py-2 border-t border-border-subtle">
          <button
            onClick={() => setShowCheckpoints(!showCheckpoints)}
            className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors w-full"
          >
            <RotateCcw size={12} />
            <span className="font-medium">Checkpoints ({checkpoints.length})</span>
          </button>
          {showCheckpoints && (
            <div className="mt-2 space-y-1">
              {checkpoints.map((cp) => (
                <div
                  key={cp.id}
                  className="flex items-center justify-between text-xs py-1 px-1 rounded hover:bg-surface-overlay"
                >
                  <span className="text-text-secondary truncate flex-1 mr-2" title={cp.label}>
                    {cp.label}
                  </span>
                  <button
                    onClick={() => handleRestore(cp.id)}
                    className="text-primary-text hover:underline flex-shrink-0"
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Summary footer */}
      {visibleStatuses.length > 0 && (
        <div className="px-4 py-2.5 border-t border-border-subtle text-xs text-text-secondary">
          <div className="flex justify-between">
            <span>
              {activeCount > 0 && `${activeCount} active · `}
              {completedCount} done
              {failedCount > 0 && ` · ${failedCount} failed`}
            </span>
            <span>{formatTokens(sessionTokens)} tokens this session</span>
          </div>
        </div>
      )}
    </div>
  )
}
