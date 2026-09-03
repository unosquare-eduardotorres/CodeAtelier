import {
  useAppPreferenceActions,
  useParallelBuildAgents,
  useLeanBuildMcp,
  useBlueprintAutoMode,
  useMaxStreamLifetimeMin,
  useVerifyFeatureDiff,
  useBlueprintFailureMemory
} from '@renderer/store'

const AGENT_OPTIONS = [1, 2, 3, 4, 5, 6] as const
const LIFETIME_OPTIONS = [10, 15, 30, 45, 60, 120] as const

export default function BlueprintBuildSection(): React.JSX.Element {
  const current = useParallelBuildAgents()
  const leanMcp = useLeanBuildMcp()
  const autoMode = useBlueprintAutoMode()
  const lifetimeMin = useMaxStreamLifetimeMin()
  const featureDiff = useVerifyFeatureDiff()
  const failureMemory = useBlueprintFailureMemory()
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
              Drop semantic-search and code-analysis servers from build tasks. Saves 2 processes per
              task and reduces prefill tokens, but agents lose ESLint auto-fix and semantic search
              capabilities during build.
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
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-text-primary">Auto Mode</h4>
            <p className="text-xs text-text-secondary mt-0.5">
              Bypass permission prompts during BUILD and VERIFY phases. All file writes and shell
              commands execute without asking. You already approve execution when starting the
              blueprint.
            </p>
          </div>
          <button
            onClick={() => {
              void setPreference('blueprintAutoMode', !autoMode).catch(console.error)
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              autoMode ? 'bg-primary' : 'bg-border-muted'
            }`}
            role="switch"
            aria-checked={autoMode}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                autoMode ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-text-primary">Feature Diff in Verify</h4>
            <p className="text-xs text-text-secondary mt-0.5">
              Give the VERIFY agent the whole-feature diff up front instead of letting it rediscover
              changes through tools. Fewer tool calls, but a diff only shows what was written —
              verification is partly about what is missing. Off by default; turn it on to compare.
            </p>
          </div>
          <button
            onClick={() => {
              void setPreference('verifyFeatureDiff', !featureDiff).catch(console.error)
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              featureDiff ? 'bg-primary' : 'bg-border-muted'
            }`}
            role="switch"
            aria-checked={featureDiff}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                featureDiff ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-text-primary">Structured Retry Memory</h4>
            <p className="text-xs text-text-secondary mt-0.5">
              When a build task is retried after a crashed or stalled session, replace the raw
              4,000-character transcript tail with a fixed-schema summary of what the failed attempt
              tried and why it stopped, extracted by one cheap Haiku call. Retries after a failed
              quality gate are unaffected — they already carry structured gate feedback. Falls back
              to the raw transcript whenever extraction fails. Off by default; the thing to watch is
              how often those retries now resolve, not prompt size.
            </p>
          </div>
          <button
            onClick={() => {
              void setPreference('blueprintFailureMemory', !failureMemory).catch(console.error)
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              failureMemory ? 'bg-primary' : 'bg-border-muted'
            }`}
            role="switch"
            aria-checked={failureMemory}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                failureMemory ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
        <h4 className="text-sm font-medium text-text-primary">Stream Lifetime Limit</h4>
        <p className="text-xs text-text-secondary mt-0.5 mb-3">
          Maximum duration a single chat stream can run before being force-stopped. Increase for
          long-running builds in large repos.
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
