import { useEffect, useMemo, useState } from 'react'
import { Brain, Loader2, RotateCcw, Sparkles, ChevronDown, ChevronRight } from 'lucide-react'
import {
  useConversationSpecialistActions,
  useConversationSpecialists,
  useConversationSpecialistStatus,
  useConversationTokenEstimates,
  useSpecialistStore
} from '@renderer/store'
import type { Skill, Specialist } from '../../../../shared/types'
import { PixelSpriteAvatar, Avatar } from '@renderer/components/common'
import { AgentIcon, AGENT_ICON_MAP } from '@renderer/assets/agent-icons'

interface SpecialistsTableProps {
  conversationId: string
}

const TOKEN_FORMATTER = new Intl.NumberFormat('en-US')

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
  isActive: boolean
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
    isActive: conversationOverride?.isActive ?? specialist.isActive,
    skillsEnabled: conversationOverride?.skillsEnabled ?? true,
    selectedSkillIds,
    allSkillIds
  }
}

export default function SpecialistsTable({
  conversationId
}: SpecialistsTableProps): React.JSX.Element {
  const [expandedSpecialistId, setExpandedSpecialistId] = useState<string | null>(null)
  const workspaceSpecialists = useSpecialistStore((state) => state.specialists)
  const loadSpecialists = useSpecialistStore((state) => state.loadSpecialists)
  const specialistError = useSpecialistStore((state) => state.error)
  const conversationSpecialists = useConversationSpecialists(conversationId)
  const tokenEstimates = useConversationTokenEstimates(conversationId)
  const { isLoading, isMutating, isEstimating, error } =
    useConversationSpecialistStatus(conversationId)
  const {
    hydrateConversationSpecialists,
    upsertConversationSpecialist,
    removeConversationSpecialist,
    resetConversationSpecialists
  } = useConversationSpecialistActions()

  useEffect(() => {
    if (workspaceSpecialists.length === 0) {
      void loadSpecialists().catch(() => undefined)
    }
    void hydrateConversationSpecialists(conversationId).catch(() => undefined)
  }, [conversationId, hydrateConversationSpecialists, loadSpecialists, workspaceSpecialists.length])

  const conversationMap = useMemo(
    () => new Map(conversationSpecialists.map((item) => [item.specialistId, item])),
    [conversationSpecialists]
  )

  const estimateMap = useMemo(
    () => new Map(tokenEstimates.map((estimate) => [estimate.specialistId, estimate])),
    [tokenEstimates]
  )

  const sortedSpecialists = useMemo(
    () =>
      [...workspaceSpecialists].sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority
        return a.displayName.localeCompare(b.displayName)
      }),
    [workspaceSpecialists]
  )

  const activeCount = useMemo(
    () =>
      sortedSpecialists.filter((specialist) => {
        if (specialist.isCore) return false
        const effective = getEffectiveState(specialist, conversationMap.get(specialist.id))
        return effective.isActive
      }).length,
    [conversationMap, sortedSpecialists]
  )

  const totalEstimatedTokens = useMemo(
    () => tokenEstimates.reduce((sum, estimate) => sum + estimate.estimatedTokens, 0),
    [tokenEstimates]
  )

  const handleToggleActive = async (specialistId: string, isActive: boolean): Promise<void> => {
    await upsertConversationSpecialist({ conversationId, specialistId, isActive })
  }

  const handleToggleSkillsEnabled = async (
    specialistId: string,
    skillsEnabled: boolean
  ): Promise<void> => {
    await upsertConversationSpecialist({ conversationId, specialistId, skillsEnabled })
  }

  const handleToggleSkill = async (specialist: Specialist, skillId: string): Promise<void> => {
    const override = conversationMap.get(specialist.id)
    const { allSkillIds, selectedSkillIds } = getEffectiveState(specialist, override)
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

  const handleEnableAllSkills = async (specialistId: string): Promise<void> => {
    await upsertConversationSpecialist({
      conversationId,
      specialistId,
      skillOverrides: null
    })
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Table header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border-subtle bg-surface-overlay/50">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-text-secondary">
            {activeCount} active · ~{TOKEN_FORMATTER.format(totalEstimatedTokens)} tokens
          </span>
          {(isLoading || isEstimating || isMutating) && (
            <span className="inline-flex items-center gap-1 text-xs text-text-muted">
              <Loader2 size={12} className="animate-spin" />
              Syncing...
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void resetConversationSpecialists(conversationId).catch(() => undefined)}
          disabled={isMutating}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-overlay disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <RotateCcw size={12} />
          Reset overrides
        </button>
      </div>

      {(error || specialistError) && (
        <div className="px-6 py-2 text-xs text-danger bg-danger/5 border-b border-danger/20">
          {error || specialistError}
        </div>
      )}

      {/* Table body */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface-raised z-10">
            <tr className="border-b border-border-subtle text-text-secondary">
              <th className="text-left font-medium px-6 py-2.5 w-10"></th>
              <th className="text-left font-medium px-2 py-2.5">Name</th>
              <th className="text-left font-medium px-2 py-2.5 w-24">Status</th>
              <th className="text-left font-medium px-2 py-2.5 w-24">Skills</th>
              <th className="text-right font-medium px-2 py-2.5 w-28">Tokens</th>
              <th className="text-right font-medium px-6 py-2.5 w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedSpecialists.map((specialist) => {
              const conversationOverride = conversationMap.get(specialist.id)
              const estimate = estimateMap.get(specialist.id)
              const effective = getEffectiveState(specialist, conversationOverride)
              const isExpanded = expandedSpecialistId === specialist.id
              const skills = specialist.skills ?? []
              const color = specialist.color ?? '#6B7280'

              return (
                <SpecialistRow
                  key={specialist.id}
                  specialist={specialist}
                  color={color}
                  effective={effective}
                  estimate={estimate}
                  skills={skills}
                  isExpanded={isExpanded}
                  isMutating={isMutating}
                  onToggleExpand={() =>
                    setExpandedSpecialistId((cur) => (cur === specialist.id ? null : specialist.id))
                  }
                  onToggleActive={() =>
                    void handleToggleActive(specialist.id, !effective.isActive).catch(() => undefined)
                  }
                  onToggleSkillsEnabled={() =>
                    void handleToggleSkillsEnabled(specialist.id, !effective.skillsEnabled).catch(
                      () => undefined
                    )
                  }
                  onToggleSkill={(skillId) =>
                    void handleToggleSkill(specialist, skillId).catch(() => undefined)
                  }
                  onEnableAllSkills={() =>
                    void handleEnableAllSkills(specialist.id).catch(() => undefined)
                  }
                  onReset={() =>
                    void removeConversationSpecialist({
                      conversationId,
                      specialistId: specialist.id
                    }).catch(() => undefined)
                  }
                />
              )
            })}
          </tbody>
        </table>

        {sortedSpecialists.length === 0 && (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-text-secondary">No specialists available in this workspace.</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Row sub-component ──

interface SpecialistRowProps {
  specialist: Specialist
  color: string
  effective: {
    isActive: boolean
    skillsEnabled: boolean
    selectedSkillIds: string[]
    allSkillIds: string[]
  }
  estimate: { estimatedTokens: number } | undefined
  skills: Skill[]
  isExpanded: boolean
  isMutating: boolean
  onToggleExpand: () => void
  onToggleActive: () => void
  onToggleSkillsEnabled: () => void
  onToggleSkill: (skillId: string) => void
  onEnableAllSkills: () => void
  onReset: () => void
}

function SpecialistRow({
  specialist,
  color,
  effective,
  estimate,
  skills,
  isExpanded,
  isMutating,
  onToggleExpand,
  onToggleActive,
  onToggleSkillsEnabled,
  onToggleSkill,
  onEnableAllSkills,
  onReset
}: SpecialistRowProps): React.JSX.Element {
  return (
    <>
      <tr
        className="border-b border-border-subtle/50 hover:bg-surface-overlay/30 transition-colors cursor-pointer"
        onClick={onToggleExpand}
      >
        {/* Avatar */}
        <td className="px-6 py-3">
          <div
            className="w-8 h-8 rounded-lg border flex items-center justify-center text-sm shrink-0 overflow-hidden"
            style={{
              backgroundColor: `${color}22`,
              borderColor: `${color}40`,
              color
            }}
          >
            {specialist.usePixelForChat && specialist.pixelSpriteId ? (
              <PixelSpriteAvatar spriteId={specialist.pixelSpriteId} size={24} />
            ) : specialist.avatarUrl ? (
              <Avatar avatarKey={specialist.avatarUrl} size="sm" accentColor={color} />
            ) : specialist.agentId && AGENT_ICON_MAP[specialist.agentId] ? (
              <AgentIcon agentType={specialist.agentId} size={18} />
            ) : (
              <span className="text-sm leading-none">{specialist.icon}</span>
            )}
          </div>
        </td>

        {/* Name */}
        <td className="px-2 py-3">
          <div className="flex items-center gap-2 min-w-0">
            {isExpanded ? (
              <ChevronDown size={12} className="text-text-muted shrink-0" />
            ) : (
              <ChevronRight size={12} className="text-text-muted shrink-0" />
            )}
            <span className="text-sm font-medium text-text-primary truncate">
              {specialist.alias || specialist.displayName}
            </span>
          </div>
        </td>

        {/* Status */}
        <td className="px-2 py-3" onClick={(e) => e.stopPropagation()}>
          {specialist.isCore ? (
            <span className="px-2 py-0.5 rounded text-[10px] font-medium border border-success/30 bg-success-muted text-success">
              Required
            </span>
          ) : (
            <button
              type="button"
              onClick={onToggleActive}
              disabled={isMutating}
              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                effective.isActive
                  ? 'border-success/30 bg-success-muted text-success'
                  : 'border-border-default bg-surface-float text-text-secondary hover:text-text-primary'
              }`}
            >
              {effective.isActive ? 'Active' : 'Activate'}
            </button>
          )}
        </td>

        {/* Skills count */}
        <td className="px-2 py-3">
          <span className="text-text-secondary">
            {effective.selectedSkillIds.length}/{effective.allSkillIds.length}
          </span>
        </td>

        {/* Tokens */}
        <td className="px-2 py-3 text-right">
          <span className="text-text-secondary tabular-nums">
            {estimate ? `~${TOKEN_FORMATTER.format(estimate.estimatedTokens)}` : '--'}
          </span>
        </td>

        {/* Actions */}
        <td className="px-6 py-3 text-right" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={onToggleSkillsEnabled}
              disabled={isMutating || !effective.isActive}
              className={`p-1 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                effective.skillsEnabled
                  ? 'text-info hover:bg-info-muted'
                  : 'text-text-muted hover:bg-surface-overlay'
              }`}
              title={effective.skillsEnabled ? 'Skills enabled' : 'Skills disabled'}
            >
              <Brain size={14} />
            </button>
            {!specialist.isCore && (
              <button
                type="button"
                onClick={onReset}
                disabled={isMutating}
                className="text-[10px] text-text-muted hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Reset
              </button>
            )}
          </div>
        </td>
      </tr>

      {/* Expanded skill row */}
      {isExpanded && (
        <tr className="border-b border-border-subtle/50 bg-surface-overlay/20">
          <td colSpan={6} className="px-6 py-3">
            {skills.length === 0 ? (
              <p className="text-xs text-text-muted">No skills attached to this specialist.</p>
            ) : (
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="text-xs font-medium text-text-secondary">
                    <Sparkles size={11} className="inline mr-1" />
                    Skill scope for this conversation
                  </p>
                  <button
                    type="button"
                    onClick={() => onEnableAllSkills()}
                    disabled={isMutating || !effective.isActive}
                    className="text-[11px] text-info hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Use all skills
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {skills.map((skill: Skill) => {
                    const selected = effective.selectedSkillIds.includes(skill.id)
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        onClick={() => onToggleSkill(skill.id)}
                        disabled={isMutating || !effective.isActive || !effective.skillsEnabled}
                        className={`px-2 py-1 rounded-md text-[11px] border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                          selected
                            ? 'bg-primary-muted text-primary-text border-primary/30'
                            : 'bg-surface-float text-text-secondary border-border-default hover:text-text-primary'
                        }`}
                        title={skill.description}
                      >
                        {skill.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {estimate && estimate.estimatedTokens > 0 && (
              <div className="mt-2 pt-2 border-t border-border-subtle/50">
                <p className="text-[11px] text-text-muted mb-1">Token breakdown:</p>
                <div className="text-[11px] text-text-secondary space-y-0.5">
                  {estimate.promptTokens > 0 && (
                    <div>Prompt: ~{TOKEN_FORMATTER.format(estimate.promptTokens)}</div>
                  )}
                  {estimate.skillBreakdown?.map((s) => (
                    <div key={s.name}>{s.name}: ~{TOKEN_FORMATTER.format(s.tokens)}</div>
                  ))}
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
