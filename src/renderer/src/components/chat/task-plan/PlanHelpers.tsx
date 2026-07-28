import { useState } from 'react'
import type { ReactNode } from 'react'
import { ClipboardList, ChevronDown, ChevronRight, CheckCircle2, Circle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkStripStrayBackticks } from '../remark-plugins'
import type { PlanRootCause, PlanPhase } from '../../../../../shared/types'
import { usePlanExecutionStore } from '@renderer/store/plan-execution.store'
import { PHASE_STATUS_ICON } from '../plan-status-icons'

function shortenPath(filePath: string): string {
  const parts = filePath.split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : filePath
}

function riskColor(risk: 'low' | 'medium' | 'high'): string {
  if (risk === 'low') return 'text-success'
  if (risk === 'medium') return 'text-warning'
  return 'text-danger'
}

// ── SectionCard — reusable wrapper ──

export function SectionCard({
  icon: Icon,
  iconColor,
  label,
  className = 'pt-3 border-t border-border-subtle',
  labelColor = 'text-text-secondary',
  children
}: {
  icon: LucideIcon
  iconColor?: string
  label: string
  className?: string
  labelColor?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className={className}>
      <div className={`flex items-center gap-2 text-sm font-semibold ${labelColor} mb-2`}>
        <Icon size={14} className={iconColor} />
        {label}
      </div>
      {children}
    </div>
  )
}

export function RootCausesList({ rootCauses }: { rootCauses: PlanRootCause[] }): React.JSX.Element {
  return (
    <div className="space-y-3">
      {rootCauses.map((rc) => (
        <div
          key={`root-cause-${rc.id}`}
          className="rounded border-l-4 border-danger bg-surface-base/40 p-4"
        >
          <div className="text-sm font-semibold text-text-primary mb-1">
            Root Cause {rc.id} — {rc.title}
          </div>
          <div className="text-sm text-text-body prose prose-sm prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>
              {rc.description}
            </ReactMarkdown>
          </div>
          {rc.symptom && (
            <div className="mt-2 text-xs text-text-secondary">
              <span className="font-semibold text-warning">Symptom:</span> {rc.symptom}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

export function ComplexityIndicator({ score }: { score: number }): React.JSX.Element {
  const filled = Math.ceil(score / 2)
  return (
    <div className="flex items-center gap-1" title={`Complexity: ${score}/10`}>
      <span className="text-xs text-text-secondary mr-0.5">{score}</span>
      <div className="flex gap-px">
        {Array.from({ length: 5 }, (_, i) => (
          <div
            key={i}
            className={`w-1 h-2.5 rounded-sm ${
              i < filled
                ? score <= 3
                  ? 'bg-success'
                  : score <= 6
                    ? 'bg-warning'
                    : 'bg-danger'
                : 'bg-surface-base/60'
            }`}
          />
        ))}
      </div>
    </div>
  )
}

export function RiskDot({ risk }: { risk: 'low' | 'medium' | 'high' }): React.JSX.Element {
  const dotColor = risk === 'low' ? 'bg-success' : risk === 'medium' ? 'bg-warning' : 'bg-danger'
  return (
    <span className="flex items-center gap-1 text-xs">
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
      <span className={`capitalize ${riskColor(risk)}`}>{risk}</span>
    </span>
  )
}

export function PhasesList({
  phases,
  simple = false,
  conversationId
}: {
  phases: PlanPhase[]
  simple?: boolean
  conversationId?: string
}): React.JSX.Element {
  const execution = usePlanExecutionStore((s) =>
    conversationId ? s.executions[conversationId] : undefined
  )
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const toggle = (id: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const riskBorderColor = (risk: 'low' | 'medium' | 'high'): string =>
    risk === 'low' ? 'border-l-success' : risk === 'medium' ? 'border-l-warning' : 'border-l-danger'

  const isFileTouched = (phase: PlanPhase, filePath: string): boolean => {
    const phaseExec = execution?.phases.find((p) => p.phaseId === phase.id)
    if (!phaseExec) return false
    const normalizedFile = filePath.replace(/\\/g, '/')
    return phaseExec.touchedFiles.some((t) => {
      const normalizedT = t.replace(/\\/g, '/')
      return normalizedT.endsWith(normalizedFile) ||
        normalizedT.includes('/' + normalizedFile) ||
        normalizedFile.endsWith(normalizedT) ||
        normalizedFile.includes('/' + normalizedT)
    })
  }

  const renderPhaseContent = (phase: PlanPhase): React.JSX.Element => {
    const phaseExec = execution?.phases.find((p) => p.phaseId === phase.id)
    const isActive = phaseExec && phaseExec.status !== 'pending'
    return (
    <div className="px-4 pb-4 border-t border-[var(--color-plan-card-phase-border)]">
      <div className="pt-3 text-sm text-text-body prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>
          {phase.description}
        </ReactMarkdown>
      </div>
      {phase.files && phase.files.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="font-semibold text-text-secondary uppercase tracking-wide">Files</span>
            {phaseExec && phaseExec.touchedFiles.length > 0 && (
              <span className="text-text-muted tabular-nums">
                {phaseExec.touchedFiles.length}/{phase.files.length} modified
              </span>
            )}
          </div>
          <div className="space-y-1">
            {phase.files.map((f, fi) => {
              const touched = isActive && isFileTouched(phase, f.file)
              return (
              <div key={`phase-file-${fi}`} className="flex items-center gap-2 text-xs py-0.5">
                {isActive && (
                  touched
                    ? <CheckCircle2 size={10} className="text-success shrink-0" />
                    : <Circle size={10} className="text-text-muted shrink-0" />
                )}
                <span className="text-[var(--color-plan-card)] font-mono shrink-0 bg-[var(--color-plan-card-muted)] px-1.5 py-0.5 rounded">
                  {shortenPath(f.file)}
                </span>
                <span className="text-text-secondary">{f.change}</span>
              </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
    )
  }

  if (simple) {
    return (
      <div className="space-y-4">
        {phases.map((phase) => {
          const phaseStatus = execution?.phases.find((p) => p.phaseId === phase.id)
          return (
          <div key={`phase-simple-${phase.id}`}>
            <div className="flex items-center gap-2 mb-1.5">
              {phaseStatus ? (
                <span className="shrink-0">{PHASE_STATUS_ICON[phaseStatus.status]}</span>
              ) : (
              <span className="w-5 h-5 rounded bg-[var(--color-plan-card-muted)] text-[var(--color-plan-card)] text-xs flex items-center justify-center font-mono shrink-0">
                {phase.id}
              </span>
              )}
              <span className="text-sm font-medium text-text-primary flex-1">{phase.title}</span>
              <div className="flex items-center gap-3 shrink-0 text-xs">
                <ComplexityIndicator score={phase.complexity} />
                {phase.fileCount != null && (
                  <span className="text-text-secondary">~{phase.fileCount} files</span>
                )}
                <RiskDot risk={phase.risk} />
              </div>
            </div>
            <div className="pl-7 text-sm text-text-body prose prose-sm prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkStripStrayBackticks]}>
                {phase.description}
              </ReactMarkdown>
            </div>
            {phase.files && phase.files.length > 0 && (
              <div className="pl-7 mt-2">
                {phaseStatus && phaseStatus.touchedFiles.length > 0 && (
                  <div className="text-xs text-text-muted tabular-nums mb-1">
                    {phaseStatus.touchedFiles.length}/{phase.files.length} modified
                  </div>
                )}
                <div className="space-y-1">
                  {phase.files.map((f, fi) => {
                    const isActivePhase = phaseStatus && phaseStatus.status !== 'pending'
                    const touched = isActivePhase && isFileTouched(phase, f.file)
                    return (
                    <div
                      key={`phase-file-${fi}`}
                      className="flex items-center gap-2 text-xs py-0.5"
                    >
                      {isActivePhase && (
                        touched
                          ? <CheckCircle2 size={10} className="text-success shrink-0" />
                          : <Circle size={10} className="text-text-muted shrink-0" />
                      )}
                      <span className="text-[var(--color-plan-card)] font-mono shrink-0 bg-[var(--color-plan-card-muted)] px-1.5 py-0.5 rounded">
                        {shortenPath(f.file)}
                      </span>
                      <span className="text-text-secondary">{f.change}</span>
                    </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )})
      }
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <ClipboardList size={14} className="text-[var(--color-plan-card-accent)]" />
        Implementation Phases
      </div>
      <div className="space-y-2">
        {phases.map((phase) => {
          const isOpen = expanded.has(phase.id)
          const phaseStatus = execution?.phases.find((p) => p.phaseId === phase.id)
          return (
            <div
              key={`phase-${phase.id}`}
              className={`rounded border border-[var(--color-plan-card-phase-border)] ${riskBorderColor(phase.risk)} border-l-4 bg-[var(--color-plan-card-phase-bg)] overflow-hidden`}
            >
              <button
                type="button"
                onClick={() => toggle(phase.id)}
                className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-[var(--color-plan-card-section-bg)] transition-colors"
              >
                {isOpen ? (
                  <ChevronDown size={14} className="text-text-secondary shrink-0" />
                ) : (
                  <ChevronRight size={14} className="text-text-secondary shrink-0" />
                )}
                {phaseStatus ? (
                  <span className="shrink-0">{PHASE_STATUS_ICON[phaseStatus.status]}</span>
                ) : (
                <span className="w-5 h-5 rounded bg-[var(--color-plan-card-muted)] text-[var(--color-plan-card)] text-xs flex items-center justify-center font-mono shrink-0">
                  {phase.id}
                </span>
                )}
                <span className="text-sm font-medium text-text-primary truncate flex-1">
                  {phase.title}
                </span>
                <div className="flex items-center gap-3 shrink-0 text-xs">
                  <ComplexityIndicator score={phase.complexity} />
                  {phase.fileCount != null && (
                    <span className="text-text-secondary">~{phase.fileCount} files</span>
                  )}
                  <RiskDot risk={phase.risk} />
                </div>
              </button>
              {isOpen && renderPhaseContent(phase)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
