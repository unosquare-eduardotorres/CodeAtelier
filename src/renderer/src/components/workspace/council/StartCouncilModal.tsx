/**
 * StartCouncilModal — self-contained modal for starting a council review.
 *
 * Layout:
 *   Header:  icon + "New Council Review"
 *   Body:    type selector + per-type description + content textarea
 *   Footer:  ⌘+Enter hint + Cancel + Start Review (with spinner)
 */

import { useState } from 'react'
import { Landmark, X, Loader2 } from 'lucide-react'
import type { CouncilInputType } from '../../../../../shared/types'

const INPUT_TYPES: { value: CouncilInputType; label: string }[] = [
  { value: 'plan', label: 'Plan' },
  { value: 'requirement', label: 'Requirement' },
  { value: 'question', label: 'Question' }
]

const TYPE_DESCRIPTIONS: Record<CouncilInputType, string> = {
  plan: 'Paste an implementation plan to get scored feedback and revision suggestions.',
  requirement: 'Submit a requirement spec for adversarial review across 5 perspectives.',
  question: 'Ask a strategic question and get cross-examined analysis from multiple viewpoints.'
}

interface StartCouncilModalProps {
  isStarting: boolean
  onStart: (inputType: CouncilInputType, content: string) => void
  onClose: () => void
}

export default function StartCouncilModal({
  isStarting,
  onStart,
  onClose
}: StartCouncilModalProps): React.JSX.Element {
  const [inputType, setInputType] = useState<CouncilInputType>('plan')
  const [content, setContent] = useState('')

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && content.trim()) {
      onStart(inputType, content.trim())
    }
    if (e.key === 'Escape') onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div data-testid="council-start-modal" className="bg-surface-float rounded-xl border border-indigo-500/30 shadow-xl w-[520px] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-indigo-500/10 border-b border-indigo-500/20">
          <div className="flex items-center gap-2">
            <Landmark size={16} className="text-indigo-400" />
            <span className="text-sm font-medium text-indigo-400">New Council Review</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          {/* Input type selector */}
          <div className="flex items-center bg-surface-overlay border border-border-subtle rounded-lg p-0.5">
            {INPUT_TYPES.map((type) => (
              <button
                key={type.value}
                onClick={() => setInputType(type.value)}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  inputType === type.value
                    ? 'bg-indigo-500/20 text-indigo-400'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-float'
                }`}
              >
                {type.label}
              </button>
            ))}
          </div>

          {/* Per-type description */}
          <p className="text-xs text-text-secondary">{TYPE_DESCRIPTIONS[inputType]}</p>

          {/* Content textarea */}
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              inputType === 'plan'
                ? 'Paste your plan here...'
                : inputType === 'requirement'
                  ? 'Paste your requirement here...'
                  : 'Type your question here...'
            }
            rows={6}
            className="w-full bg-surface-base border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-muted outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 transition-colors resize-none"
            autoFocus
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle">
          <span className="text-[11px] text-text-muted">
            {content.trim() ? '⌘+Enter to start' : ' '}
          </span>
          <div className="flex items-center gap-2">
            {isStarting && (
              <span className="flex items-center gap-1.5 text-xs text-text-muted">
                <Loader2 size={12} className="animate-spin" />
                Starting…
              </span>
            )}
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary rounded-lg hover:bg-surface-overlay transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => content.trim() && onStart(inputType, content.trim())}
              disabled={!content.trim() || isStarting}
              className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-500 rounded-lg hover:brightness-110 disabled:opacity-30 transition-colors"
            >
              Start Review
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
