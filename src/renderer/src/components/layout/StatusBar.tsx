import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Bot,
  Zap,
  Braces,
  SearchCode,
  ZoomIn,
  ZoomOut,
  ArrowUp,
  ArrowDown,
  GitBranch
} from 'lucide-react'
import type { ContextUsage } from '../../../../shared/types'
import { StatusIndicator } from './status-bar/StatusIndicator'
import {
  computeAuditIndicator,
  computeGrillIndicator,
  computeBlueprintIndicator,
  computeIndexingIndicator,
  computeBrainIndicator
} from './status-bar/status-indicator-helpers'
import type { IndexingStateInfo } from './status-bar/status-indicator-helpers'
import type { BlueprintStatusBarInfo } from './hooks/useBlueprintStatusBar'
import type { BootstrapStatusBarInfo } from './hooks/useBootstrapStatusBar'
import { BlueprintDropdown } from './status-bar/BlueprintDropdown'
import { BrainDropdown } from './status-bar/BrainDropdown'

import { isMacPlatform as isMac } from '@renderer/utils/platform'

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

// ── BlueprintIndicatorWithDropdown ───────────────────────────────────────────

function BlueprintIndicatorWithDropdown({
  blueprintStatus,
  onNavigateToBlueprint,
  onSwitchToWorkspaceBlueprint
}: {
  blueprintStatus: BlueprintStatusBarInfo
  onNavigateToBlueprint: () => void
  onSwitchToWorkspaceBlueprint: (workspaceId: string) => void
}): React.JSX.Element {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  // Close dropdown on click outside
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
      setDropdownOpen(false)
    }
  }, [])

  useEffect(() => {
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
    return undefined
  }, [dropdownOpen, handleClickOutside])

  const indicatorProps = computeBlueprintIndicator(
    blueprintStatus,
    onNavigateToBlueprint,
    () => setDropdownOpen((v) => !v)
  )

  return (
    <div ref={wrapperRef} className="relative">
      <StatusIndicator {...indicatorProps} />
      {dropdownOpen && blueprintStatus.backgroundEntries.length > 0 && (
        <BlueprintDropdown
          entries={blueprintStatus.backgroundEntries}
          onSelect={onSwitchToWorkspaceBlueprint}
          onClose={() => setDropdownOpen(false)}
        />
      )}
    </div>
  )
}

// ── BrainIndicatorWithDropdown ─────────────────────────────────────────

function BrainIndicatorWithDropdown({
  bootstrapStatus,
  onNavigateToMemory,
  onSwitchToWorkspaceMemory
}: {
  bootstrapStatus: BootstrapStatusBarInfo
  onNavigateToMemory: () => void
  onSwitchToWorkspaceMemory: (workspaceId: string) => void
}): React.JSX.Element {
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
      setDropdownOpen(false)
    }
  }, [])

  useEffect(() => {
    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
    return undefined
  }, [dropdownOpen, handleClickOutside])

  const indicatorProps = computeBrainIndicator(bootstrapStatus, onNavigateToMemory, () =>
    setDropdownOpen((v) => !v)
  )

  return (
    <div ref={wrapperRef} className="relative">
      <StatusIndicator {...indicatorProps} />
      {dropdownOpen && bootstrapStatus.backgroundEntries.length > 0 && (
        <BrainDropdown
          entries={bootstrapStatus.backgroundEntries}
          onSelect={onSwitchToWorkspaceMemory}
          onClose={() => setDropdownOpen(false)}
        />
      )}
    </div>
  )
}

// ── Props ────────────────────────────────────────────────────────────────────

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
  // Blueprint
  blueprintStatus: BlueprintStatusBarInfo
  // Feed Brain ingestion
  bootstrapStatus: BootstrapStatusBarInfo
  // Indexing
  indexingState: IndexingStateInfo | null
  // Callbacks
  onNavigateToSettings: (tab: string) => void
  onOpenContextModal: () => void
  onOpenTokenModal: () => void
  onNavigateToGrill: (ideaId: string) => void
  onNavigateToBlueprint: () => void
  onSwitchToWorkspaceBlueprint: (workspaceId: string) => void
  onNavigateToMemory: () => void
  onSwitchToWorkspaceMemory: (workspaceId: string) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  sidebarView: 'chat' | 'settings'
}

// ── Component ────────────────────────────────────────────────────────────────

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
  blueprintStatus,
  bootstrapStatus,
  indexingState,
  onNavigateToSettings,
  onOpenContextModal,
  onOpenTokenModal,
  onNavigateToGrill,
  onNavigateToBlueprint,
  onSwitchToWorkspaceBlueprint,
  onNavigateToMemory,
  onSwitchToWorkspaceMemory,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  sidebarView
}: StatusBarProps): React.JSX.Element {
  return (
    <div
      data-testid="status-bar"
      className="flex items-center justify-between px-4 py-2 bg-surface-base border-t border-border-subtle text-[13px]"
    >
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

        {/* Workflow indicators — computed via shared StatusIndicator pattern */}
        <StatusIndicator
          {...computeAuditIndicator(isAuditActive, isAuditPaused, lastAuditScore, () =>
            onNavigateToSettings('health')
          )}
        />
        <StatusIndicator
          {...computeGrillIndicator(grillStatus, onNavigateToGrill, onNavigateToSettings)}
        />
        <BlueprintIndicatorWithDropdown
          blueprintStatus={blueprintStatus}
          onNavigateToBlueprint={onNavigateToBlueprint}
          onSwitchToWorkspaceBlueprint={onSwitchToWorkspaceBlueprint}
        />
        <BrainIndicatorWithDropdown
          bootstrapStatus={bootstrapStatus}
          onNavigateToMemory={onNavigateToMemory}
          onSwitchToWorkspaceMemory={onSwitchToWorkspaceMemory}
        />
        <StatusIndicator
          {...computeIndexingIndicator(indexingState, () =>
            onNavigateToSettings('code-intelligence')
          )}
        />

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
