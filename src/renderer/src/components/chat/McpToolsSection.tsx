import { ChevronDown, ChevronRight, Puzzle } from 'lucide-react'
import type { ExternalMcpDefinition, LocalMcpDefinition } from '../../../../shared/constants'
import { McpRow } from './NewChatPage'

type McpSubTab = 'external' | 'system'

interface McpToolsSectionProps {
  showMcpTools: boolean
  setShowMcpTools: (show: boolean) => void
  mcpSubTab: McpSubTab
  setMcpSubTab: (tab: McpSubTab) => void
  availableIntegrations: ExternalMcpDefinition[]
  availableLocalMcps: LocalMcpDefinition[]
  mcpOverrides: Record<string, boolean>
  setMcpOverrides: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  activeLocalMcps: LocalMcpDefinition[]
  activeExternalMcps: ExternalMcpDefinition[]
}

/**
 * Collapsible MCP tools panel with system/external tabs.
 * Extracted from NewChatPage.
 */
export default function McpToolsSection({
  showMcpTools,
  setShowMcpTools,
  mcpSubTab,
  setMcpSubTab,
  availableIntegrations,
  availableLocalMcps,
  mcpOverrides,
  setMcpOverrides,
  activeLocalMcps,
  activeExternalMcps
}: McpToolsSectionProps): React.JSX.Element {
  return (
    <div className="w-full mb-5">
      <button
        onClick={() => setShowMcpTools(!showMcpTools)}
        className="flex items-center gap-2.5 text-sm font-medium text-text-primary mb-2"
      >
        <Puzzle size={20} className="text-accent" />
        <span className="text-base font-semibold">MCP Tools</span>
        <span className="text-xs text-text-muted font-normal">
          {availableIntegrations.length > 0
            ? `(${activeLocalMcps.length + activeExternalMcps.length} active)`
            : `(${activeLocalMcps.length} system)`}
        </span>
        {showMcpTools ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>

      {showMcpTools && (
        <div className="bg-surface-overlay rounded-lg border border-border-subtle overflow-hidden">
          {/* Sub-tab bar — only shown when externals exist */}
          {availableIntegrations.length > 0 && (
            <div className="flex items-center border-b border-border-subtle bg-surface-raised/50 px-3 pt-2">
              <button
                onClick={() => setMcpSubTab('external')}
                className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors ${
                  mcpSubTab === 'external'
                    ? 'bg-surface-overlay text-text-primary border border-border-default border-b-transparent -mb-px'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                External ({availableIntegrations.length})
              </button>
              <button
                onClick={() => setMcpSubTab('system')}
                className={`px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors ${
                  mcpSubTab === 'system'
                    ? 'bg-surface-overlay text-text-primary border border-border-default border-b-transparent -mb-px'
                    : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                System ({availableLocalMcps.length})
              </button>
            </div>
          )}

          {/* Tab content */}
          <div className="p-3 space-y-2">
            {availableIntegrations.length === 0 || mcpSubTab === 'system' ? (
              availableLocalMcps.length > 0 ? (
                <div className="space-y-1">
                  {availableIntegrations.length === 0 && (
                    <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wide">
                      System Tools
                    </span>
                  )}
                  {availableLocalMcps.map((lm) => (
                    <McpRow
                      key={lm.id}
                      id={lm.id}
                      displayName={lm.displayName}
                      icon={lm.icon}
                      toolCount={lm.toolCount}
                      tokenImpact={lm.tokenImpact}
                      description={lm.description}
                      active={mcpOverrides[lm.id] !== false}
                      onToggle={() =>
                        setMcpOverrides((prev) => ({
                          ...prev,
                          [lm.id]: prev[lm.id] === false ? true : false
                        }))
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-text-muted text-center py-4">
                  No system tools available for this workspace.
                </p>
              )
            ) : (
              <div className="space-y-1">
                {availableIntegrations.map((i) => (
                  <McpRow
                    key={i.id}
                    id={i.id}
                    displayName={i.displayName}
                    icon={i.icon}
                    toolCount={i.toolCount}
                    tokenImpact={i.tokenImpact}
                    description={i.description}
                    active={!!mcpOverrides[i.id]}
                    onToggle={() =>
                      setMcpOverrides((prev) => ({ ...prev, [i.id]: !prev[i.id] }))
                    }
                  />
                ))}
              </div>
            )}
            <p className="text-[11px] text-text-muted pt-1">
              Disabled tools are not mounted — zero token cost.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
