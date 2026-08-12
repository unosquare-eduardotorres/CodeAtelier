import { ChevronDown, AlertTriangle, XCircle, Info, Lightbulb } from 'lucide-react'
import { type LspDiagnostic, useDiagnosticsStore } from '@renderer/store/diagnostics.store'

const EMPTY_DIAGNOSTICS: LspDiagnostic[] = []

const SEVERITY_CONFIG = {
  error: { icon: XCircle, color: 'text-red-400', label: 'Error' },
  warning: { icon: AlertTriangle, color: 'text-yellow-400', label: 'Warning' },
  info: { icon: Info, color: 'text-blue-400', label: 'Info' },
  hint: { icon: Lightbulb, color: 'text-text-muted', label: 'Hint' }
} as const

interface DiagnosticsPanelProps {
  conversationId: string
}

export default function DiagnosticsPanel({
  conversationId
}: DiagnosticsPanelProps): React.JSX.Element | null {
  const diagnostics = useDiagnosticsStore((s) => s.diagnostics[conversationId] ?? EMPTY_DIAGNOSTICS)
  const expanded = useDiagnosticsStore((s) => s.expanded)
  const toggleExpanded = useDiagnosticsStore((s) => s.toggleExpanded)

  if (diagnostics.length === 0) return null

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const warnCount = diagnostics.filter((d) => d.severity === 'warning').length
  const hasErrors = errorCount > 0

  const summary =
    [
      errorCount > 0 ? `${errorCount} error${errorCount > 1 ? 's' : ''}` : '',
      warnCount > 0 ? `${warnCount} warning${warnCount > 1 ? 's' : ''}` : ''
    ]
      .filter(Boolean)
      .join(', ') || `${diagnostics.length} diagnostic${diagnostics.length > 1 ? 's' : ''}`

  return (
    <div
      data-testid="diagnostics-panel"
      className="mx-6 mb-2 rounded-lg border border-border-subtle bg-surface-overlay/60 backdrop-blur-sm overflow-hidden"
    >
      {/* Collapsed header */}
      <button
        onClick={toggleExpanded}
        className="w-full flex items-center justify-between px-4 py-2 text-sm transition-colors hover:bg-surface-overlay/80"
      >
        <span className="flex items-center gap-2">
          {hasErrors ? (
            <XCircle size={14} className="text-red-400" />
          ) : (
            <AlertTriangle size={14} className="text-yellow-400" />
          )}
          <span className="font-medium text-text-body">Diagnostics:</span>
          <span className="tabular-nums text-text-secondary">{summary}</span>
        </span>
        <ChevronDown
          size={14}
          className={`text-text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Expanded diagnostics list */}
      {expanded && (
        <div
          data-testid="diagnostics-list"
          className="border-t border-border-subtle px-2 py-1 max-h-48 overflow-y-auto"
        >
          {diagnostics.map((diag, i) => {
            const config = SEVERITY_CONFIG[diag.severity]
            const Icon = config.icon
            return (
              <div
                key={`${diag.file}-${diag.line}-${i}`}
                className="flex items-start gap-2 px-2 py-1.5 text-sm"
              >
                <Icon size={14} className={`${config.color} flex-shrink-0 mt-0.5`} />
                <div className="min-w-0 flex-1">
                  <span className="text-text-secondary font-mono text-xs">
                    {diag.file}:{diag.line}
                  </span>
                  <span className="text-text-body ml-2">{diag.message}</span>
                  {diag.source && (
                    <span className="text-text-muted ml-1 text-xs">({diag.source})</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
