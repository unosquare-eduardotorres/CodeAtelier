/**
 * detail/primitives — shared presentation primitives for the blueprint
 * detail surface. One banner shape, one clamp-markdown, one verdict-tone
 * mapper, one section heading. These replace the per-banner copy-paste
 * vocabulary the detail view had accumulated (8 banner variants, 3 clamp
 * components, 4 private verdict mappers — impeccable focused review,
 * 2026-09-09).
 */

import { useState, type JSX } from 'react'
import { ChevronDown, AlertTriangle, XCircle, StopCircle, CheckCircle2 } from 'lucide-react'
import { BlueprintMarkdown } from '../BlueprintMarkdown'
import { stripBlueprintBlocks } from '../../../../../../shared/blueprint-clarify-parsers'

// ── Banner — the ONE outcome banner shape ──

export type BannerTone = 'success' | 'warning' | 'danger' | 'info' | 'accent'

const TONE_CLASSES: Record<BannerTone, { border: string; bg: string; text: string }> = {
  success: { border: 'border-success/20', bg: 'bg-success-muted', text: 'text-success' },
  warning: { border: 'border-warning/20', bg: 'bg-warning-muted', text: 'text-warning' },
  danger: { border: 'border-danger/20', bg: 'bg-danger-muted', text: 'text-danger' },
  info: { border: 'border-info/20', bg: 'bg-info-muted', text: 'text-info' },
  accent: { border: 'border-accent/20', bg: 'bg-accent-muted', text: 'text-accent' }
}

export function Banner({
  tone,
  title,
  children,
  actions,
  testId
}: {
  tone: BannerTone
  title: string
  children?: React.ReactNode
  actions?: React.ReactNode
  testId?: string
}): JSX.Element {
  const cls = TONE_CLASSES[tone]
  const Icon =
    tone === 'danger'
      ? XCircle
      : tone === 'info'
        ? StopCircle
        : tone === 'success'
          ? CheckCircle2
          : AlertTriangle
  return (
    <div
      data-testid={testId}
      className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${cls.border} ${cls.bg} ${cls.text}`}
    >
      <Icon size={16} className="mt-0.5 flex-shrink-0" />
      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
        <span className="text-sm font-medium">{title}</span>
        {children}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  )
}

// ── ClampMarkdown — the ONE capped-markdown viewer ──

/** Strip raw JSON from deliverable markdown before rendering. */
function stripDeliverableJsonBlocks(text: string): string {
  let cleaned = stripBlueprintBlocks(text)
  cleaned = cleaned.replace(
    /`{3,}\s*(?:json)?\s*\n\s*\{[\s\S]*?"phase"\s*:\s*"[\s\S]*?"status"\s*:[\s\S]*?\n`{3,}/g,
    ''
  )
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

export function ClampMarkdown({
  content,
  maxH = 'max-h-96',
  label,
  className = '',
  strip = false
}: {
  content: string
  maxH?: string
  label?: string
  className?: string
  strip?: boolean
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const body = strip ? stripDeliverableJsonBlocks(content) : content
  return (
    <div className={className}>
      {label && (
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
          {label}
        </h3>
      )}
      <div className={expanded ? '' : `${maxH} overflow-hidden relative`}>
        <BlueprintMarkdown>{body}</BlueprintMarkdown>
        {!expanded && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-surface-raised to-transparent pointer-events-none" />
        )}
      </div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 font-medium mt-1.5 transition-colors"
      >
        <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  )
}

// ── verdictTone — the ONE verdict → tone/icon-label mapper ──

const VERDICT_TONES: Record<string, { tone: BannerTone; label: string }> = {
  pass: { tone: 'success', label: 'Passed' },
  passed: { tone: 'success', label: 'Passed' },
  approve: { tone: 'success', label: 'Approved' },
  approved: { tone: 'success', label: 'Approved' },
  complete: { tone: 'success', label: 'Complete' },
  proceed: { tone: 'success', label: 'Proceed' },
  fix_first: { tone: 'warning', label: 'Fix first' },
  gaps_found: { tone: 'warning', label: 'Gaps found' },
  human_needed: { tone: 'warning', label: 'Human review needed' },
  revise: { tone: 'warning', label: 'Revise' },
  warning: { tone: 'warning', label: 'Warning' },
  fail: { tone: 'danger', label: 'Failed' },
  failed: { tone: 'danger', label: 'Failed' },
  reject: { tone: 'danger', label: 'Rejected' },
  blocked: { tone: 'danger', label: 'Blocked' }
}

// eslint-disable-next-line react-refresh/only-export-components -- intentional co-located helper (same pattern as SETTINGS_MENU)
export function verdictTone(verdict: string): { tone: BannerTone; label: string } {
  return VERDICT_TONES[verdict.toLowerCase()] ?? { tone: 'info', label: verdict }
}

// ── SectionHeading — the ONE section heading ──

export function SectionHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
      {children}
    </h3>
  )
}
