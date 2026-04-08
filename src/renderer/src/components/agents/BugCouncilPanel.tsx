import React, { useState } from 'react'
import {
  Search,
  Landmark,
  Puzzle,
  Link2,
  Swords,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Loader2
} from 'lucide-react'
import type { BugCouncilResult, BugCouncilPerspective } from '../../../../shared/types'

interface BugCouncilPanelProps {
  result: BugCouncilResult
}

const PERSPECTIVE_ICONS: Record<BugCouncilPerspective['role'], typeof Search> = {
  'root-cause-analyst': Search,
  'code-archaeologist': Landmark,
  'pattern-matcher': Puzzle,
  'systems-thinker': Link2,
  'adversarial-tester': Swords
}

const PERSPECTIVE_COLORS: Record<BugCouncilPerspective['role'], string> = {
  'root-cause-analyst': 'text-danger',
  'code-archaeologist': 'text-warning',
  'pattern-matcher': 'text-info',
  'systems-thinker': 'text-mode-plan-text',
  'adversarial-tester': 'text-success'
}

function ConfidenceBar({ confidence }: { confidence: number }): React.JSX.Element {
  const pct = Math.round(confidence * 100)
  const color = pct >= 80 ? 'bg-success' : pct >= 50 ? 'bg-warning' : 'bg-danger'

  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted">
      <div className="h-1.5 w-16 rounded-full bg-bg-tertiary overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span>{pct}%</span>
    </div>
  )
}

function PerspectiveCard({
  perspective
}: {
  perspective: BugCouncilPerspective
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const Icon = PERSPECTIVE_ICONS[perspective.role] ?? Search
  const color = PERSPECTIVE_COLORS[perspective.role] ?? 'text-fg-muted'

  return (
    <div className="rounded-lg border border-border-secondary bg-bg-secondary p-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <Icon size={16} className={color} />
          <span className="text-sm font-medium text-fg-primary">{perspective.displayName}</span>
          <ConfidenceBar confidence={perspective.confidence} />
        </div>
        {expanded ? (
          <ChevronUp size={14} className="text-fg-muted" />
        ) : (
          <ChevronDown size={14} className="text-fg-muted" />
        )}
      </button>

      {expanded && (
        <div className="mt-2 text-sm text-fg-secondary whitespace-pre-wrap">
          {perspective.finding}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: BugCouncilResult['status'] }): React.JSX.Element {
  switch (status) {
    case 'analyzing':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-info">
          <Loader2 size={12} className="animate-spin" />
          Analyzing
        </span>
      )
    case 'synthesizing':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-warning">
          <Loader2 size={12} className="animate-spin" />
          Synthesizing
        </span>
      )
    case 'complete':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-success">
          <CheckCircle size={12} />
          Complete
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1 text-xs text-danger">
          <XCircle size={12} />
          Failed
        </span>
      )
    default:
      return <span className="inline-flex items-center gap-1 text-xs text-fg-muted">Active</span>
  }
}

export default function BugCouncilPanel({ result }: BugCouncilPanelProps): React.JSX.Element {
  const [showDetails, setShowDetails] = useState(false)

  return (
    <div className="rounded-xl border border-border-primary bg-bg-primary shadow-md overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-bg-secondary border-b border-border-secondary">
        <div className="flex items-center gap-2">
          <Landmark size={18} className="text-info" />
          <h3 className="text-sm font-semibold text-fg-primary">Bug Council</h3>
          <StatusBadge status={result.status} />
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <span>{result.agentId}</span>
          <span className="text-fg-tertiary">/</span>
          <span>{result.taskId}</span>
        </div>
      </div>

      {/* Synthesized Solution */}
      {result.synthesizedSolution && (
        <div className="px-4 py-3 border-b border-border-secondary">
          <h4 className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-1.5">
            Synthesized Solution
          </h4>
          <p className="text-sm text-fg-primary whitespace-pre-wrap">
            {result.synthesizedSolution}
          </p>
        </div>
      )}

      {/* Risk Assessment */}
      {result.riskAssessment && (
        <div className="px-4 py-2.5 border-b border-border-secondary bg-warning-muted/20">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-warning mt-0.5 shrink-0" />
            <p className="text-xs text-fg-secondary">{result.riskAssessment}</p>
          </div>
        </div>
      )}

      {/* Final Attempt Result */}
      {result.finalAttemptSucceeded !== null && (
        <div className="px-4 py-2 border-b border-border-secondary">
          {result.finalAttemptSucceeded ? (
            <div className="flex items-center gap-2 text-sm text-success">
              <CheckCircle size={14} />
              Council guidance resolved the issue
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-danger">
              <XCircle size={14} />
              Final attempt still failed — escalating to human
            </div>
          )}
        </div>
      )}

      {/* Perspective Cards (collapsible) */}
      {result.perspectives.length > 0 && (
        <div className="px-4 py-2.5">
          <button
            type="button"
            onClick={() => setShowDetails(!showDetails)}
            className="flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg-secondary transition-colors"
          >
            {showDetails ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {showDetails ? 'Hide' : 'Show'} diagnostic perspectives ({result.perspectives.length})
          </button>

          {showDetails && (
            <div className="mt-2.5 flex flex-col gap-2">
              {result.perspectives.map((p) => (
                <PerspectiveCard key={p.role} perspective={p} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
