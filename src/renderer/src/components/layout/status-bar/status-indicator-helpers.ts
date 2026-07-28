/**
 * status-indicator-helpers — compute* functions that derive StatusIndicator props
 * for each StatusBar segment. Extracted from StatusIndicator.tsx so that file only
 * exports its component (Fast Refresh requirement).
 */

import { ShieldCheck, Flame, LayoutGrid, Database } from 'lucide-react'
import type { StatusIndicatorProps } from './StatusIndicator'
import type { BlueprintStatusBarInfo } from '../hooks/useBlueprintStatusBar'

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

// ── Blueprint indicator ─────────────────────────────────────────────────────

const PHASE_LABELS: Record<string, string> = {
  specify: 'Specifying…',
  clarify: 'Clarifying…',
  plan: 'Planning…',
  tasks: 'Tasking…',
  review: 'Reviewing…',
  build: 'Building…',
  verify: 'Verifying…'
}

export function computeBlueprintIndicator(
  info: BlueprintStatusBarInfo,
  onClick: () => void,
  onBadgeClick: () => void
): StatusIndicatorProps {
  const { active, backgroundCount } = info

  // Active workspace has a running blueprint
  if (active) {
    const label = PHASE_LABELS[active.currentPhase ?? ''] ?? 'Blueprint…'
    // 'awaiting-approval' and 'awaiting-clarify-*' states need attention
    const needsAttention = active.machineState.startsWith('awaiting-')
    return {
      icon: LayoutGrid,
      state: needsAttention ? 'attention' : 'active',
      activeColor: 'cyan',
      label: needsAttention ? 'Needs Attention' : label,
      title: needsAttention
        ? 'Blueprint needs your input — click to view'
        : `Blueprint ${active.currentPhase ?? 'running'} — click to view`,
      onClick,
      badge: backgroundCount > 0 ? backgroundCount : null,
      onBadgeClick: backgroundCount > 0 ? onBadgeClick : undefined,
      badgeClickable: backgroundCount > 0
    }
  }

  // No active blueprint, but background workspaces have running ones
  if (backgroundCount > 0) {
    return {
      icon: LayoutGrid,
      state: 'active',
      activeColor: 'cyan',
      label: `${backgroundCount} running`,
      title: `${backgroundCount} blueprint(s) running in other workspace(s)`,
      onClick: onBadgeClick, // main click opens dropdown
      badge: backgroundCount,
      badgeClickable: false
    }
  }

  // Idle — no blueprints running anywhere
  return {
    icon: LayoutGrid,
    state: 'idle',
    activeColor: 'cyan',
    title: 'Blueprints',
    onClick
  }
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
