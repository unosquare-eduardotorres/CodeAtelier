/**
 * BtwOverlay — Dismissible overlay for `/btw` ephemeral side question answers.
 *
 * Floats above the chat panel. Shows question, answer (with markdown), loading state.
 * Keyboard: Escape to dismiss, c to copy answer.
 */
import { useEffect, useCallback } from 'react'
import { X, Copy, Check, MessageSquareDashed, Loader2 } from 'lucide-react'
import { copyTextToClipboard } from '../../utils/clipboard'
import ReactMarkdown from 'react-markdown'
import { useState } from 'react'

interface BtwOverlayProps {
  question: string
  answer: string | null // null = loading
  isLoading: boolean
  onDismiss: () => void
}

export default function BtwOverlay({
  question,
  answer,
  isLoading,
  onDismiss
}: BtwOverlayProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    if (!answer) return
    if (await copyTextToClipboard(answer)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [answer])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onDismiss()
      } else if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !isLoading && answer) {
        // Only copy if not typing in an input
        const tag = (e.target as HTMLElement)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          handleCopy()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onDismiss, handleCopy, isLoading, answer])

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="relative mx-6 max-w-2xl w-full max-h-[80%] flex flex-col bg-surface-overlay border border-border-subtle rounded-xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2 text-blue-400">
            <MessageSquareDashed size={18} />
            <span className="text-sm font-semibold">Side Question</span>
          </div>
          <div className="flex items-center gap-1">
            {answer && (
              <button
                onClick={handleCopy}
                className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                aria-label="Copy answer"
                title="Copy answer (c)"
              >
                {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
              </button>
            )}
            <button
              onClick={onDismiss}
              className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
              aria-label="Dismiss (Esc)"
              title="Dismiss (Esc)"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Question */}
        <div className="px-5 py-3 border-b border-border-subtle bg-surface-base/40">
          <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Question</p>
          <p className="text-sm text-text-secondary">{question}</p>
        </div>

        {/* Answer */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-[100px]">
          {isLoading ? (
            <div className="flex items-center gap-3 text-text-muted">
              <Loader2 size={18} className="animate-spin" />
              <span className="text-sm">Thinking…</span>
            </div>
          ) : (
            <div className="prose prose-invert prose-sm max-w-none text-text-body">
              <ReactMarkdown>{answer ?? ''}</ReactMarkdown>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2 border-t border-border-subtle">
          <p className="text-xs text-text-muted text-center">
            Press <kbd className="px-1 py-0.5 bg-surface-base rounded text-[10px]">Esc</kbd> to dismiss
            {!isLoading && answer && (
              <>
                {' · '}
                <kbd className="px-1 py-0.5 bg-surface-base rounded text-[10px]">c</kbd> to copy
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  )
}
