import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { ProjectSpecialist } from '@renderer/store/project-specialist.store'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'
import { useSkillStore } from '@renderer/store/skill.store'

interface Props {
  specialist: ProjectSpecialist
}

/**
 * Skills tab. Two sections:
 *   1. **Attached** — skills bound to this specialist via specialist_skills.
 *      Each shows its enable/disable state from is_enabled; a trash button
 *      detaches it.
 *   2. **Library** — skills that exist in the app but are not attached to
 *      this specialist. Each has an Attach button.
 *
 * After migration 66 every attached skill starts **disabled** so the user
 * opts into influence one-by-one.
 */
export default function SpecialistSkillsTab({ specialist }: Props): React.JSX.Element {
  const librarySkills = useSkillStore((s) => s.skills)
  const loadLibrary = useSkillStore((s) => s.loadSkills)
  const loadForWorkspace = useProjectSpecialistStore((s) => s.loadForWorkspace)
  const toggleSkill = useProjectSpecialistStore((s) => s.toggleSkill)
  const attachSkill = useProjectSpecialistStore((s) => s.attachSkill)
  const detachSkill = useProjectSpecialistStore((s) => s.detachSkill)

  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (librarySkills.length === 0) void loadLibrary()
  }, [librarySkills.length, loadLibrary])

  const attached = specialist.skills ?? []
  const attachedIds = new Set(attached.map((s) => s.id))
  const available = librarySkills.filter((s) => !attachedIds.has(s.id))

  async function runAndReload(skillId: string, action: () => Promise<void>): Promise<void> {
    setBusy(skillId)
    try {
      await action()
      await loadForWorkspace(specialist.workspaceId)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="text-sm font-semibold mb-2">Attached to this specialist</h3>
        {attached.length === 0 ? (
          <p className="text-xs text-slate-500">
            No skills attached yet. Attach from the library below.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {attached.map((skill) => (
              <li
                key={skill.id}
                className="flex items-center gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-700"
              >
                <div className="flex-1">
                  <div className="font-medium">{skill.name}</div>
                  {skill.description && (
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {skill.description}
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={skill.isEnabled}
                    disabled={busy === skill.id}
                    onChange={(e) =>
                      void runAndReload(skill.id, () =>
                        toggleSkill(specialist.id, skill.id, e.target.checked)
                      )
                    }
                  />
                  <span>{skill.isEnabled ? 'enabled' : 'disabled'}</span>
                </label>
                <button
                  type="button"
                  disabled={busy === skill.id}
                  onClick={() =>
                    void runAndReload(skill.id, () => detachSkill(specialist.id, skill.id))
                  }
                  aria-label={`Detach ${skill.name}`}
                  className="rounded-md border border-rose-300 px-2 py-0.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-700 dark:hover:bg-rose-900/30"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-2">Available in library</h3>
        {available.length === 0 ? (
          <p className="text-xs text-slate-500">All library skills are already attached.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {available.map((skill) => (
              <li
                key={skill.id}
                className="flex items-center gap-3 rounded-md border border-dashed border-slate-200 px-3 py-2 text-sm dark:border-slate-700"
              >
                <div className="flex-1">
                  <div className="font-medium">{skill.name}</div>
                  {skill.description && (
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {skill.description}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  disabled={busy === skill.id}
                  onClick={() =>
                    void runAndReload(skill.id, () => attachSkill(specialist.id, skill.id))
                  }
                  className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" /> Attach
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
