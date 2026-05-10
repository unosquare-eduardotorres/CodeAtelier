/**
 * SpecialistsListPage — bulk management of per-workspace Project Specialists
 * from the Settings UI.
 *
 * Phase 2 of the Project Specialist refactor. Lists every workspace's
 * specialist with its build status + last-built timestamp.
 * Editing is done via the Specialist settings tab (no more slide-over).
 */
import { useEffect } from 'react'
import { Hammer, RefreshCw } from 'lucide-react'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'
import type { ProjectSpecialist } from '@renderer/store/project-specialist.store'
import { useWorkspaceStore } from '@renderer/store/workspace.store'

export default function SpecialistsListPage(): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const byWorkspace = useProjectSpecialistStore((s) => s.byWorkspace)
  const load = useProjectSpecialistStore((s) => s.loadForWorkspace)
  const build = useProjectSpecialistStore((s) => s.build)
  const rebuildPrompt = useProjectSpecialistStore((s) => s.rebuildPrompt)

  useEffect(() => {
    for (const w of workspaces) void load(w.id)
  }, [workspaces, load])

  return (
    <div className="flex flex-col gap-4 p-4">
      <header>
        <h1 className="text-lg font-semibold">Project Specialists</h1>
        <p className="text-sm text-slate-500">
          One specialist per workspace. Use the Specialist settings tab for full editing.
        </p>
      </header>

      <ul className="flex flex-col gap-2">
        {workspaces.map((w) => {
          const specialist: ProjectSpecialist | null | undefined = byWorkspace[w.id]
          return (
            <li
              key={w.id}
              className="flex items-center gap-3 rounded-md border border-slate-200 px-3 py-2 dark:border-slate-700"
            >
              <div className="flex-1">
                <div className="font-medium">{w.name}</div>
                <div className="text-xs text-slate-500">
                  {specialist
                    ? `${specialist.buildStatus} · ${specialist.detectedTechs.length} techs${
                        specialist.lastBuiltAt
                          ? ` · built ${new Date(specialist.lastBuiltAt).toLocaleDateString()}`
                          : ' · never built'
                      }`
                    : 'No specialist yet'}
                </div>
              </div>
              {specialist?.buildStatus === 'pending' && (
                <button
                  type="button"
                  onClick={() => void build(w.id)}
                  className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                >
                  <Hammer className="h-3 w-3" /> Build now
                </button>
              )}
              {specialist?.buildStatus === 'ready' && (
                <button
                  type="button"
                  onClick={() => void rebuildPrompt(specialist.id)}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
                >
                  <RefreshCw className="h-3 w-3" /> Rebuild
                </button>
              )}
            </li>
          )
        })}
        {workspaces.length === 0 && <li className="text-sm text-slate-500">No workspaces yet.</li>}
      </ul>
    </div>
  )
}
