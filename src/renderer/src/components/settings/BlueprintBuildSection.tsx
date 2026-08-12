import { useAppPreferenceActions, useParallelBuildAgents, useLeanBuildMcp, useMaxStreamLifetimeMin } from '@renderer/store'

const AGENT_OPTIONS = [1, 2, 3, 4, 5, 6] as const
const LIFETIME_OPTIONS = [10, 15, 30, 45, 60, 120] as const

export default function BlueprintBuildSection(): React.JSX.Element {
  const current = useParallelBuildAgents()
  const leanMcp = useLeanBuildMcp()
  const lifetimeMin = useMaxStreamLifetimeMin()
  const { setPreference } = useAppPreferenceActions()

  return (
    <div className="space-y-4">
      <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
        <h4 className="text-sm font-medium text-text-primary">Parallel Build Agents</h4>
        <p className="text-xs text-text-secondary mt-0.5 mb-3">
          Max concurrent tasks within a Blueprint build wave. Higher values speed up builds but
          increase API rate-limit pressure. Set to 1 for sequential execution.
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

      <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-text-primary">Lean MCP Config</h4>
            <p className="text-xs text-text-secondary mt-0.5">
              Drop semantic-search and code-analysis servers from build tasks.
              Saves 2 processes per task and reduces prefill tokens, but agents lose
              ESLint auto-fix and semantic search capabilities during build.
            </p>
          </div>
          <button
            onClick={() => {
              void setPreference('leanBuildMcp', !leanMcp).catch(console.error)
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              leanMcp ? 'bg-primary' : 'bg-border-muted'
            }`}
            role="switch"
            aria-checked={leanMcp}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                leanMcp ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
        <h4 className="text-sm font-medium text-text-primary">Stream Lifetime Limit</h4>
        <p className="text-xs text-text-secondary mt-0.5 mb-3">
          Maximum duration a single chat stream can run before being force-stopped.
          Increase for long-running builds in large repos.
        </p>
        <div className="grid grid-cols-6 gap-2">
          {LIFETIME_OPTIONS.map((n) => (
            <button
              key={n}
              onClick={() => {
                void setPreference('maxStreamLifetimeMin', n).catch(console.error)
              }}
              className={`flex flex-col items-center gap-0.5 px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors ${
                lifetimeMin === n
                  ? 'border-primary bg-primary-muted text-primary-text'
                  : 'border-border-subtle hover:bg-surface-overlay text-text-secondary'
              }`}
            >
              <span className="text-base font-semibold">{n}</span>
              <span className="text-[10px] text-text-muted font-normal">
                {n >= 60 ? `${n / 60}h` : `${n} min`}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
