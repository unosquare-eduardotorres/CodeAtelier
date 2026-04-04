import { useEffect, useMemo, useState } from 'react'
import { Brain, Loader2, RotateCcw, Sparkles, X } from 'lucide-react'
import {
  useConversationSpecialistActions,
  useConversationSpecialists,
  useConversationSpecialistStatus,
  useConversationTokenEstimates,
  useSpecialistStore
} from '@renderer/store'
import type { Skill, Specialist } from '../../../../shared/types'

interface SpecialistDrawerProps {
  conversationId: string
  isOpen: boolean
  onClose: () => void
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

export default function SpecialistDrawer({
  conversationId,
  isOpen,
  onClose
}: SpecialistDrawerProps): React.JSX.Element | null {
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
    if (!isOpen) return
    if (workspaceSpecialists.length === 0) {
      void loadSpecialists().catch(() => undefined)
    }
    void hydrateConversationSpecialists(conversationId).catch(() => undefined)
  }, [
    conversationId,
    hydrateConversationSpecialists,
    isOpen,
    loadSpecialists,
    workspaceSpecialists.length
  ])

  useEffect(() => {
    if (!isOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isOpen])

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
    await upsertConversationSpecialist({
      conversationId,
      specialistId,
      isActive
    })
  }

  const handleToggleSkillsEnabled = async (
    specialistId: string,
    skillsEnabled: boolean
  ): Promise<void> => {
    await upsertConversationSpecialist({
      conversationId,
      specialistId,
      skillsEnabled
    })
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

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[120] flex">
      <button
        type="button"
        className="flex-1 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close specialist drawer"
      />

      <aside className="w-full max-w-[520px] h-full bg-surface-raised border-l border-border-default shadow-2xl flex flex-col">
        <header className="px-5 py-4 border-b border-border-subtle bg-surface-float/70">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Conversation Specialists</h2>
              <p className="text-xs text-text-secondary mt-1">
                {activeCount} active · ~{TOKEN_FORMATTER.format(totalEstimatedTokens)} tokens
              </p>
            </div>
            <button
              type="button"
              className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
              onClick={onClose}
              aria-label="Close specialist drawer"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex items-center gap-2 mt-3">
            <button
              type="button"
              onClick={() =>
                void resetConversationSpecialists(conversationId).catch(() => undefined)
              }
              disabled={isMutating}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-overlay disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <RotateCcw size={12} />
              Reset conversation overrides
            </button>
            {(isLoading || isEstimating || isMutating) && (
              <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                <Loader2 size={12} className="animate-spin" />
                Syncing…
              </span>
            )}
          </div>

          {(error || specialistError) && (
            <p className="mt-2 text-xs text-danger">{error || specialistError}</p>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {sortedSpecialists.map((specialist) => {
            const conversationOverride = conversationMap.get(specialist.id)
            const estimate = estimateMap.get(specialist.id)
            const effective = getEffectiveState(specialist, conversationOverride)
            const isExpanded = expandedSpecialistId === specialist.id
            const skills = specialist.skills ?? []

            return (
              <section
                key={specialist.id}
                className="rounded-xl border border-border-subtle bg-surface-overlay/60 overflow-hidden"
              >
                <div className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div
                        className="w-9 h-9 rounded-lg border flex items-center justify-center text-sm shrink-0"
                        style={{
                          backgroundColor: `${specialist.color}22`,
                          borderColor: `${specialist.color}40`,
                          color: specialist.color
                        }}
                      >
                        {specialist.icon}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary truncate">
                          {specialist.alias || specialist.displayName}
                        </p>
                        <p className="text-xs text-text-secondary truncate">
                          {effective.isActive ? 'Active in this conversation' : 'Inactive'}
                          {estimate
                            ? ` · ~${TOKEN_FORMATTER.format(estimate.estimatedTokens)} tokens`
                            : ''}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        void handleToggleActive(specialist.id, !effective.isActive).catch(
                          () => undefined
                        )
                      }
                      disabled={isMutating}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        effective.isActive
                          ? 'border-success/30 bg-success-muted text-success'
                          : 'border-border-default bg-surface-float text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {effective.isActive ? 'Active' : 'Activate'}
                    </button>
                  </div>

                  <div className="flex items-center gap-2 mt-3">
                    <button
                      type="button"
                      onClick={() =>
                        void handleToggleSkillsEnabled(
                          specialist.id,
                          !effective.skillsEnabled
                        ).catch(() => undefined)
                      }
                      disabled={isMutating || !effective.isActive}
                      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                        effective.skillsEnabled
                          ? 'border-info/30 bg-info-muted text-info'
                          : 'border-border-default bg-surface-float text-text-secondary'
                      }`}
                    >
                      <Brain size={11} />
                      {effective.skillsEnabled ? 'Skills enabled' : 'Skills disabled'}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setExpandedSpecialistId((current) =>
                          current === specialist.id ? null : specialist.id
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium border border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-float transition-colors"
                    >
                      <Sparkles size={11} />
                      {isExpanded ? 'Hide skill overrides' : 'Adjust skill overrides'}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        void removeConversationSpecialist({
                          conversationId,
                          specialistId: specialist.id
                        }).catch(() => undefined)
                      }
                      disabled={isMutating}
                      className="ml-auto text-[11px] text-text-muted hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Reset specialist
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-4 pb-4">
                    <div className="pt-3 border-t border-border-subtle">
                      {skills.length === 0 ? (
                        <p className="text-xs text-text-muted">
                          No skills attached to this specialist.
                        </p>
                      ) : (
                        <>
                          <div className="flex items-center justify-between gap-2 mb-2">
                            <p className="text-xs font-medium text-text-secondary">
                              Skill scope for this conversation
                            </p>
                            <button
                              type="button"
                              onClick={() =>
                                void handleEnableAllSkills(specialist.id).catch(() => undefined)
                              }
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
                                  onClick={() =>
                                    void handleToggleSkill(specialist, skill.id).catch(
                                      () => undefined
                                    )
                                  }
                                  disabled={
                                    isMutating || !effective.isActive || !effective.skillsEnabled
                                  }
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
                        </>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )
          })}

          {sortedSpecialists.length === 0 && (
            <div className="rounded-lg border border-border-subtle bg-surface-overlay px-4 py-3">
              <p className="text-sm text-text-secondary">
                No specialists available in this workspace.
              </p>
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
