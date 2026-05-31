import {
  Bot,
  Zap,
  Braces,
  SearchCode,
  ZoomIn,
  ZoomOut,
  ArrowUp,
  ArrowDown,
  Flame,
  ShieldCheck,
  GitBranch,
  Database,
  Target,
  Landmark
} from 'lucide-react'
import type { ContextUsage } from '../../../../shared/types'

const isMac = navigator.platform.toUpperCase().includes('MAC')

function AgentStatusDot({ status }: { status: string }): React.JSX.Element {
  const dotBase = 'w-2 h-2 rounded-full inline-block'
  switch (status) {
    case 'running':
      return <span className={`${dotBase} bg-success`} title="Agent ready" />
    case 'starting':
      return <span className={`${dotBase} bg-warning animate-pulse`} title="Agent starting" />
    case 'error':
      return <span className={`${dotBase} bg-danger`} title="Agent error" />
    default:
      return <span className={`${dotBase} bg-text-muted`} title="Agent stopped" />
  }
}

// ── StatusIndicator — shared 3-state pattern for status bar indicators ──

type IndicatorState = 'active' | 'attention' | 'idle' | 'error' | 'hidden'

interface StatusIndicatorProps {
  icon: React.ElementType
  label?: string
  state: IndicatorState
  activeColor?: 'danger' | 'cyan' | 'purple'
  title: string
  onClick: () => void
  badge?: string | number | null
}

// Only the 'active' state differs by color variant — the rest are shared.
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

function StatusIndicator({
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

// ── Indicator config helpers — compute state/label/title once per indicator ──

const INDEXING_ACTIVE_STATUSES = new Set(['indexing-chunks', 'embedding', 'preprocessing', 'scanning'])

function computeAuditIndicator(
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

function computeGrillIndicator(
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

function computeGoalIndicator(
  mpaStatus: StatusBarProps['mpaStatus'],
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

function computeCouncilIndicator(
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

function computeIndexingIndicator(
  indexingState: StatusBarProps['indexingState'],
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

interface StatusBarProps {
  activeWorkspace: { id: string; name: string } | null
  agentStatus: string
  appVersion: string
  currentBranch: string | null
  isGitRepo: boolean
  activeMcpTools: string[] | undefined
  contextUsage: ContextUsage | undefined
  contextWindowTokens: number
  sessionOutputTokens: number
  zoomFactor: number
  // Audit
  isAuditActive: boolean
  isAuditPaused: boolean
  lastAuditScore: number | null
  // Grill
  grillStatus: { status: string; ideaId: string } | null
  // MPA Goals
  mpaStatus?: { status: string; currentPhase: string | null; phaseIndex: number; totalPhases: number } | null
  // Council
  councilPhase?: string | null
  // Indexing
  indexingState: {
    status: string
    processedChunks: number
    totalChunks: number
    estimatedRemaining?: string
    error?: string | null
  } | null
  // Callbacks
  onNavigateToSettings: (tab: string) => void
  onOpenContextModal: () => void
  onOpenTokenModal: () => void
  onNavigateToGrill: (ideaId: string) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  sidebarView: 'chat' | 'settings'
}

export default function StatusBar({
  activeWorkspace,
  agentStatus,
  appVersion,
  currentBranch,
  isGitRepo,
  activeMcpTools,
  contextUsage,
  contextWindowTokens,
  sessionOutputTokens,
  zoomFactor,
  isAuditActive,
  isAuditPaused,
  lastAuditScore,
  grillStatus,
  mpaStatus,
  councilPhase,
  indexingState,
  onNavigateToSettings,
  onOpenContextModal,
  onOpenTokenModal,
  onNavigateToGrill,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  sidebarView
}: StatusBarProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-surface-base border-t border-border-subtle text-[13px]">
      <div className="flex items-center gap-4">
        {activeWorkspace ? (
          <span className="flex items-center gap-1.5 text-text-secondary">
            <AgentStatusDot status={agentStatus} />
            <Bot size={12} className="text-primary-text" />
            {activeWorkspace.name}
          </span>
        ) : (
          <span className="text-text-muted">No workspace selected</span>
        )}

        {appVersion && (
          <span className="text-[11px] text-text-muted font-mono border-l border-border-subtle pl-3 ml-1">
            v{appVersion}
          </span>
        )}

        {/* Branch indicator */}
        {activeWorkspace && (
          <button
            type="button"
            onClick={() => onNavigateToSettings('repository')}
            className={`flex items-center gap-1.5 text-[11px] font-mono border-l border-border-subtle pl-3 ml-1 rounded px-1.5 py-0.5 transition-colors ${
              isGitRepo
                ? 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
                : 'text-danger bg-danger/10 hover:bg-danger/20'
            }`}
            title={
              isGitRepo ? `Branch: ${currentBranch}` : 'No git repository — click to configure'
            }
          >
            <GitBranch size={11} />
            {isGitRepo ? (
              <span className="truncate max-w-[160px]">{currentBranch}</span>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-danger animate-pulse" />
                <span>No repo</span>
              </>
            )}
          </button>
        )}
      </div>

      <div className="flex items-center gap-4">
        {/* MCP tool indicators */}
        {activeMcpTools && activeMcpTools.length > 0 && (
          <div className="flex items-center gap-1.5">
            {activeMcpTools.includes('code-graph') && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400"
                title="Code Graph active"
              >
                <Braces size={10} /> CG
              </span>
            )}
            {activeMcpTools.includes('semantic-search') && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-medium text-sky-400"
                title="Semantic Search active"
              >
                <SearchCode size={10} /> Sem
              </span>
            )}
          </div>
        )}

        {/* Context + Token counts */}
        <span className="flex items-center gap-1.5 text-text-muted">
          {sidebarView === 'chat' && contextUsage && contextUsage.percentage > 0 && (
            <button
              type="button"
              onClick={onOpenContextModal}
              className={`hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-border-default rounded ${
                contextUsage.level === 'critical' || contextUsage.level === 'red'
                  ? 'text-danger'
                  : contextUsage.level === 'yellow'
                    ? 'text-warning'
                    : 'text-text-secondary'
              }`}
              title="Click for context breakdown and compact options"
            >
              {contextUsage.percentage}% context
            </button>
          )}

          <button
            type="button"
            onClick={onOpenTokenModal}
            className="flex items-center gap-1.5 hover:text-text-secondary focus:outline-none focus-visible:ring-1 focus-visible:ring-border-default rounded"
            title="Click for token breakdown (context window / output / cache)"
          >
            <Zap size={11} />
            <span className="flex items-center gap-0.5 tabular-nums">
              <ArrowUp size={10} />
              {contextWindowTokens >= 1000
                ? `${(contextWindowTokens / 1000).toFixed(1)}k`
                : String(contextWindowTokens)}
            </span>
            <span className="flex items-center gap-0.5 tabular-nums">
              <ArrowDown size={10} />
              {sessionOutputTokens >= 1000
                ? `${(sessionOutputTokens / 1000).toFixed(1)}k`
                : String(sessionOutputTokens)}
            </span>
          </button>
        </span>

        {/* Audit status */}
        <StatusIndicator {...computeAuditIndicator(isAuditActive, isAuditPaused, lastAuditScore, () => onNavigateToSettings('health'))} />

        {/* Grill status */}
        <StatusIndicator {...computeGrillIndicator(grillStatus, onNavigateToGrill, onNavigateToSettings)} />

        {/* Goal status */}
        <StatusIndicator {...computeGoalIndicator(mpaStatus, () => onNavigateToSettings('goals'))} />

        {/* Council status */}
        <StatusIndicator {...computeCouncilIndicator(councilPhase ?? null, () => onNavigateToSettings('council'))} />

        {/* Indexing status */}
        <StatusIndicator {...computeIndexingIndicator(indexingState, () => onNavigateToSettings('code-intelligence'))} />

        {/* Zoom controls */}
        <div className="flex items-center gap-0.5 border-l border-border-subtle pl-3 ml-1">
          <button
            type="button"
            onClick={onZoomOut}
            className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
            aria-label="Zoom out"
            title={`Zoom Out (${isMac ? '⌘' : 'Ctrl+'}−)`}
          >
            <ZoomOut size={12} />
          </button>
          <button
            type="button"
            onClick={onZoomReset}
            className="px-1 py-0.5 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors min-w-[36px] text-center"
            title={`Reset Zoom (${isMac ? '⌘' : 'Ctrl+'}0)`}
          >
            <span className="text-[11px] font-mono">{Math.round(zoomFactor * 100)}%</span>
          </button>
          <button
            type="button"
            onClick={onZoomIn}
            className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-text-secondary transition-colors"
            aria-label="Zoom in"
            title={`Zoom In (${isMac ? '⌘' : 'Ctrl+'}+)`}
          >
            <ZoomIn size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
