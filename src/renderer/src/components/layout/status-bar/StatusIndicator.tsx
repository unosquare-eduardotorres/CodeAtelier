/**
 * StatusIndicator — shared 3-state indicator component for StatusBar segments.
 * Also exports compute* helpers that determine indicator state/label/title.
 */

import {
  ShieldCheck,
  Flame,
  Target,
  Landmark,
  Database
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

export type IndicatorState = 'active' | 'attention' | 'idle' | 'error' | 'hidden'

export interface StatusIndicatorProps {
  icon: React.ElementType
  label?: string
  state: IndicatorState
  activeColor?: 'danger' | 'cyan' | 'purple'
  title: string
  onClick: () => void
  badge?: string | number | null
}

// ── Color tables ─────────────────────────────────────────────────────────────

const ACTIVE_COLORS: Record<'danger' | 'cyan' | 'purple', string> = {
  danger: 'text-danger bg-danger/10 hover:bg-danger/20',
  cyan: 'text-cyan-400 bg-cyan-400/10 hover:bg-cyan-400/20',
  purple: 'text-purple-400 bg-purple-400/10 hover:bg-purple-400/20'
}

const STATE_COLORS: Record<'attention' | 'idle' | 'error', string> = {
  attention: 'text-purple-400 bg-purple-400/10 hover:bg-purple-400/20',
  idle: 'text-text-muted hover:text-text-secondary',
  error: 'text-danger bg-danger/10 hover:bg-danger/20'
}

// ── Component ────────────────────────────────────────────────────────────────

export function StatusIndicator({
  icon: Icon,
  label,
  state,
  activeColor = 'danger',
  title,
  onClick,
  badge
}: StatusIndicatorProps): React.JSX.Element | null {
  if (state === 'hidden') return null

  const colorClass = state === 'active' ? ACTIVE_COLORS[activeColor] : STATE_COLORS[state]

  return (
    <div className="flex items-center gap-1.5 border-l border-border-subtle pl-3 ml-1">
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-1 text-[11px] ${colorClass} rounded px-1.5 py-0.5 transition-colors`}
        title={title}
      >
        <Icon size={11} className={state === 'active' ? 'animate-pulse' : undefined} />
        {label && <span className="font-medium">{label}</span>}
        {badge != null && <span className="font-mono text-[10px]">{badge}</span>}
      </button>
    </div>
  )
}

// ── Compute helpers ─────────────────────────────────────────────────────────

const INDEXING_ACTIVE_STATUSES = new Set(['indexing-chunks', 'embedding', 'preprocessing', 'scanning'])

export function computeAuditIndicator(
  isActive: boolean,
  isPaused: boolean,
  lastScore: number | null,
  onClick: () => void
): StatusIndicatorProps {
  if (isActive && !isPaused) {
    return { icon: ShieldCheck, state: 'active', activeColor: 'danger', label: 'Auditing…', title: 'Audit in progress', onClick }
  }
  if (isPaused) {
    return { icon: ShieldCheck, state: 'attention', activeColor: 'danger', label: 'Paused', title: 'Audit paused — click to resume', onClick }
  }
  return {
    icon: ShieldCheck, state: 'idle', activeColor: 'danger',
    title: lastScore !== null ? `Last audit score: ${lastScore}` : 'Run a workspace audit',
    badge: lastScore, onClick
  }
}

export function computeGrillIndicator(
  grillStatus: { status: string; ideaId: string } | null,
  onNavigateToGrill: (ideaId: string) => void,
  onNavigateToSettings: (tab: string) => void
): StatusIndicatorProps {
  if (grillStatus?.status === 'evaluating') {
    return {
      icon: Flame, state: 'active', activeColor: 'danger', label: 'Grilling…',
      title: 'Grill in progress', onClick: () => onNavigateToGrill(grillStatus.ideaId)
    }
  }
  if (grillStatus?.status === 'awaiting_answers') {
    return {
      icon: Flame, state: 'attention', activeColor: 'danger', label: 'Needs Attention',
      title: 'Grill needs your answers', onClick: () => onNavigateToGrill(grillStatus.ideaId)
    }
  }
  return { icon: Flame, state: 'idle', activeColor: 'danger', title: 'Grill an idea', onClick: () => onNavigateToSettings('ideas') }
}

export interface MpaStatusInfo {
  status: string
  currentPhase: string | null
  phaseIndex: number
  totalPhases: number
}

export function computeGoalIndicator(
  mpaStatus: MpaStatusInfo | null | undefined,
  onClick: () => void
): StatusIndicatorProps {
  if (mpaStatus?.status === 'running') {
    return {
      icon: Target, state: 'active', activeColor: 'cyan',
      label: `Goal: ${mpaStatus.currentPhase ?? '…'} (${mpaStatus.phaseIndex}/${mpaStatus.totalPhases})`,
      title: `Goal in progress — ${mpaStatus.currentPhase ?? 'starting'}`, onClick
    }
  }
  if (mpaStatus?.status === 'paused') {
    return { icon: Target, state: 'attention', activeColor: 'cyan', label: 'Review Plan', title: 'Goal needs your approval', onClick }
  }
  return { icon: Target, state: 'idle', activeColor: 'cyan', title: 'Goals', onClick }
}

export function computeCouncilIndicator(
  councilPhase: string | null,
  onClick: () => void
): StatusIndicatorProps {
  if (councilPhase === 'deliberating') {
    return { icon: Landmark, state: 'active', activeColor: 'purple', label: 'Council…', title: 'Council deliberating', onClick }
  }
  if (councilPhase === 'peer-review') {
    return { icon: Landmark, state: 'active', activeColor: 'purple', label: 'Peer Review', title: 'Council peer review', onClick }
  }
  if (councilPhase === 'synthesizing') {
    return { icon: Landmark, state: 'attention', activeColor: 'purple', label: 'Synthesizing', title: 'Chairman synthesizing verdict', onClick }
  }
  if (councilPhase === 'framing') {
    return { icon: Landmark, state: 'active', activeColor: 'purple', label: 'Framing…', title: 'Council framing input', onClick }
  }
  return { icon: Landmark, state: 'hidden', activeColor: 'purple', title: 'Council', onClick }
}

export interface IndexingStateInfo {
  status: string
  processedChunks: number
  totalChunks: number
  estimatedRemaining?: string
  error?: string | null
}

export function computeIndexingIndicator(
  indexingState: IndexingStateInfo | null,
  onClick: () => void
): StatusIndicatorProps {
  if (indexingState && INDEXING_ACTIVE_STATUSES.has(indexingState.status)) {
    const pct = indexingState.totalChunks > 0
      ? ` ${Math.round((indexingState.processedChunks / indexingState.totalChunks) * 100)}%`
      : ''
    return {
      icon: Database, state: 'active', activeColor: 'cyan',
      label: `Indexing…${pct}`,
      title: `Indexing in progress${indexingState.estimatedRemaining ? ` — ${indexingState.estimatedRemaining} remaining` : ''}`,
      onClick
    }
  }
  if (indexingState?.status === 'paused') {
    return { icon: Database, state: 'attention', activeColor: 'cyan', label: 'Paused', title: 'Indexing paused — click to view', onClick }
  }
  if (indexingState?.status === 'error') {
    return { icon: Database, state: 'error', activeColor: 'cyan', label: 'Error', title: `Indexing error: ${indexingState.error ?? 'unknown'}`, onClick }
  }
  return { icon: Database, state: 'hidden', title: 'Indexing', onClick }
}
