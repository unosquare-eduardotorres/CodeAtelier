import { Star, ToggleLeft, ToggleRight, Plus, Minus } from 'lucide-react'
import type { Skill } from '../../../../shared/types'
import { getSkillIcon } from '@renderer/utils/skillIcons'

interface SkillEnrichment {
  keywords: string[]
  applicableTo: string
  complexity: 'foundational' | 'intermediate' | 'advanced'
}

interface SkillCardProps {
  skill: Skill
  isAttached: boolean
  isEnabled: boolean
  recommendation?: { relevance: number; rationale: string }
  onToggle: (enabled: boolean) => void
  onAttach: () => void
  onDetach: () => void
}

/**
 * A card component for the Skill Market grid.
 *
 * Active cards get a primary glow ring. Detached cards appear faded
 * with an attach action. Each card shows keywords and a toggle switch.
 */
export default function SkillCard({
  skill,
  isAttached,
  isEnabled,
  recommendation,
  onToggle,
  onAttach,
  onDetach
}: SkillCardProps): React.JSX.Element {
  let enrichment: SkillEnrichment | null = null
  if (skill.enrichmentJson) {
    try {
      enrichment = JSON.parse(skill.enrichmentJson) as SkillEnrichment
    } catch {
      /* ignore malformed enrichment */
    }
  }

  return (
    <div
      className={`
        rounded-xl border p-4 transition-all duration-200
        ${
          isAttached && isEnabled
            ? 'border-primary/40 bg-primary/5 ring-1 ring-primary/20 shadow-sm shadow-primary/5'
            : isAttached
              ? 'border-border-default bg-surface-overlay'
              : 'border-border-subtle bg-surface-overlay/60 opacity-75 hover:opacity-100'
        }
        hover:border-border-default
      `}
    >
      {/* Header: icon + name + relevance badge */}
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {(() => {
            const SkillIcon = getSkillIcon(skill.name)
            return (
              <SkillIcon
                size={14}
                className={`flex-shrink-0 ${isAttached && isEnabled ? 'text-primary' : 'text-text-muted'}`}
              />
            )
          })()}
          {recommendation && <Star size={10} className="text-warning flex-shrink-0" />}
          <h5 className="text-xs font-semibold text-text-primary truncate">{skill.name}</h5>
        </div>
        {recommendation && (
          <span className="text-[10px] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded-full flex-shrink-0 ml-2">
            {Math.round(recommendation.relevance * 100)}% match
          </span>
        )}
      </div>

      {/* Description */}
      <p className="text-[11px] text-text-secondary line-clamp-2 mb-3">
        {recommendation?.rationale ?? enrichment?.applicableTo ?? skill.description}
      </p>

      {/* Keywords */}
      {enrichment?.keywords && enrichment.keywords.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {enrichment.keywords.slice(0, 4).map((kw) => (
            <span
              key={kw}
              className="px-1.5 py-0.5 rounded text-[9px] text-text-muted bg-surface-base border border-border-subtle"
            >
              {kw}
            </span>
          ))}
        </div>
      )}

      {/* Footer: toggle / attach-detach */}
      <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
        {isAttached ? (
          <>
            <button
              onClick={() => onToggle(!isEnabled)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                isEnabled
                  ? 'bg-success/10 border-success/25 text-success hover:bg-success/15'
                  : 'bg-surface-base border-border-subtle text-text-muted hover:bg-surface-overlay hover:text-text-secondary'
              }`}
              title={isEnabled ? 'Disable skill' : 'Enable skill'}
            >
              {isEnabled ? (
                <ToggleRight size={14} className="text-success" />
              ) : (
                <ToggleLeft size={14} className="text-text-muted" />
              )}
              {isEnabled ? 'Enabled' : 'Disabled'}
            </button>
            <button
              onClick={onDetach}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-surface-base border border-border-subtle text-text-muted hover:bg-danger/10 hover:border-danger/25 hover:text-danger transition-colors"
              title="Detach skill"
            >
              <Minus size={12} />
              Detach
            </button>
          </>
        ) : (
          <button
            onClick={onAttach}
            className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium bg-primary/10 border border-primary/25 text-primary hover:bg-primary/20 hover:text-primary-text transition-colors"
            title="Attach skill"
          >
            <Plus size={12} />
            Attach
          </button>
        )}
      </div>
    </div>
  )
}
