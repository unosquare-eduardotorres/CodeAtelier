/**
 * Shared components for phase deliverable renderers.
 *
 * Provides consistent layout primitives: DeliverableHeader, MetricTile,
 * DiscoveriesSection, and CappedMarkdown (full-width variant).
 */

import { useState, type JSX, type ComponentType } from 'react'
import { ChevronDown, Clock, Lightbulb } from 'lucide-react'
import { BlueprintMarkdown } from '../BlueprintMarkdown'
import type { PhaseIconConfig } from '../phase-icons'
import { formatDurationMs } from '../detail/phase-summaries'
import { stripBlueprintBlocks } from '../../../../../../shared/blueprint-clarify-parsers'

// ── DeliverableHeader ──

export function DeliverableHeader({
  config,
  summary,
  duration
}: {
  config: PhaseIconConfig
  summary: string
  duration: number | null
}): JSX.Element {
  const Icon = config.icon
  return (
    <div className="flex items-center gap-4 mb-6">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-surface-overlay border border-border-subtle">
        <Icon size={20} className="text-accent" />
      </div>
      <div className="flex-1 min-w-0">
        <h2 className="text-lg font-semibold text-text-primary">{config.label} Phase</h2>
        <p className="text-sm text-text-secondary">{summary}</p>
      </div>
      {duration != null && (
        <span className="text-sm text-text-muted tabular-nums font-mono flex-shrink-0">
          <Clock size={14} className="inline mr-1" />
          {formatDurationMs(duration)}
        </span>
      )}
    </div>
  )
}

// ── MetricTile ──

export function MetricTile({
  label,
  value,
  icon: Icon,
  variant = 'default'
}: {
  label: string
  value: string | number
  icon?: ComponentType<{ size?: number; className?: string }>
  variant?: 'default' | 'success' | 'danger' | 'warning'
}): JSX.Element {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface-raised px-4 py-3">
      <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wider mb-1">
        {Icon && <Icon size={12} className="inline mr-1" />}
        {label}
      </div>
      <div
        className={`text-lg font-semibold tabular-nums ${
          variant === 'success'
            ? 'text-success'
            : variant === 'danger'
              ? 'text-danger'
              : variant === 'warning'
                ? 'text-warning'
                : 'text-text-primary'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

// ── DiscoveriesSection ──

export function DiscoveriesSection({
  discoveries
}: {
  discoveries: string[] | undefined
}): JSX.Element | null {
  if (!discoveries?.length) return null
  return (
    <div className="mt-6">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
        <Lightbulb size={12} className="inline mr-1 text-warning" />
        Discoveries
      </h3>
      <div className="space-y-2">
        {discoveries.map((d, i) => (
          <div
            key={i}
            className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning/5 border border-warning/10"
          >
            <span className="text-warning mt-0.5">•</span>
            <span className="text-sm text-text-secondary">{d}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Strip raw JSON from deliverable markdown ──

function stripDeliverableJsonBlocks(text: string): string {
  // 1. Strip known blueprint-* fenced blocks (clarify-findings, phase-complete, etc.)
  let cleaned = stripBlueprintBlocks(text)

  // 2. Strip generic ```json blocks containing phase completion data
  //    (matches { "phase": "...", "status": "..." } patterns)
  cleaned = cleaned.replace(
    /`{3,}\s*(?:json)?\s*\n\s*\{[\s\S]*?"phase"\s*:\s*"[\s\S]*?"status"\s*:[\s\S]*?\n`{3,}/g,
    ''
  )

  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

// ── CappedMarkdown (full-width variant with configurable height) ──

export function CappedMarkdownBlock({
  content,
  maxH = 'max-h-[600px]',
  label = 'Full Content',
  className = 'mt-6'
}: {
  content: string
  maxH?: string
  label?: string
  className?: string
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={className}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider">{label}</h3>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 font-medium transition-colors"
        >
          <ChevronDown
            size={12}
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      <div className={expanded ? '' : `${maxH} overflow-hidden relative`}>
        <BlueprintMarkdown>{stripDeliverableJsonBlocks(content)}</BlueprintMarkdown>
        {!expanded && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-surface-raised to-transparent pointer-events-none" />
        )}
      </div>
    </div>
  )
}
