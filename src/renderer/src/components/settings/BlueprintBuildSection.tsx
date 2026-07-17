import { useAppPreferenceActions, useParallelBuildAgents } from '@renderer/store'

const AGENT_OPTIONS = [1, 2, 3, 4, 5, 6] as const

export default function BlueprintBuildSection(): React.JSX.Element {
  const current = useParallelBuildAgents()
  const { setPreference } = useAppPreferenceActions()

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <h4 className="text-sm font-medium text-text-primary">Parallel Build Agents</h4>
      <p className="text-xs text-text-secondary mt-0.5 mb-3">
        Max concurrent tasks within a Blueprint build wave. Set to 1 for sequential execution.
      </p>
      <div className="grid grid-cols-6 gap-2">
        {AGENT_OPTIONS.map((n) => (
          <button
            key={n}
            onClick={() => {
              void setPreference('parallelBuildAgents', n).catch(console.error)
            }}
            className={`flex flex-col items-center gap-0.5 px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors ${
              current === n
                ? 'border-primary bg-primary-muted text-primary-text'
                : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
            }`}
          >
            <span className="text-base font-semibold">{n}</span>
            <span className="text-[10px] text-text-muted font-normal">
              {n === 1 ? 'sequential' : `${n} agents`}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
