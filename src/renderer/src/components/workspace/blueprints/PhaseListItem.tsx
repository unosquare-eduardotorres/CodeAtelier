// @ts-nocheck — TODO: fix after blueprint refactoring
import type { JSX } from 'react'
import {
  CheckCircle2,
  XCircle,
  ChevronRight,
  ChevronDown,
  RotateCcw,
  Copy,
  Check
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { StatusBadge, formatTimeAgo, PHASE_CONFIG } from '.'

// ── Status icon map ──

const STATUS_ICON_MAP: Record<string, JSX.Element> = {
  complete: <CheckCircle2 size={14} className="text-success flex-shrink-0" />,
  failed: <XCircle size={14} className="text-danger flex-shrink-0" />
}

// ── Duration formatter ──

function formatDuration(startedAt: string, completedAt: string): string | null {
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

// ── Types ──

interface PhaseData {
  id: string
  phase: string
  status: string
  startedAt?: string | null
  completedAt?: string | null
  artifactsJson: Array<{
    type?: string
    filePath?: string
    contentMd?: string
    contentJson?: unknown
  }>
}

interface PhaseListItemProps {
  phase: PhaseData
  blueprintStatus: string
  isExpanded: boolean
  copiedArtifact: string | null
  onToggleExpand: (phaseId: string) => void
  onCopiedArtifact: (v: string | null) => void
  onRetryPhase: () => void
}

export function PhaseListItem({
  phase,
  blueprintStatus,
  isExpanded,
  copiedArtifact,
  onToggleExpand,
  onCopiedArtifact,
  onRetryPhase
}: PhaseListItemProps): JSX.Element {
  const phaseConfig = PHASE_CONFIG[phase.phase as keyof typeof PHASE_CONFIG]
  const PhaseIcon = phaseConfig?.icon
  const hasArtifacts = phase.artifactsJson && phase.artifactsJson.length > 0
  const isExpandable = hasArtifacts && (phase.status === 'complete' || phase.status === 'failed')

  const durationStr =
    phase.startedAt && phase.completedAt
      ? formatDuration(phase.startedAt, phase.completedAt)
      : null

  // Resolve status icon — use map for complete/failed, fallback to phase-specific icon
  const statusIcon =
    STATUS_ICON_MAP[phase.status] ??
    (PhaseIcon ? (
      <PhaseIcon size={14} className={`${phaseConfig.color} flex-shrink-0`} />
    ) : (
      <div className="w-3.5 h-3.5 rounded-full border border-border-subtle flex-shrink-0" />
    ))

  return (
    <div data-testid={`phase-list-item-${phase.id}`} className="rounded-lg bg-surface-base border border-border-subtle overflow-hidden">
      <div
        className={`flex items-center gap-3 px-3 py-2 ${isExpandable ? 'cursor-pointer hover:bg-surface-hover transition-colors' : ''}`}
        onClick={isExpandable ? () => onToggleExpand(phase.id) : undefined}
        role={isExpandable ? 'button' : undefined}
        tabIndex={isExpandable ? 0 : undefined}
        onKeyDown={
          isExpandable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onToggleExpand(phase.id)
                }
              }
            : undefined
        }
      >
        {isExpandable &&
          (isExpanded ? (
            <ChevronDown size={12} className="text-text-muted flex-shrink-0" />
          ) : (
            <ChevronRight size={12} className="text-text-muted flex-shrink-0" />
          ))}

        {statusIcon}

        <span className="text-xs font-medium text-text-primary">
          {phaseConfig?.label ?? phase.phase}
        </span>
        <StatusBadge status={phase.status} />

        {phase.status === 'failed' && blueprintStatus === 'failed' && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRetryPhase()
            }}
            className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-primary-text bg-primary-muted border border-primary/20 rounded hover:bg-primary/20 transition-colors ml-auto"
          >
            <RotateCcw size={10} />
            Retry
          </button>
        )}

        {phase.completedAt && (
          <span className="text-[10px] text-text-muted ml-auto">
            {formatTimeAgo(new Date(phase.completedAt))}
            {durationStr && <span className="ml-1 opacity-60">· {durationStr}</span>}
          </span>
        )}
      </div>

      {/* Expanded artifact content */}
      {isExpanded && hasArtifacts && (
        <div className="border-t border-border-subtle px-4 py-3 space-y-3">
          {phase.artifactsJson.map((artifact, artIdx) => (
            <ArtifactItem
              key={artIdx}
              artifact={artifact}
              phaseId={phase.id}
              artIdx={artIdx}
              copiedArtifact={copiedArtifact}
              onCopiedArtifact={onCopiedArtifact}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Artifact item ──

function ArtifactItem({
  artifact,
  phaseId,
  artIdx,
  copiedArtifact,
  onCopiedArtifact
}: {
  artifact: { type?: string; filePath?: string; contentMd?: string; contentJson?: unknown }
  phaseId: string
  artIdx: number
  copiedArtifact: string | null
  onCopiedArtifact: (v: string | null) => void
}): JSX.Element {
  const key = `${phaseId}-${artIdx}`
  const isCopied = copiedArtifact === key

  const handleCopy = (): void => {
    const text = artifact.contentMd ?? JSON.stringify(artifact.contentJson, null, 2)
    navigator.clipboard.writeText(text)
    onCopiedArtifact(key)
    setTimeout(() => onCopiedArtifact(null), 2000)
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {artifact.type && (
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wide flex-1">
            {artifact.type}
            {artifact.filePath ? ` · ${artifact.filePath}` : ''}
          </span>
        )}
        {(artifact.contentMd || artifact.contentJson) && (
          <button
            type="button"
            onClick={handleCopy}
            data-testid={`phase-artifact-copy-${key}`}
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-primary transition-colors rounded hover:bg-surface-hover"
            title="Copy to clipboard"
          >
            {isCopied ? (
              <>
                <Check size={10} className="text-success" /> Copied
              </>
            ) : (
              <>
                <Copy size={10} /> Copy
              </>
            )}
          </button>
        )}
      </div>
      {artifact.contentMd && (
        <div
          className="prose prose-sm prose-invert max-w-none text-text-primary
          prose-headings:text-text-primary prose-headings:font-semibold prose-headings:text-sm
          prose-p:text-xs prose-p:my-1
          prose-li:text-xs prose-ul:my-1 prose-ol:my-1
          prose-code:text-xs prose-code:bg-surface-hover prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-emerald-300 prose-code:before:content-none prose-code:after:content-none
          prose-pre:bg-surface-base prose-pre:border prose-pre:border-border-subtle prose-pre:rounded-lg prose-pre:my-1.5
          prose-strong:text-text-primary"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
            {artifact.contentMd}
          </ReactMarkdown>
        </div>
      )}
      {artifact.contentJson && !artifact.contentMd && (
        <pre className="text-[10px] font-mono text-text-secondary bg-surface-base border border-border-subtle rounded-lg p-2 overflow-x-auto">
          {JSON.stringify(artifact.contentJson, null, 2)}
        </pre>
      )}
    </div>
  )
}
