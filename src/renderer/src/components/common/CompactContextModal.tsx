import { useEffect, useMemo, useRef, useState } from 'react'
import { Minimize2, X, Sparkles, Zap, ChevronDown, ChevronRight } from 'lucide-react'
import type { ContextUsageBreakdown } from '../../../../shared/types'

interface ContextCategory {
  name: string
  tokens: number
  color: string
  isDeferred?: boolean
}

interface CompactContextModalProps {
  isOpen: boolean
  inputTokens: number
  contextWindowSize?: number
  level: string
  /** Legacy categories array — used as a fallback when breakdown is missing. */
  categories?: ContextCategory[]
  /** Full Claude Code-style breakdown — preferred when available. */
  breakdown?: ContextUsageBreakdown
  /** When true, SDK compaction is unavailable — show "new conversation" UX instead */
  isLocalProvider?: boolean
  onExtractNuance: () => void
  onQuickCompact: () => void
  onCancel: () => void
  /** Callback to start a new conversation (shown for local LLMs) */
  onNewConversation?: () => void
}

const DEFAULT_CONTEXT_WINDOW_SIZE = 1_000_000
/** Quality window is 50% of context window, capped at 500K */
const QUALITY_RATIO = 0.5
const QUALITY_WINDOW_CAP = 500_000

function getBarColor(level: string): string {
  switch (level) {
    case 'critical':
      return 'bg-danger'
    case 'suggest':
      return 'bg-warning'
    case 'warning':
      return 'bg-info'
    default:
      return 'bg-success'
  }
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

export default function CompactContextModal({
  isOpen,
  inputTokens,
  contextWindowSize,
  level,
  categories,
  breakdown,
  isLocalProvider,
  onExtractNuance,
  onQuickCompact,
  onCancel,
  onNewConversation
}: CompactContextModalProps): React.JSX.Element | null {
  const nuanceRef = useRef<HTMLButtonElement>(null)
  const [showMcpDetails, setShowMcpDetails] = useState(false)

  useEffect(() => {
    if (isOpen) {
      nuanceRef.current?.focus()
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onCancel()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onCancel])

  // Top 10 MCP tools by token cost (for the expandable detail view).
  const topMcpTools = useMemo(() => {
    const tools = breakdown?.mcpTools ?? []
    return [...tools].sort((a, b) => b.tokens - a.tokens).slice(0, 10)
  }, [breakdown?.mcpTools])

  // Resolve which categories list to render.
  // Prefer breakdown.categories (Claude Code-style 8-category panel).
  // Fall back to legacy `categories` prop, then null.
  const renderCategories = useMemo(() => {
    if (breakdown?.categories && breakdown.categories.length > 0) return breakdown.categories
    if (categories && categories.length > 0) return categories
    return null
  }, [breakdown, categories])

  if (!isOpen) return null

  const effectiveWindowSize = contextWindowSize || DEFAULT_CONTEXT_WINDOW_SIZE
  // Adjust quality window when auto-compact is active — server-side clearing
  // buys extra quality headroom since stale content is being purged.
  const qualityBoost = breakdown?.isAutoCompactEnabled ? 1.2 : 1.0
  const qualityWindow = Math.min(
    Math.round(effectiveWindowSize * QUALITY_RATIO * qualityBoost),
    QUALITY_WINDOW_CAP
  )
  const tokensK = (inputTokens / 1000).toFixed(1)
  const windowK = (effectiveWindowSize / 1000).toFixed(1)
  const percentage = Math.min(Math.round((inputTokens / effectiveWindowSize) * 100), 100)
  // Quality is based on a scaled quality window (50% of context window, capped at 500K)
  const qualityPercentage = Math.min(Math.round((inputTokens / qualityWindow) * 100), 100)
  const qualityLabel =
    qualityPercentage <= 40
      ? 'Excellent'
      : qualityPercentage <= 60
        ? 'Good'
        : qualityPercentage <= 80
          ? 'Moderate'
          : 'Low'
  const barColor = getBarColor(level)

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compact-dialog-title"
      aria-describedby="compact-dialog-description"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[rgba(15,21,23,0.85)] backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div className="relative bg-surface-float border border-border-default rounded-lg shadow-2xl max-w-md w-full mx-4 animate-in fade-in zoom-in-95 max-h-[85vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between p-5 pb-3">
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-warning/10 flex items-center justify-center">
              <Minimize2 size={18} className="text-warning" />
            </div>
            <div>
              <h3 id="compact-dialog-title" className="text-base font-semibold text-text-primary">
                Compact Context
              </h3>
              <p className="text-xs text-text-secondary mt-0.5">
                Choose how to compact your conversation
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="text-text-muted hover:text-text-primary p-1 rounded transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Context Usage Bar */}
        <div className="px-5 pb-4">
          <div className="flex items-center justify-between text-xs text-text-secondary mb-1.5">
            <span
              title="Live context window usage — % of model's window in use (incl. cache). Cache reduces cost, not context size."
              className="cursor-help"
            >
              Context usage
            </span>
            <span className="font-mono">
              {tokensK}K / {windowK}K ({percentage}%) — Quality: {qualityLabel}
            </span>
          </div>
          <div className="w-full h-2 bg-surface-overlay rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${barColor}`}
              style={{ width: `${qualityPercentage}%` }}
            />
          </div>
          <p className="mt-2 text-[10px] text-text-muted leading-snug">
            Includes all conversation history, tool definitions, and cached content — matches Claude
            Code&apos;s formula. Cache reduces cost, not context size.
          </p>
        </div>

        {/* Context Category Breakdown — Claude Code 8-category panel */}
        {!renderCategories && (
          <div className="px-5 pb-3">
            <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1.5 font-semibold">
              Breakdown by category
            </div>
            <p className="text-[11px] text-text-muted italic">
              Detailed breakdown unavailable for this executor backend. Total usage shown above.
            </p>
          </div>
        )}
        {renderCategories && renderCategories.length > 0 && (
          <div className="px-5 pb-3">
            <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1.5 font-semibold">
              Breakdown by category
            </div>
            <div className="text-[11px] text-text-secondary space-y-1">
              {renderCategories.map((cat) => {
                const pct = Math.round((cat.tokens / effectiveWindowSize) * 100)
                return (
                  <div
                    key={`${cat.name}${cat.isDeferred ? '-deferred' : ''}`}
                    className="flex justify-between items-center"
                  >
                    <span className="truncate mr-2 flex items-center gap-1.5">
                      <span
                        className="inline-block w-2 h-2 rounded-sm flex-shrink-0"
                        style={{ backgroundColor: cat.color }}
                      />
                      {cat.name}
                      {cat.isDeferred && (
                        <span
                          className="ml-1 text-[9px] px-1 py-0.5 rounded bg-surface-overlay text-text-muted"
                          title="Loaded but unused — often the surprise bloat source"
                        >
                          deferred
                        </span>
                      )}
                    </span>
                    <span className="font-mono flex-shrink-0 tabular-nums">
                      {fmtTokens(cat.tokens)} <span className="text-text-muted">({pct}%)</span>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* MCP Tools breakdown — collapsible */}
        {topMcpTools.length > 0 && (
          <div className="px-5 pb-3">
            <button
              type="button"
              onClick={() => setShowMcpDetails((v) => !v)}
              className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-text-muted hover:text-text-secondary font-semibold transition-colors"
            >
              {showMcpDetails ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              Top MCP tools by token cost
            </button>
            {showMcpDetails && (
              <div className="mt-1.5 text-[11px] text-text-secondary space-y-0.5 max-h-40 overflow-y-auto">
                {topMcpTools.map((tool) => (
                  <div
                    key={`${tool.serverName}-${tool.name}`}
                    className="flex justify-between items-center"
                  >
                    <span className="truncate mr-2 font-mono text-[10px]">
                      {tool.serverName}.{tool.name}
                    </span>
                    <span className="font-mono flex-shrink-0 tabular-nums">
                      {fmtTokens(tool.tokens)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Auto-management status badge */}
        {breakdown?.isAutoCompactEnabled && (
          <div className="px-5 pb-3">
            <div className="px-3 py-2 rounded-lg bg-success/5 border border-success/20">
              <p className="text-xs text-text-secondary">
                <span className="text-success font-medium">Auto-management active</span> — tool
                results and thinking blocks are being cleared automatically. Compaction fires at{' '}
                {breakdown.autoCompactThreshold
                  ? `${(breakdown.autoCompactThreshold / 1000).toFixed(0)}K`
                  : 'default threshold'}
                .
              </p>
            </div>
          </div>
        )}

        {isLocalProvider ? (
          <>
            {/* Local LLM: explain that compaction isn't available */}
            <div className="px-5 pb-3">
              <div className="px-3 py-2 rounded-lg bg-danger/5 border border-danger/20">
                <p className="text-xs text-text-secondary">
                  <span className="text-danger font-medium">Compaction unavailable</span> — local
                  LLMs don&apos;t support mid-conversation compaction. Context resets automatically
                  when you start a new conversation.
                </p>
              </div>
            </div>

            {/* Primary action: start new conversation */}
            <div className="px-5 pb-3 space-y-2.5">
              <button
                ref={nuanceRef}
                onClick={onNewConversation}
                className="w-full flex items-center gap-3 p-3 rounded-lg border-2 border-brand-primary/40 bg-brand-primary/5 hover:bg-brand-primary/10 transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-brand-primary/10 flex items-center justify-center">
                  <Sparkles size={16} className="text-brand-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-text-primary">
                    Start New Conversation
                  </span>
                  <p className="text-xs text-text-secondary mt-0.5">
                    Begin fresh with full context window available
                  </p>
                </div>
              </button>

              {/* Dismiss */}
              <button
                onClick={onCancel}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border-default bg-surface-overlay hover:bg-surface-raised transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-border-default"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-surface-raised flex items-center justify-center">
                  <Zap size={16} className="text-text-secondary" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-text-primary">Continue Anyway</span>
                  <p className="text-xs text-text-secondary mt-0.5">
                    Quality may degrade — model is running out of context
                  </p>
                </div>
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Warning Note */}
            <div className="px-5 pb-4">
              <div className="px-3 py-2.5 rounded-lg bg-warning/5 border border-warning/20">
                <p className="text-xs text-text-secondary leading-relaxed">
                  Standard compaction may lose important context and nuance.{' '}
                  <span className="text-warning font-medium">&quot;Extract Nuance&quot;</span>{' '}
                  preserves critical details before compacting.
                </p>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="px-5 pb-3 space-y-2.5">
              {/* Extract Nuance — Recommended */}
              <button
                ref={nuanceRef}
                onClick={onExtractNuance}
                className="w-full flex items-center gap-3 p-3 rounded-lg border-2 border-warning/40 bg-warning/5 hover:bg-warning/10 transition-colors text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-warning"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-warning/10 flex items-center justify-center">
                  <Sparkles size={16} className="text-warning" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">
                      Extract Nuance &amp; Compact
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-warning/15 text-warning">
                      Recommended
                    </span>
                  </div>
                  <p className="text-xs text-text-secondary mt-0.5">
                    Preserves decisions, preferences, and key details before compacting
                  </p>
                </div>
              </button>

              {/* Quick Compact */}
              <button
                onClick={onQuickCompact}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border-default bg-surface-overlay hover:bg-surface-raised transition-colors text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-border-default"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-surface-raised flex items-center justify-center">
                  <Zap size={16} className="text-text-secondary" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-text-primary">Quick Compact</span>
                  <p className="text-xs text-text-secondary mt-0.5">
                    Summarizes older messages — faster but may lose some context
                  </p>
                </div>
              </button>
            </div>

            {/* Cancel */}
            <div className="px-5 pb-5 pt-1 text-center">
              <button
                onClick={onCancel}
                className="text-xs text-text-muted hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
