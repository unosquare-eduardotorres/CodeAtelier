import { CheckCircle, XCircle, Clock, Ban } from 'lucide-react'
import type { MpaPhaseType, MpaGoalType, MpaRunStatus } from '../../../../../shared/mpa-types'

// ── Phase Config ──

/** Shared phase display configuration — single source of truth for labels, emojis, and descriptions. */
export const PHASE_CONFIG: Record<
  MpaPhaseType,
  { label: string; emoji: string; agentLabel: string; description: string }
> = {
  plan: {
    label: 'Plan',
    emoji: '📋',
    agentLabel: 'Planner',
    description: 'Read-only architect investigates codebase and produces implementation plan'
  },
  execute: {
    label: 'Execute',
    emoji: '🔨',
    agentLabel: 'Builder',
    description: 'Builder implements every plan item in dependency order'
  },
  verify: {
    label: 'Verify',
    emoji: '✅',
    agentLabel: 'Verifier',
    description: 'Read-only verifier checks every item was actually implemented'
  }
}

// ── Goal Type Labels ──

export const GOAL_TYPE_LABELS: Record<MpaGoalType, { emoji: string; label: string }> = {
  feature: { emoji: '🟢', label: 'Feature' },
  refactor: { emoji: '🔵', label: 'Refactor' },
  bugfix: { emoji: '🟡', label: 'Bug Fix' },
  tests: { emoji: '🟣', label: 'Tests' }
}

/** Convenience: "🟢 Feature" format for detail views. */
export function formatGoalType(goalType: string): string {
  const config = GOAL_TYPE_LABELS[goalType as MpaGoalType]
  return config ? `${config.emoji} ${config.label}` : goalType
}

// ── Run Status Config ──

export const RUN_STATUS_CONFIG: Record<
  MpaRunStatus,
  { icon: React.ReactNode; color: string; label: string }
> = {
  completed: { icon: <CheckCircle size={14} />, color: 'text-success', label: 'Completed' },
  failed: { icon: <XCircle size={14} />, color: 'text-danger', label: 'Failed' },
  cancelled: { icon: <Ban size={14} />, color: 'text-text-muted', label: 'Cancelled' },
  running: { icon: <Clock size={14} />, color: 'text-accent', label: 'Running' },
  paused: { icon: <Clock size={14} />, color: 'text-purple-400', label: 'Paused' }
}
