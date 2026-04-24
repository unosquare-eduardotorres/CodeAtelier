import type { ProjectSpecialist } from '@renderer/store/project-specialist.store'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'

interface Props {
  specialist: ProjectSpecialist
}

const KNOWN_MCPS: Array<{ id: string; label: string; description: string }> = [
  { id: 'control-actions', label: 'Control actions', description: 'Plan, ask-user MCP (always on)' },
  { id: 'code-graph', label: 'Code Graph', description: 'Semantic code navigation' },
  { id: 'semantic-search', label: 'Semantic search', description: 'Embedding-based code search' },
  { id: 'git-context', label: 'Git context', description: 'Diffs + commit history' },
  { id: 'task-context', label: 'Task context', description: 'Build-mode task tracking' },
  { id: 'checkpoint-context', label: 'Checkpoint context', description: 'File rewind + checkpoints' },
  { id: 'github-context', label: 'GitHub context', description: 'PRs, issues (requires token)' }
]

export default function SpecialistToolsTab({ specialist }: Props): React.JSX.Element {
  const toggleMcp = useProjectSpecialistStore((s) => s.toggleMcp)
  const enabled = new Set(specialist.mcpConfig?.enabled ?? [])
  const disabled = new Set(specialist.mcpConfig?.disabled ?? [])

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">MCP servers</h3>
      <ul className="flex flex-col gap-1">
        {KNOWN_MCPS.map((mcp) => {
          const isEnabled = enabled.has(mcp.id)
          const isDisabled = disabled.has(mcp.id)
          return (
            <li
              key={mcp.id}
              className="flex items-center gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-700"
            >
              <div className="flex-1">
                <div className="font-medium">{mcp.label}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {mcp.description}
                </div>
              </div>
              <span
                className={
                  isEnabled
                    ? 'rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-300'
                    : isDisabled
                      ? 'rounded bg-rose-500/15 px-1.5 py-0.5 text-xs text-rose-700 dark:text-rose-300'
                      : 'rounded bg-slate-500/15 px-1.5 py-0.5 text-xs text-slate-600 dark:text-slate-400'
                }
              >
                {isEnabled ? 'enabled' : isDisabled ? 'disabled' : 'inactive'}
              </span>
              <button
                type="button"
                onClick={() => void toggleMcp(specialist.id, mcp.id, !isEnabled)}
                className="rounded-md border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
              >
                {isEnabled ? 'Disable' : 'Enable'}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
