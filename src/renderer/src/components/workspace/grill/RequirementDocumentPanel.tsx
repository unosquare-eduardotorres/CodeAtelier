/**
 * RequirementDocumentPanel — scrollable, copyable requirement-document preview.
 *
 * Shared between the Decisions tab (GrillDecisionsView) and the completed
 * plan-review view (GrillPage). Optionally surfaces a "Condense with AI"
 * action + a Full/Condensed toggle when a condensed variant is available.
 */

import { useState, useCallback } from 'react'
import { Copy, Check, Sparkles, FileText } from 'lucide-react'

// ── Constants ───────────────────────────────────────────────────────────────

/** Threshold for showing the "Condense with AI" button */
const CONDENSE_THRESHOLD = 15_000

// ── Props ───────────────────────────────────────────────────────────────────

interface RequirementDocumentPanelProps {
  /** Full requirement document text */
  text: string
  /** Condensed variant (if available) — enables the Full/Condensed toggle */
  condensedDocument?: string
  /** Called when the user wants to condense — omit to hide the condense action */
  onCondense?: () => void | Promise<void>
  /** Whether condensation is in progress */
  isCondensing?: boolean
}

// ── Component ───────────────────────────────────────────────────────────────

export default function RequirementDocumentPanel({
  text,
  condensedDocument,
  onCondense,
  isCondensing
}: RequirementDocumentPanelProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [showCondensed, setShowCondensed] = useState(false)

  const displayDocument = showCondensed && condensedDocument ? condensedDocument : text
  const showCondenseButton = !!onCondense && text.length > CONDENSE_THRESHOLD

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(displayDocument)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [displayDocument])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
          <FileText size={14} className="text-accent" />
          Requirement Document
          <span className="text-xs text-text-muted font-normal">
            ({displayDocument.length.toLocaleString()} chars)
          </span>
        </h3>

        <div className="flex items-center gap-2">
          {/* Toggle Full / Condensed */}
          {condensedDocument && (
            <div className="flex items-center bg-surface-base rounded-lg p-0.5 border border-border-subtle">
              <button
                onClick={() => setShowCondensed(false)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  !showCondensed
                    ? 'bg-surface-overlay text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                Full
              </button>
              <button
                onClick={() => setShowCondensed(true)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  showCondensed
                    ? 'bg-surface-overlay text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                Condensed
              </button>
            </div>
          )}

          {/* Condense button — only shown when doc > threshold */}
          {showCondenseButton && !condensedDocument && (
            <button
              onClick={onCondense}
              disabled={isCondensing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-accent border border-accent/30 hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Sparkles size={12} className={isCondensing ? 'animate-pulse' : ''} />
              {isCondensing ? 'Condensing…' : 'Condense with AI'}
            </button>
          )}

          {/* Copy button */}
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary border border-border-subtle hover:bg-surface-overlay transition-colors"
          >
            {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Document text */}
      <div className="rounded-lg border border-border-subtle bg-surface-base p-4 max-h-96 overflow-y-auto">
        <pre className="text-sm text-text-body whitespace-pre-wrap font-sans leading-relaxed">
          {displayDocument}
        </pre>
      </div>
    </div>
  )
}
