import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { RefreshCw, ClipboardList, LayoutList } from 'lucide-react';
import type { GrillProposedTask } from '../../../../shared/types';

interface GrillResultCardProps {
  summary: string;
  proposedTasks: GrillProposedTask[];
  onKeepIterating: () => void;
  onCreatePlan: () => void;
  onCreateItems: () => void;
}

export default function GrillResultCard({
  summary,
  proposedTasks,
  onKeepIterating,
  onCreatePlan,
  onCreateItems
}: GrillResultCardProps): React.JSX.Element {
  return (
    <div className="rounded-xl border border-orange-500/30 bg-orange-950/20 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 bg-orange-900/30 border-b border-orange-500/20">
        <span>🔥</span>
        <span className="text-sm font-medium text-orange-300">Grill Session Complete</span>
      </div>

      {/* Summary content */}
      <div className="px-4 py-3 prose prose-sm prose-invert max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
      </div>

      {/* Proposed tasks preview */}
      {proposedTasks.length > 0 && (
        <div className="px-4 py-2 border-t border-orange-500/10">
          <span className="text-xs font-medium text-orange-400 uppercase tracking-wide">
            Proposed Tasks ({proposedTasks.length})
          </span>
          <ul className="mt-1.5 space-y-1">
            {proposedTasks.map((task, idx) => (
              <li key={idx} className="flex items-start gap-2 text-sm text-gray-300">
                <span className="text-orange-400 font-mono text-xs mt-0.5">{idx + 1}.</span>
                <div>
                  <span className="font-medium">{task.title}</span>
                  {task.description && (
                    <span className="text-gray-500 ml-1">— {task.description}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-4 py-3 border-t border-orange-500/20 bg-orange-900/10">
        <button
          onClick={onKeepIterating}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-sm font-medium transition-colors"
        >
          <RefreshCw size={14} />
          Keep Iterating
        </button>
        <button
          onClick={onCreatePlan}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <ClipboardList size={14} />
          Create Plan
        </button>
        <button
          onClick={onCreateItems}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <LayoutList size={14} />
          Create Items
        </button>
      </div>
    </div>
  );
}
