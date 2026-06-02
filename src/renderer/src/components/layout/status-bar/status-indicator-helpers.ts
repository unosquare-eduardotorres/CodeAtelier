/**
 * status-indicator-helpers — compute* functions that derive StatusIndicator props
 * for each StatusBar segment. Extracted from StatusIndicator.tsx so that file only
 * exports its component (Fast Refresh requirement).
 */

import { ShieldCheck, Flame, Target, Landmark, Database } from 'lucide-react'
import type { StatusIndicatorProps } from './StatusIndicator'

// ── Compute helpers ─────────────────────────────────────────────────────────

const INDEXING_ACTIVE_STATUSES = new Set([
  'indexing-chunks',
  'embedding',
  'preprocessing',
  'scanning'
])

export function computeAuditIndicator(
  isActive: boolean,
  isPaused: boolean,
  lastScore: number | null,
  onClick: () => void
): StatusIndicatorProps {
  if (isActive && !isPaused) {
    return {
      icon: ShieldCheck,
      state: 'active',
      activeColor: 'danger',
      label: 'Auditing…',
      title: 'Audit in progress',
      onClick
    }
  }
  if (isPaused) {
    return {
      icon: ShieldCheck,
      state: 'attention',
      activeColor: 'danger',
      label: 'Paused',
      title: 'Audit paused — click to resume',
      onClick
    }
  }
  return {
    icon: ShieldCheck,
    state: 'idle',
    activeColor: 'danger',
    title: lastScore !== null ? `Last audit score: ${lastScore}` : 'Run a workspace audit',
    badge: lastScore,
    onClick
  }
}

export function computeGrillIndicator(
  grillStatus: { status: string; ideaId: string } | null,
  onNavigateToGrill: (ideaId: string) => void,
  onNavigateToSettings: (tab: string) => void
): StatusIndicatorProps {
  if (grillStatus?.status === 'evaluating') {
    return {
      icon: Flame,
      state: 'active',
      activeColor: 'danger',
      label: 'Grilling…',
      title: 'Grill in progress',
      onClick: () => onNavigateToGrill(grillStatus.ideaId)
    }
  }
  if (grillStatus?.status === 'awaiting_answers') {
    return {
      icon: Flame,
      state: 'attention',
      activeColor: 'danger',
      label: 'Needs Attention',
      title: 'Grill needs your answers',
      onClick: () => onNavigateToGrill(grillStatus.ideaId)
    }
  }
  return {
    icon: Flame,
    state: 'idle',
    activeColor: 'danger',
    title: 'Grill an idea',
    onClick: () => onNavigateToSettings('ideas')
  }
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
      icon: Target,
      state: 'active',
      activeColor: 'cyan',
      label: `Goal: ${mpaStatus.currentPhase ?? '…'} (${mpaStatus.phaseIndex}/${mpaStatus.totalPhases})`,
      title: `Goal in progress — ${mpaStatus.currentPhase ?? 'starting'}`,
      onClick
    }
  }
  if (mpaStatus?.status === 'paused') {
    return {
      icon: Target,
      state: 'attention',
      activeColor: 'cyan',
      label: 'Review Plan',
      title: 'Goal needs your approval',
      onClick
    }
  }
  return { icon: Target, state: 'idle', activeColor: 'cyan', title: 'Goals', onClick }
}

export function computeCouncilIndicator(
  councilPhase: string | null,
  onClick: () => void
): StatusIndicatorProps {
  if (councilPhase === 'deliberating') {
    return {
      icon: Landmark,
      state: 'active',
      activeColor: 'purple',
      label: 'Council…',
      title: 'Council deliberating',
      onClick
    }
  }
  if (councilPhase === 'peer-review') {
    return {
      icon: Landmark,
      state: 'active',
      activeColor: 'purple',
      label: 'Peer Review',
      title: 'Council peer review',
      onClick
    }
  }
  if (councilPhase === 'synthesizing') {
    return {
      icon: Landmark,
      state: 'attention',
      activeColor: 'purple',
      label: 'Synthesizing',
      title: 'Chairman synthesizing verdict',
      onClick
    }
  }
  if (councilPhase === 'framing') {
    return {
      icon: Landmark,
      state: 'active',
      activeColor: 'purple',
      label: 'Framing…',
      title: 'Council framing input',
      onClick
    }
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
    const pct =
      indexingState.totalChunks > 0
        ? ` ${Math.round((indexingState.processedChunks / indexingState.totalChunks) * 100)}%`
        : ''
    return {
      icon: Database,
      state: 'active',
      activeColor: 'cyan',
      label: `Indexing…${pct}`,
      title: `Indexing in progress${indexingState.estimatedRemaining ? ` — ${indexingState.estimatedRemaining} remaining` : ''}`,
      onClick
    }
  }
  if (indexingState?.status === 'paused') {
    return {
      icon: Database,
      state: 'attention',
      activeColor: 'cyan',
      label: 'Paused',
      title: 'Indexing paused — click to view',
      onClick
    }
  }
  if (indexingState?.status === 'error') {
    return {
      icon: Database,
      state: 'error',
      activeColor: 'cyan',
      label: 'Error',
      title: `Indexing error: ${indexingState.error ?? 'unknown'}`,
      onClick
    }
  }
  return { icon: Database, state: 'hidden', title: 'Indexing', onClick }
}
