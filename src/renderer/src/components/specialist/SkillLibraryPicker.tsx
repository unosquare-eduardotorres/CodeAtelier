/**
 * SkillLibraryPicker — placeholder component for Phase 2. Full-featured
 * picker is folded into SpecialistSkillsTab; this stub exists so the
 * slide-over can host it as a separate component later (Phase 3 polish).
 */
import type { ProjectSpecialist } from '@renderer/store/project-specialist.store'

interface Props {
  specialist: ProjectSpecialist
  onAttach?: (skillId: string) => void
}

export default function SkillLibraryPicker(_props: Props): React.JSX.Element {
  return (
    <div className="text-sm text-slate-500">
      Skill library picker — attached skills managed inline in the Skills tab.
      (Full browse-all-skills picker is a Phase 3 polish item.)
    </div>
  )
}
