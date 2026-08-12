import { Puzzle, HelpCircle, ArrowRight } from 'lucide-react'
import { Popover } from '@renderer/components/common/ui'

const FLOW = [
  'Enable here',
  'Pill appears in chat bar',
  'Toggle ON per conversation',
  'Agent uses tools'
]

/**
 * Page header for Integrations.
 *
 * This used to be a permanent ~320px banner explaining MCP, and each card then
 * repeated its own "How it works" underneath — the same four steps, three times
 * on one page. The explanation is onboarding material: read once, never again.
 * It now lives behind a help affordance, the same treatment the memories
 * toolbar gives its tier explainer.
 */
export default function McpExplainerBanner(): React.JSX.Element {
  return (
    <div data-testid="mcp-explainer-banner" className="flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-lg bg-accent/15 flex items-center justify-center shrink-0">
        <Puzzle size={16} className="text-accent" />
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-text-primary">External MCP Integrations</h3>
        <p className="text-[11px] text-text-muted">
          Extend your AI agent with external tool servers
        </p>
      </div>

      <Popover
        align="end"
        className="w-80 p-3"
        trigger={(props) => (
          <button
            type="button"
            aria-label="What is MCP?"
            {...props}
            className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        )}
      >
        <ExplainerContent />
      </Popover>
    </div>
  )
}

function ExplainerContent(): React.JSX.Element {
  return (
    <div data-testid="mcp-explainer-popover" className="space-y-3 text-xs text-text-secondary">
      <div>
        <p className="font-medium text-text-primary mb-1.5">What is MCP?</p>
        <p className="leading-relaxed">
          <strong className="text-text-primary">Model Context Protocol (MCP)</strong> lets your AI
          agent connect to external tools beyond reading and writing code. When an integration is
          enabled, your agent gains new capabilities — like driving a real mobile device, deploying
          to cloud, or querying databases.
        </p>
      </div>

      <div>
        <p className="font-medium text-text-primary mb-1.5">How it works</p>
        <ol className="space-y-1">
          {FLOW.map((label, i) => (
            <li key={label} className="flex items-center gap-1.5 text-[11px]">
              <span className="font-mono tabular-nums text-accent">{i + 1}.</span>
              <span>{label}</span>
              {i < FLOW.length - 1 && (
                <ArrowRight size={10} className="text-text-muted ml-auto shrink-0" />
              )}
            </li>
          ))}
        </ol>
      </div>

      <p className="text-[11px] text-text-muted">
        Tools are only loaded when the pill is active — no token cost when it&apos;s OFF.
      </p>
    </div>
  )
}
