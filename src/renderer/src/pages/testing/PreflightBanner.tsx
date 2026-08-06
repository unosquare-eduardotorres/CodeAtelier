/**
 * PreflightBanner — connection status + tool-capability warning.
 *
 * Single card with optional warning row separated by border-t inside,
 * rather than two stacked disconnected banners.
 */

import { RefreshCw, Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import type { E2EPreflightResult } from '../../../../shared/types'

interface PreflightBannerProps {
  preflight: E2EPreflightResult | null
  isChecking: boolean
  onCheck: () => void
  forceTools: boolean
  onForceToolsChange: (value: boolean) => void
}

export default function PreflightBanner({
  preflight,
  isChecking,
  onCheck,
  forceTools,
  onForceToolsChange
}: PreflightBannerProps): React.JSX.Element {
  const showToolWarning = preflight?.ok && preflight.supportsTools === false
  const showVisionWarning = preflight?.ok && preflight.supportsVision === false

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-overlay overflow-hidden">
      {/* Connection status row */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          {preflight === null || isChecking ? (
            <Loader2 size={16} className="text-text-secondary animate-spin" />
          ) : preflight.ok ? (
            <CheckCircle2 size={16} className="text-success" />
          ) : (
            <XCircle size={16} className="text-danger" />
          )}
          <div>
            <span className="text-sm font-medium text-text-body">oMLX Connection</span>
            {preflight?.ok && (
              <span className="ml-2 text-xs text-text-secondary">Model: {preflight.modelId}</span>
            )}
            {preflight && !preflight.ok && (
              <span className="ml-2 text-xs text-danger">{preflight.error}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Capability chips */}
          {preflight?.ok && preflight.supportsTools != null && (
            <span
              className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border ${
                preflight.supportsTools || forceTools
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-warning/30 bg-warning/10 text-warning'
              }`}
            >
              {preflight.supportsTools || forceTools ? (
                <>
                  <CheckCircle2 size={10} />
                  Tools{forceTools && !preflight.supportsTools ? ' (forced)' : ''}
                </>
              ) : (
                <>
                  <AlertTriangle size={10} />
                  No tools
                </>
              )}
            </span>
          )}
          {preflight?.ok && preflight.supportsVision != null && (
            <span
              className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border ${
                preflight.supportsVision
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-info/30 bg-info/10 text-info'
              }`}
            >
              {preflight.supportsVision ? (
                <>
                  <CheckCircle2 size={10} />
                  Vision
                </>
              ) : (
                <>
                  <AlertTriangle size={10} />
                  Text-only
                </>
              )}
            </span>
          )}

          <button
            onClick={onCheck}
            disabled={isChecking}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-border-subtle hover:bg-surface-raised transition-colors disabled:opacity-50"
          >
            {isChecking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Check
          </button>
        </div>
      </div>

      {/* Tool warning — inside the same card, separated by border-t */}
      {showToolWarning && (
        <div className="flex items-start gap-2 px-4 py-2.5 border-t border-warning/20 bg-warning/5">
          <AlertTriangle size={14} className="text-warning mt-0.5 shrink-0" />
          <div className="text-xs text-text-secondary leading-relaxed">
            <span className="font-medium text-warning">Tool calling probe returned negative.</span>{' '}
            Tool-dependent scenarios will be auto-skipped unless overridden. The probe tests native
            oMLX tool_calls, but OpenCode may drive tools differently.
            <label className="flex items-center gap-1.5 mt-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={forceTools}
                onChange={(e) => onForceToolsChange(e.target.checked)}
                className="rounded border-border-subtle text-primary-text focus:ring-primary-text/30"
              />
              <span className="text-xs text-text-body font-medium">Run tool scenarios anyway</span>
            </label>
          </div>
        </div>
      )}

      {/* Vision warning */}
      {showVisionWarning && (
        <div className="flex items-start gap-2 px-4 py-2.5 border-t border-info/20 bg-info/5">
          <AlertTriangle size={14} className="text-info mt-0.5 shrink-0" />
          <div className="text-xs text-text-secondary leading-relaxed">
            <span className="font-medium text-info">Text-only model detected.</span> Vision
            scenarios (image attachments) will be auto-skipped.
          </div>
        </div>
      )}
    </div>
  )
}
