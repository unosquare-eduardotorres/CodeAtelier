/**
 * PlanProgressBar — compact sticky progress indicator for plan execution.
 *
 * Renders above the TodoTaskBar, showing which phase of a structured plan
 * the agent is currently working on. Driven by the emit_phase_progress MCP
 * tool and file-based inference fallback.
 *
 * Collapsed: single-line with phase count, current phase title, and dots.
 * Expanded: full phase list with status icons.
 */

import { useState, useEffect, useRef } from 'react'
import { CheckCircle2, Circle, ChevronDown, FileCode, Zap } from 'lucide-react'
import { usePlanExecutionStore } from '@renderer/store/plan-execution.store'
import { PHASE_STATUS_ICON, statusDotColor } from './plan-status-icons'

interface PlanProgressBarProps {
  conversationId: string
}

export default function PlanProgressBar({
  conversationId
}: PlanProgressBarProps): React.JSX.Element | null {
  const execution = usePlanExecutionStore((s) => s.executions[conversationId])
  const [expanded, setExpanded] = useState(false)
  const [autoClosed, setAutoClosed] = useState(false)
  const [hasAutoExpanded, setHasAutoExpanded] = useState(false)
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Shorten a file path to its last 2 segments for compact display
  const shortenPath = (filePath: string): string => {
    const parts = filePath.split('/')
    return parts.length > 2 ? parts.slice(-2).join('/') : filePath
  }

  // Auto-collapse 3s after all phases complete
  const completed = execution?.phases.filter((p) => p.status === 'completed').length ?? 0
  const allDone = execution ? completed === execution.totalPhases && execution.totalPhases > 0 : false

  useEffect(() => {
    if (allDone && !autoClosed) {
      autoCloseTimerRef.current = setTimeout(() => {
        setExpanded(false)
        setAutoClosed(true)
      }, 3000)
    }
    return () => {
      if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current)
    }
  }, [allDone, autoClosed])

  // ── Compute currentPhase unconditionally (undefined when no execution) ──
  const currentPhase = execution?.phases.find(
    (p) => p.status === 'started' || p.status === 'in_progress'
  )

  // ── Auto-expand when the first active phase appears ──
  useEffect(() => {
    if (!hasAutoExpanded && currentPhase) {
      setExpanded(true)
      setHasAutoExpanded(true)
    }
  }, [currentPhase, hasAutoExpanded])

  if (!execution || execution.phases.length === 0) return null

  return (
    <div className="mx-6 mb-2 rounded-lg border border-border-subtle bg-surface-overlay/60 backdrop-blur-sm overflow-hidden">
      {/* Collapsed header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2 text-sm transition-colors hover:bg-surface-overlay/80"
      >
        <span className="flex items-center gap-2">
          <Zap size={14} className={allDone ? 'text-success' : 'text-accent'} />
          <span className="font-medium text-text-body">Building:</span>
          <span className="tabular-nums text-text-secondary">
            Phase {completed}/{execution.totalPhases}
          </span>
          {currentPhase && (
            <span className="text-text-muted truncate max-w-[200px]">
              — {currentPhase.phaseTitle}
              {(() => {
                const phaseFileList = execution?.phaseFiles?.[currentPhase.phaseId] ?? []
                if (phaseFileList.length === 0) return null
                const touchedCount = currentPhase.touchedFiles.length
                return (
                  <span className="ml-1 tabular-nums text-text-muted">
                    ({touchedCount}/{phaseFileList.length} files)
                  </span>
                )
              })()}
            </span>
          )}
          {allDone && (
            <span className="text-success text-xs font-medium">✓ Complete</span>
          )}
        </span>
        <span className="flex items-center gap-2">
          {/* Progress dots */}
          <span className="flex gap-1">
            {execution.phases.map((p) => (
              <span
                key={p.phaseId}
                className={`w-2 h-2 rounded-full ${statusDotColor(p.status)}`}
              />
            ))}
          </span>
          <ChevronDown
            size={14}
            className={`text-text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
        </span>
      </button>

      {/* Expanded phase list */}
      {expanded && (
        <div className="border-t border-border-subtle px-2 py-1 max-h-60 overflow-y-auto">
          {execution.phases.map((phase) => {
            const phaseFileList = execution.phaseFiles?.[phase.phaseId] ?? []
            return (
              <div key={phase.phaseId}>
                <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
                  {PHASE_STATUS_ICON[phase.status] ?? PHASE_STATUS_ICON.pending}
                  <span
                    className={
                      phase.status === 'completed'
                        ? 'text-text-muted line-through'
                        : 'text-text-body'
                    }
                  >
                    {phase.phaseTitle}
                  </span>
                  {phaseFileList.length > 0 && phase.status !== 'pending' && (
                    <span className="ml-auto flex items-center gap-1 text-xs text-text-muted tabular-nums">
                      <FileCode size={10} />
                      {phase.touchedFiles.length}/{phaseFileList.length}
                    </span>
                  )}
                  {phase.message && !phaseFileList.length && (
                    <span className="text-xs text-text-muted ml-auto truncate max-w-[180px]">
                      {phase.message}
                    </span>
                  )}
                </div>
                {/* Per-file progress list under active/completed phases */}
                {phase.status !== 'pending' && phaseFileList.length > 0 && (
                  <div className="pl-7 space-y-0.5 pb-1">
                    {phaseFileList.map((file) => {
                      const normalizedFile = file.replace(/\\/g, '/')
                      const isTouched = phase.touchedFiles.some((t) => {
                        const normalizedT = t.replace(/\\/g, '/')
                        return normalizedT.endsWith(normalizedFile) ||
                          normalizedT.includes('/' + normalizedFile) ||
                          normalizedFile.endsWith(normalizedT) ||
                          normalizedFile.includes('/' + normalizedT)
                      })
                      return (
                        <div key={file} className="flex items-center gap-1.5 text-xs">
                          {isTouched
                            ? <CheckCircle2 size={10} className="text-success shrink-0" />
                            : <Circle size={10} className="text-text-muted shrink-0" />}
                          <span className="font-mono text-text-secondary truncate">{shortenPath(file)}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
