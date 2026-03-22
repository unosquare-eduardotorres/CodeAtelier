import { ArrowRight } from 'lucide-react'

interface HandoffIndicatorProps {
  summary: string
  specialists: string[]
  mode: 'plan' | 'build'
}

export default function HandoffIndicator({
  summary,
  specialists,
  mode
}: HandoffIndicatorProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 px-4 py-3 my-2 rounded-xl bg-indigo-900/30 border border-indigo-500/30">
      <ArrowRight size={16} className="text-indigo-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-indigo-300">Handing off to specialists</p>
        <p className="text-xs text-gray-400 mt-0.5 truncate">{summary}</p>
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {specialists.map((s) => (
            <span
              key={s}
              className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/20"
            >
              {s}
            </span>
          ))}
        </div>
      </div>
      <span
        className={`text-[10px] px-2 py-0.5 rounded-full ${
          mode === 'build' ? 'bg-amber-500/20 text-amber-300' : 'bg-purple-500/20 text-purple-300'
        }`}
      >
        {mode}
      </span>
    </div>
  )
}
