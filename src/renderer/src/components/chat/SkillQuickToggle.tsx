import { useEffect, useRef, useMemo } from 'react'
import { X, Zap, ZapOff } from 'lucide-react'
import {
  useConversationSpecialists,
  useConversationSpecialistActions
} from '@renderer/store'
import type { Specialist } from '../../../../shared/types'

interface SkillQuickToggleProps {
  specialist: Specialist
  conversationId: string
  onClose: () => void
}

function getEffectiveState(
  specialist: Specialist,
  conversationOverride:
    | {
        isActive: boolean
        skillsEnabled: boolean
        skillOverrides: string[] | null
      }
    | undefined
): {
  skillsEnabled: boolean
  selectedSkillIds: string[]
  allSkillIds: string[]
} {
  const allSkillIds = (specialist.skills ?? []).map((skill) => skill.id)
  const selectedSkillIds =
    conversationOverride?.skillOverrides === null ||
    conversationOverride?.skillOverrides === undefined
      ? allSkillIds
      : conversationOverride.skillOverrides

  return {
    skillsEnabled: conversationOverride?.skillsEnabled ?? true,
    selectedSkillIds,
    allSkillIds
  }
}

export default function SkillQuickToggle({
  specialist,
  conversationId,
  onClose
}: SkillQuickToggleProps): React.JSX.Element {
  const popoverRef = useRef<HTMLDivElement>(null)
  const conversationSpecialists = useConversationSpecialists(conversationId)
  const { upsertConversationSpecialist } = useConversationSpecialistActions()

  const conversationOverride = useMemo(() => {
    const entry = conversationSpecialists.find(
      (cs) => cs.specialistId === specialist.id
    )
    return entry
      ? {
          isActive: entry.isActive,
          skillsEnabled: entry.skillsEnabled,
          skillOverrides: entry.skillOverrides
        }
      : undefined
  }, [conversationSpecialists, specialist.id])

  const { skillsEnabled, selectedSkillIds, allSkillIds } = getEffectiveState(
    specialist,
    conversationOverride
  )

  const skills = specialist.skills ?? []

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const handleToggleSkillsEnabled = async (): Promise<void> => {
    await upsertConversationSpecialist({
      conversationId,
      specialistId: specialist.id,
      skillsEnabled: !skillsEnabled
    })
  }

  const handleToggleSkill = async (skillId: string): Promise<void> => {
    const isSelected = selectedSkillIds.includes(skillId)
    const nextSelected = isSelected
      ? selectedSkillIds.filter((id) => id !== skillId)
      : [...selectedSkillIds, skillId]

    const orderedSelected = allSkillIds.filter((id) => nextSelected.includes(id))
    const nextOverrides = orderedSelected.length === allSkillIds.length ? null : orderedSelected

    await upsertConversationSpecialist({
      conversationId,
      specialistId: specialist.id,
      skillOverrides: nextOverrides
    })
  }

  if (skills.length === 0) {
    return (
      <div
        ref={popoverRef}
        className="absolute z-50 top-full left-0 mt-1 w-56 bg-surface-float border border-border-default rounded-lg shadow-lg p-3"
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-text-primary">Skills</span>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-surface-overlay text-text-muted"
          >
            <X size={12} />
          </button>
        </div>
        <p className="text-xs text-text-muted">No skills assigned to this specialist.</p>
      </div>
    )
  }

  return (
    <div
      ref={popoverRef}
      className="absolute z-50 top-full left-0 mt-1 w-64 bg-surface-float border border-border-default rounded-lg shadow-lg overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
        <span className="text-xs font-medium text-text-primary">
          {specialist.displayName} Skills
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleToggleSkillsEnabled}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
              skillsEnabled
                ? 'bg-success/10 text-success hover:bg-success/20'
                : 'bg-surface-overlay text-text-muted hover:bg-surface-raised'
            }`}
            title={skillsEnabled ? 'Disable all skills' : 'Enable skills'}
          >
            {skillsEnabled ? <Zap size={10} /> : <ZapOff size={10} />}
            {skillsEnabled ? 'On' : 'Off'}
          </button>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-surface-overlay text-text-muted"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Skill list */}
      <div className="max-h-48 overflow-y-auto p-1.5">
        {skills.map((skill) => {
          const isSelected = selectedSkillIds.includes(skill.id)
          return (
            <label
              key={skill.id}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                !skillsEnabled
                  ? 'opacity-40 pointer-events-none'
                  : 'hover:bg-surface-overlay'
              }`}
            >
              <input
                type="checkbox"
                checked={isSelected && skillsEnabled}
                onChange={() => handleToggleSkill(skill.id)}
                disabled={!skillsEnabled}
                className="w-3.5 h-3.5 rounded border-border-default text-primary focus:ring-primary/50 cursor-pointer"
              />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium text-text-primary truncate">
                  {skill.name}
                </div>
                {skill.description && (
                  <div className="text-[10px] text-text-muted truncate">
                    {skill.description}
                  </div>
                )}
              </div>
            </label>
          )
        })}
      </div>
    </div>
  )
}
