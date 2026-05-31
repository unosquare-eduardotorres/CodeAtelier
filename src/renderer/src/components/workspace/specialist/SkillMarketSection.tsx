/**
 * SkillMarketSection — Recommended + other skills grids with refresh/import actions.
 */

import { RefreshCw, Download, Star } from 'lucide-react'
import { SkillCard } from '@renderer/components/specialist'

// ── Types ────────────────────────────────────────────────────────────────────

interface SkillWithMeta {
  id: string
  name: string
  description?: string
  relevance?: number
  rationale?: string
  [key: string]: unknown
}

interface SkillMarketSectionProps {
  recommendedSkills: SkillWithMeta[]
  otherSkills: SkillWithMeta[]
  attachedSkillIds: Set<string>
  specialistSkills?: Array<{ id: string; isEnabled: boolean }> | null
  refreshingRecs: boolean
  importingSkill: boolean
  totalSkillCount: number
  onRefreshRecommendations: () => void
  onImportSkill: () => void
  onToggleSkill: (skillId: string, enabled: boolean) => void
  onAttachSkill: (skillId: string) => void
  onDetachSkill: (skillId: string) => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function SkillMarketSection({
  recommendedSkills,
  otherSkills,
  attachedSkillIds,
  specialistSkills,
  refreshingRecs,
  importingSkill,
  totalSkillCount,
  onRefreshRecommendations,
  onImportSkill,
  onToggleSkill,
  onAttachSkill,
  onDetachSkill
}: SkillMarketSectionProps): React.JSX.Element {
  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
          Skill Market
        </h4>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefreshRecommendations}
            disabled={refreshingRecs}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-text-secondary hover:bg-surface-overlay transition-colors disabled:opacity-40"
            title="Refresh AI-powered recommendations"
          >
            <RefreshCw size={12} className={refreshingRecs ? 'animate-spin' : ''} />
            Refresh
          </button>
          <button
            onClick={onImportSkill}
            disabled={importingSkill}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-40 transition-colors"
          >
            <Download size={12} />
            {importingSkill ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>

      {/* Recommended skills */}
      {recommendedSkills.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-1.5 mb-3">
            <Star size={12} className="text-warning" />
            <span className="text-xs font-medium text-text-primary">
              Recommended for this project
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {recommendedSkills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                isAttached={attachedSkillIds.has(skill.id)}
                isEnabled={specialistSkills?.find((s) => s.id === skill.id)?.isEnabled ?? false}
                recommendation={{
                  relevance: skill.relevance,
                  rationale: skill.rationale
                }}
                onToggle={(enabled) => onToggleSkill(skill.id, enabled)}
                onAttach={() => onAttachSkill(skill.id)}
                onDetach={() => onDetachSkill(skill.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Other skills */}
      {otherSkills.length > 0 && (
        <div>
          <span className="text-xs font-medium text-text-muted mb-3 block">Other skills</span>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {otherSkills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                isAttached={attachedSkillIds.has(skill.id)}
                isEnabled={specialistSkills?.find((s) => s.id === skill.id)?.isEnabled ?? false}
                onToggle={(enabled) => onToggleSkill(skill.id, enabled)}
                onAttach={() => onAttachSkill(skill.id)}
                onDetach={() => onDetachSkill(skill.id)}
              />
            ))}
          </div>
        </div>
      )}

      {totalSkillCount === 0 && (
        <p className="text-xs text-text-muted py-8 text-center">
          No skills available. Import a .md skill file to get started.
        </p>
      )}
    </section>
  )
}
