import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { RefreshCw, ClipboardList, LayoutList, Flame } from 'lucide-react'
import type { GrillProposedTask } from '../../../../shared/types'

interface GrillResultCardProps {
  summary: string
  proposedTasks: GrillProposedTask[]
  onKeepIterating: () => void
  onCreatePlan: () => void
  onCreateItems: () => void
}

export default function GrillResultCard({
  summary,
  proposedTasks,
  onKeepIterating,
  onCreatePlan,
  onCreateItems
}: GrillResultCardProps): React.JSX.Element {
  return (
    <div className="rounded-xl border border-grill/30 bg-grill-muted overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 bg-grill/15 border-b border-grill/20">
        <Flame size={14} className="text-accent" />
        <span className="text-sm font-medium text-accent">Grill Session Complete</span>
      </div>

      {/* Summary content */}
      <div className="px-5 py-4 prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
      </div>

      {/* Proposed tasks preview */}
      {proposedTasks.length > 0 && (
        <div className="px-5 py-3 border-t border-grill/10">
          <span className="text-xs font-medium text-accent uppercase tracking-wide">
            Proposed Tasks ({proposedTasks.length})
          </span>
          <ul className="mt-1.5 space-y-1">
            {proposedTasks.map((task, idx) => (
              <li key={idx} className="flex items-start gap-2 text-sm text-text-body">
                <span className="text-accent font-mono text-xs mt-0.5">{idx + 1}.</span>
                <div>
                  <span className="font-medium">{task.title}</span>
                  {task.description && (
                    <span className="text-text-secondary ml-1">— {task.description}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-grill/20 bg-grill-muted">
        <button
          onClick={onKeepIterating}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-surface-overlay hover:bg-surface-float text-text-body rounded-lg text-sm font-medium transition-colors press-scale"
        >
          <RefreshCw size={14} />
          Keep Iterating
        </button>
        <button
          onClick={onCreatePlan}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-mode-plan hover:brightness-110 text-white rounded-lg text-sm font-medium transition-colors press-scale"
        >
          <ClipboardList size={14} />
          Create Plan
        </button>
        <button
          onClick={onCreateItems}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium transition-colors press-scale"
        >
          <LayoutList size={14} />
          Create Items
        </button>
      </div>
    </div>
  )
}
