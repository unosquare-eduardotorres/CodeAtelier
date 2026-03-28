import { Puzzle } from 'lucide-react'
import type { Skill, MarketplaceSpecialist } from '../../../../shared/types'

interface SkillsLibraryProps {
  skills: Skill[]
  specialists: MarketplaceSpecialist[]
  onSkillClick?: (skill: Skill) => void
}

export default function SkillsLibrary({
  skills,
  specialists,
  onSkillClick
}: SkillsLibraryProps): React.JSX.Element {
  // Build a map: skillId → count of specialists that use it
  const skillUsageMap = new Map<string, number>()
  for (const sp of specialists) {
    for (const sk of sp.skills) {
      skillUsageMap.set(sk.id, (skillUsageMap.get(sk.id) || 0) + 1)
    }
  }

  if (skills.length === 0) return <></>

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-3">
        <Puzzle size={14} className="text-text-muted" />
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
          Skills Library ({skills.length})
        </h3>
      </div>
      <p className="text-xs text-text-muted mb-3">
        Skills are auto-deployed with their specialists. Click to view details.
      </p>
      <div className="flex flex-wrap gap-2">
        {skills.map((skill) => {
          const usedBy = skillUsageMap.get(skill.id) ?? 0
          return (
            <button
              key={skill.id}
              onClick={() => onSkillClick?.(skill)}
              className="group flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle
                hover:border-border-default hover:bg-surface-float transition-all text-left"
              title={skill.description || skill.name}
            >
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-medium text-text-primary truncate max-w-[140px]">
                  {skill.name}
                </span>
                <span className="text-[10px] text-text-muted">
                  {usedBy > 0
                    ? `Used by ${usedBy} specialist${usedBy > 1 ? 's' : ''}`
                    : 'Not assigned'}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
