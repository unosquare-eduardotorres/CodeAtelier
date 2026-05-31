/**
 * WorkspaceStatusIndicator — shows the current session status for a workspace
 * in the sidebar. Renders a colored dot + short label below the workspace name.
 *
 * Used in both expanded WorkspaceItem and collapsed sidebar avatar buttons.
 */

import { useBackgroundSessionStore } from '@renderer/store'
import type { AgentStatus } from '../../../../shared/types'

interface WorkspaceStatusIndicatorProps {
  workspaceId: string
  /** When true, only show the dot (no text) — for collapsed sidebar */
  compact?: boolean
}

interface StatusDisplayConfig {
  dotClass: string
  animate: boolean
  label: (status: AgentStatus) => string
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m`
}

const STATUS_DISPLAY: Record<string, StatusDisplayConfig> = {
  thinking: {
    dotClass: 'bg-green-500',
    animate: true,
    label: (s) => `Thinking... (${formatElapsed(s.elapsedMs)})`
  },
  writing: {
    dotClass: 'bg-green-500',
    animate: true,
    label: (s) => `Writing... (${formatElapsed(s.elapsedMs)})`
  },
  reviewing: {
    dotClass: 'bg-yellow-500',
    animate: true,
    label: (s) => `Using tools... (${formatElapsed(s.elapsedMs)})`
  },
  completed: {
    dotClass: 'bg-green-500',
    animate: false,
    label: () => '✓ Completed'
  },
  failed: {
    dotClass: 'bg-red-500',
    animate: false,
    label: () => '✗ Failed'
  }
}

export default function WorkspaceStatusIndicator({
  workspaceId,
  compact = false
}: WorkspaceStatusIndicatorProps): React.JSX.Element | null {
  const status = useBackgroundSessionStore((s) => s.statuses[workspaceId])

  if (!status || status.status === 'idle') return null

  const config = STATUS_DISPLAY[status.status]
  if (!config) return null

  if (compact) {
    return (
      <span
        className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-surface-base ${config.dotClass} ${config.animate ? 'animate-pulse' : ''}`}
        title={config.label(status)}
      />
    )
  }

  return (
    <div className="flex items-center gap-1.5 mt-0.5">
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${config.dotClass} ${config.animate ? 'animate-pulse' : ''}`}
      />
      <span className="text-xs text-text-muted truncate">{config.label(status)}</span>
    </div>
  )
}
