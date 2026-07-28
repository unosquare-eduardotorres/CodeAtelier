/**
 * plan-constants — shared configuration for plan source badges, type badges,
 * status indicators, formatters, and metric builders.
 *
 * Extracted from PlanCard so PlanCard and PlanDetailPage can both share them.
 */

import type { PlanRecord, PlanSource, PlanStatus } from '../../../../../shared/types'

// ── Source badge config ──

export const SOURCE_CONFIG: Record<PlanSource, { emoji: string; label: string; color: string }> = {
  chat: { emoji: '💬', label: 'Chat', color: 'text-primary-text' },
  grill: { emoji: '🔥', label: 'Grill', color: 'text-accent' },
  audit: { emoji: '🔍', label: 'Audit', color: 'text-success' },
  council: { emoji: '🏛️', label: 'Council', color: 'text-indigo-400' },
  mpa: { emoji: '🎯', label: 'Goals', color: 'text-cyan-400' },
  blueprint: { emoji: '📘', label: 'Blueprint', color: 'text-info' }
}

// ── Plan type badge config ──

export const TYPE_CONFIG: Record<string, { label: string; classes: string }> = {
  feature: { label: 'Feature', classes: 'bg-info-muted text-info' },
  refactor: { label: 'Refactor', classes: 'bg-warning-muted text-warning' },
  bug: { label: 'Bug Fix', classes: 'bg-danger-muted text-danger' },
  audit: { label: 'Audit', classes: 'bg-primary-muted text-primary-text' },
  investigation: { label: 'Investigation', classes: 'bg-surface-overlay text-text-secondary' }
}

// ── Status config ──

export const STATUS_CONFIG: Record<
  PlanStatus,
  { label: string; dotColor: string; textColor: string }
> = {
  saved: { label: 'Saved', dotColor: 'bg-info', textColor: 'text-info' },
  handed_off: { label: 'Handed off', dotColor: 'bg-warning', textColor: 'text-warning' },
  in_progress: {
    label: 'In Progress',
    dotColor: 'bg-success animate-pulse',
    textColor: 'text-success'
  },
  completed: { label: 'Completed', dotColor: 'bg-success', textColor: 'text-success' },
  archived: { label: 'Archived', dotColor: 'bg-text-muted', textColor: 'text-text-muted' }
}

// ── Formatters ──

export function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function buildMetrics(plan: PlanRecord): string {
  const parts: string[] = []
  if (plan.phaseCount > 0) parts.push(`${plan.phaseCount} phase${plan.phaseCount !== 1 ? 's' : ''}`)
  if (plan.riskCount > 0) parts.push(`${plan.riskCount} risk${plan.riskCount !== 1 ? 's' : ''}`)
  if (plan.fileCount > 0) parts.push(`${plan.fileCount} file${plan.fileCount !== 1 ? 's' : ''}`)
  return parts.join(' · ')
}
