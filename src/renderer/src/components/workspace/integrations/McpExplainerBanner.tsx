import { Puzzle, Info, ArrowRight } from 'lucide-react'

export default function McpExplainerBanner(): React.JSX.Element {
  return (
    <div className="bg-surface-overlay rounded-lg border border-border-subtle p-5 space-y-4">
      {/* Title */}
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-accent/15 flex items-center justify-center">
          <Puzzle size={16} className="text-accent" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-text-primary">External MCP Integrations</h3>
          <p className="text-[11px] text-text-muted">
            Extend your AI agent with external tool servers
          </p>
        </div>
      </div>

      {/* What is MCP? */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Info size={12} className="text-accent" />
          <h4 className="text-xs font-semibold text-text-primary">What is MCP?</h4>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed">
          <strong className="text-text-primary">Model Context Protocol (MCP)</strong> lets your AI
          agent connect to external tools beyond reading and writing code. When an integration is
          enabled, your agent gains new capabilities — like driving a real mobile device, deploying
          to cloud, or querying databases.
        </p>
      </div>

      {/* How it works — compact stepper */}
      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-text-primary">How it works</h4>
        <div className="flex items-center gap-1 flex-wrap">
          {[
            { num: '①', label: 'Enable here' },
            { num: '②', label: 'Pill appears in chat bar' },
            { num: '③', label: 'Toggle ON per conversation' },
            { num: '④', label: 'Agent uses tools' }
          ].map((step, i, arr) => (
            <div key={step.num} className="flex items-center gap-1">
              <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-surface-base border border-border-subtle text-text-secondary">
                <span className="text-accent font-semibold">{step.num}</span> {step.label}
              </span>
              {i < arr.length - 1 && (
                <ArrowRight size={10} className="text-text-muted mx-0.5 flex-shrink-0" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Token safety callout */}
      <p className="text-[11px] text-text-muted italic">
        Tools are only loaded when the pill is active — no token cost when it&apos;s OFF.
      </p>
    </div>
  )
}
