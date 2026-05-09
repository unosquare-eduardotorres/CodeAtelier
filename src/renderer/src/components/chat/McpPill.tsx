import { Smartphone } from 'lucide-react'
import type { ExternalMcpDefinition } from '../../../../shared/constants'

interface McpPillProps {
  integration: ExternalMcpDefinition
  active: boolean
  onToggle: () => void
  disabled?: boolean
}

/**
 * Per-chat MCP toggle pill — sits alongside the Plan/Build mode pill.
 * When ON, the integration's tools are mounted on the next send().
 * When OFF, they're excluded — zero token cost.
 */
export default function McpPill({
  integration,
  active,
  onToggle,
  disabled
}: McpPillProps): React.JSX.Element {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`pointer-events-auto inline-flex items-center gap-2 px-4 py-1.5
        rounded-full text-sm font-semibold border-2 shadow-lg backdrop-blur-sm
        transition-all cursor-pointer hover:scale-105
        disabled:opacity-50 disabled:cursor-not-allowed ${
          active
            ? 'bg-accent/15 text-accent border-accent/40'
            : 'bg-surface-overlay/80 text-text-muted border-border-subtle hover:text-text-secondary'
        }`}
      title={
        active
          ? `${integration.displayName} is ON — click to disable for next message`
          : `Enable ${integration.displayName} for this chat`
      }
    >
      <Smartphone size={14} />
      <span>{integration.displayName}</span>

      {/* Inline mini toggle */}
      <span
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
          active ? 'bg-accent' : 'bg-surface-base border border-border-default'
        }`}
      >
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full bg-white transition-transform ${
            active ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  )
}
