import { useMemo } from 'react'
import type { Skill } from '../../../../../shared/types'

/**
 * Hook that derives skill recommendation mapping, attached set, and sorted lists.
 * Extracted from SpecialistPage.
 */
export function useSpecialistSkillData(opts: {
  skills: Skill[]
  specialistSkills: Array<{ id: string; isEnabled?: boolean }> | undefined
  skillRecommendations: Array<{ skillId: string; relevance: number; rationale: string }> | undefined
}) {
  const { skills, specialistSkills, skillRecommendations } = opts

  const attachedSkillIds = useMemo(
    () => new Set(specialistSkills?.map((s) => s.id) ?? []),
    [specialistSkills]
  )

  const recommendationMap = useMemo(() => {
    const map = new Map<string, { relevance: number; rationale: string }>()
    if (skillRecommendations) {
      for (const rec of skillRecommendations) {
        map.set(rec.skillId, { relevance: rec.relevance, rationale: rec.rationale })
      }
    }
    return map
  }, [skillRecommendations])

  const { recommendedSkills, otherSkills } = useMemo(() => {
    const recommended: Array<Skill & { relevance: number; rationale: string }> = []
    const other: Skill[] = []

    for (const skill of skills) {
      const rec = recommendationMap.get(skill.id)
      if (rec) {
        recommended.push({ ...skill, ...rec })
      } else {
        other.push(skill)
      }
    }

    recommended.sort((a, b) => b.relevance - a.relevance)
    other.sort((a, b) => a.name.localeCompare(b.name))

    return { recommendedSkills: recommended, otherSkills: other }
  }, [skills, recommendationMap])

  return { attachedSkillIds, recommendedSkills, otherSkills }
}
