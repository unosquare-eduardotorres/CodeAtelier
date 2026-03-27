import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Hammer, RefreshCw, Check, ClipboardList } from 'lucide-react'

interface PlanCardProps {
  planContent: string
  onBuild: () => void
  onRefine: (feedback: string) => void
}

export default function PlanCard({
  planContent,
  onBuild,
  onRefine
}: PlanCardProps): React.JSX.Element {
  const [showRefineInput, setShowRefineInput] = useState(false)
  const [refineFeedback, setRefineFeedback] = useState('')

  return (
    <div className="rounded-xl border border-purple-500/30 bg-purple-950/20 overflow-hidden shadow-sm">
      {/* Plan header */}
      <div className="flex items-center gap-2 px-4 py-2 bg-purple-900/30 border-b border-purple-500/20">
        <ClipboardList size={14} className="text-purple-400" />
        <span className="text-sm font-medium text-purple-300">Implementation Plan</span>
      </div>

      {/* Plan content — rendered as markdown */}
      <div className="px-5 py-4 prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{planContent}</ReactMarkdown>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-purple-500/20 bg-purple-900/10">
        <button
          onClick={onBuild}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-amber-500/50 press-scale"
        >
          <Hammer size={14} />
          Build This
        </button>
        <button
          onClick={() => setShowRefineInput(!showRefineInput)}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded-lg text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <RefreshCw size={14} />
          Refine Plan
        </button>
      </div>

      {/* Inline refinement input */}
      {showRefineInput && (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-purple-500/20">
          <input
            type="text"
            value={refineFeedback}
            onChange={(e) => setRefineFeedback(e.target.value)}
            placeholder="What should change?"
            className="flex-1 bg-surface-overlay text-sm text-text-body placeholder-text-muted rounded-lg px-3 py-1.5 outline-none border border-border-subtle focus:border-purple-500"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && refineFeedback.trim()) {
                onRefine(refineFeedback.trim())
                setRefineFeedback('')
                setShowRefineInput(false)
              }
            }}
          />
          <button
            onClick={() => {
              if (refineFeedback.trim()) {
                onRefine(refineFeedback.trim())
                setRefineFeedback('')
                setShowRefineInput(false)
              }
            }}
            className="p-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-colors"
          >
            <Check size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
