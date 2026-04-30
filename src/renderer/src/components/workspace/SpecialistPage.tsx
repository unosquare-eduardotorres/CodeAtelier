/**
 * SpecialistPage — Full specialist administration page.
 *
 * Replaces the old SpecialistSlideOver and provides:
 * - Rebuild with progress spinner, success, and error feedback
 * - Prompt preview with edit + save
 * - LLM-powered Skill Market (recommended + other sections)
 * - Import custom skills from disk
 * - Detected stack display
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Bot,
  RefreshCw,
  Save,
  Download,
  Star,
  CheckCircle,
  XCircle,
  Loader2,
  Hammer,
  ToggleLeft,
  ToggleRight,
  Plus,
  Minus,
  Tag
} from 'lucide-react'
import { useWorkspaceStore, useSkillStore, useToastStore } from '@renderer/store'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'
import { Avatar, SettingsCard } from '@renderer/components/common'
import { getWorkspaceMannequin } from '@renderer/utils/workspaceMannequin'
import type { Skill } from '../../../../shared/types'

// ── Types ────────────────────────────────────────────────────────────────────

interface SkillEnrichment {
  keywords: string[]
  applicableTo: string
  complexity: 'foundational' | 'intermediate' | 'advanced'
}

type RebuildState = 'idle' | 'building' | 'success' | 'failed'

// ── Component ────────────────────────────────────────────────────────────────

export default function SpecialistPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const workspaceId = activeWorkspace?.id ?? null

  const specialist = useProjectSpecialistStore((s) =>
    workspaceId ? s.byWorkspace[workspaceId] : null
  )
  const buildProgress = useProjectSpecialistStore((s) =>
    specialist ? s.buildProgress[specialist.id] : null
  )
  const storeError = useProjectSpecialistStore((s) => s.error)
  const {
    loadForWorkspace,
    build,
    rebuildPrompt,
    updatePrompt,
    toggleSkill,
    attachSkill,
    detachSkill,
    refreshRecommendations,
    clearError
  } = useProjectSpecialistStore()

  const { skills, loadSkills, importSkill } = useSkillStore()
  const addToast = useToastStore((s) => s.addToast)

  // ── Local state ──────────────────────────────────────────────────────────

  const [rebuildState, setRebuildState] = useState<RebuildState>('idle')
  const [rebuildError, setRebuildError] = useState<string | null>(null)
  const [editedPrompt, setEditedPrompt] = useState<string>('')
  const [promptDirty, setPromptDirty] = useState(false)
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [refreshingRecs, setRefreshingRecs] = useState(false)
  const [importingSkill, setImportingSkill] = useState(false)

  // ── Effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (workspaceId) void loadForWorkspace(workspaceId)
  }, [workspaceId, loadForWorkspace])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  // Sync prompt textarea when specialist prompt changes
  useEffect(() => {
    if (specialist?.prompt !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from external store update
      setEditedPrompt(specialist.prompt)
      setPromptDirty(false)
    }
  }, [specialist?.prompt])

  // Track rebuild state from build progress events
  useEffect(() => {
    if (!buildProgress) return undefined
    if (buildProgress.phase === 'started') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from event stream
      setRebuildState('building')
      setRebuildError(null)
    } else if (buildProgress.phase === 'ready') {
      setRebuildState('success')
      // Auto-revert to idle after 2.5s
      const timer = setTimeout(() => setRebuildState('idle'), 2500)
      return () => clearTimeout(timer)
    } else if (buildProgress.phase === 'failed') {
      setRebuildState('failed')
      setRebuildError(buildProgress.message)
    }
    return undefined
  }, [buildProgress])

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleRebuild = useCallback(async () => {
    if (!workspaceId) return
    setRebuildState('building')
    setRebuildError(null)
    try {
      await build(workspaceId)
    } catch (err) {
      setRebuildState('failed')
      setRebuildError((err as Error).message)
    }
  }, [workspaceId, build])

  const handleRebuildPrompt = useCallback(async () => {
    if (!specialist) return
    setRebuildState('building')
    setRebuildError(null)
    try {
      await rebuildPrompt(specialist.id)
    } catch (err) {
      setRebuildState('failed')
      setRebuildError((err as Error).message)
    }
  }, [specialist, rebuildPrompt])

  const handleSavePrompt = useCallback(async () => {
    if (!specialist || !promptDirty) return
    setSavingPrompt(true)
    try {
      await updatePrompt(specialist.id, editedPrompt)
      setPromptDirty(false)
      addToast({ message: 'Prompt saved', type: 'success' })
    } catch {
      addToast({ message: 'Failed to save prompt', type: 'error' })
    } finally {
      setSavingPrompt(false)
    }
  }, [specialist, editedPrompt, promptDirty, updatePrompt, addToast])

  const handleImportSkill = useCallback(async () => {
    setImportingSkill(true)
    try {
      const filePath = await window.api.selectSkillFile()
      if (!filePath) {
        setImportingSkill(false)
        return
      }
      const result = await importSkill(filePath)
      if (result.success) {
        addToast({ message: 'Skill imported successfully', type: 'success' })
        // Reload specialist to pick up new skills
        if (workspaceId) await loadForWorkspace(workspaceId)
      } else {
        addToast({ message: result.error ?? 'Import failed', type: 'error' })
      }
    } catch (err) {
      addToast({ message: (err as Error).message, type: 'error' })
    } finally {
      setImportingSkill(false)
    }
  }, [importSkill, workspaceId, loadForWorkspace, addToast])

  const handleRefreshRecommendations = useCallback(async () => {
    if (!specialist) return
    setRefreshingRecs(true)
    try {
      await refreshRecommendations(specialist.id)
      addToast({ message: 'Recommendations refreshed', type: 'success' })
    } catch {
      addToast({ message: 'Failed to refresh recommendations', type: 'error' })
    } finally {
      setRefreshingRecs(false)
    }
  }, [specialist, refreshRecommendations, addToast])

  const handleToggleSkill = useCallback(
    async (skillId: string, enabled: boolean) => {
      if (!specialist) return
      try {
        await toggleSkill(specialist.id, skillId, enabled)
        if (workspaceId) await loadForWorkspace(workspaceId)
      } catch {
        addToast({ message: 'Failed to toggle skill', type: 'error' })
      }
    },
    [specialist, workspaceId, toggleSkill, loadForWorkspace, addToast]
  )

  const handleAttachSkill = useCallback(
    async (skillId: string) => {
      if (!specialist) return
      try {
        await attachSkill(specialist.id, skillId)
        if (workspaceId) await loadForWorkspace(workspaceId)
        addToast({ message: 'Skill attached', type: 'success' })
      } catch {
        addToast({ message: 'Failed to attach skill', type: 'error' })
      }
    },
    [specialist, workspaceId, attachSkill, loadForWorkspace, addToast]
  )

  const handleDetachSkill = useCallback(
    async (skillId: string) => {
      if (!specialist) return
      try {
        await detachSkill(specialist.id, skillId)
        if (workspaceId) await loadForWorkspace(workspaceId)
        addToast({ message: 'Skill detached', type: 'success' })
      } catch {
        addToast({ message: 'Failed to detach skill', type: 'error' })
      }
    },
    [specialist, workspaceId, detachSkill, loadForWorkspace, addToast]
  )

  // ── Derived data ─────────────────────────────────────────────────────────

  const specialistSkills = specialist?.skills
  const skillRecommendations = specialist?.skillRecommendations

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

  // ── No specialist state ──────────────────────────────────────────────────

  if (!specialist) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <Bot size={16} className="text-primary-text" />
          <h3 className="text-sm font-semibold text-text-primary">Specialist</h3>
        </div>
        <p className="text-xs text-text-secondary">
          No specialist configured for this workspace. Open a chat to get started.
        </p>
      </div>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="p-6 space-y-6">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Avatar
            avatarKey={getWorkspaceMannequin(
              activeWorkspace?.id ?? '',
              useWorkspaceStore.getState().workspaces
            )}
            size="sm"
            accentColor={specialist.color ?? '#B8976A'}
          />
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{specialist.displayName}</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <StatusBadge status={specialist.buildStatus} />
              {specialist.lastBuiltAt && (
                <span className="text-[10px] text-text-muted">
                  Built {new Date(specialist.lastBuiltAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
        </div>

        <RebuildButton
          state={rebuildState}
          onClick={handleRebuild}
          progressMessage={buildProgress?.message}
        />
      </div>

      {/* Error banner */}
      {rebuildState === 'failed' && rebuildError && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-danger-muted border border-danger/20">
          <XCircle size={14} className="text-danger flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-danger font-medium">Build failed</p>
            <p className="text-[11px] text-text-secondary mt-0.5 break-words">{rebuildError}</p>
          </div>
          <button
            onClick={handleRebuild}
            className="text-[11px] font-medium text-primary hover:text-primary-text px-2 py-1 rounded hover:bg-primary-muted transition-colors flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* Store-level error (from other operations) */}
      {storeError && rebuildState !== 'failed' && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-danger-muted border border-danger/20">
          <XCircle size={14} className="text-danger flex-shrink-0" />
          <p className="text-xs text-danger flex-1">{storeError}</p>
          <button onClick={clearError} className="text-xs text-text-muted hover:text-text-body">
            Dismiss
          </button>
        </div>
      )}

      {/* ── Detected Stack ──────────────────────────────────────────── */}
      {specialist.detectedTechs.length > 0 && (
        <SettingsCard>
          <h4 className="text-xs font-semibold text-text-primary mb-2">Detected Stack</h4>
          <div className="flex flex-wrap gap-1.5">
            {specialist.detectedTechs.map((tech) => (
              <span
                key={tech}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-surface-overlay text-text-body border border-border-subtle"
              >
                {tech}
              </span>
            ))}
          </div>
        </SettingsCard>
      )}

      {/* ── Prompt Section ──────────────────────────────────────────── */}
      <SettingsCard>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-text-primary">System Prompt</h4>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-text-muted">
              {editedPrompt.length.toLocaleString()} chars
            </span>
            <button
              onClick={handleSavePrompt}
              disabled={!promptDirty || savingPrompt}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Save size={12} />
              {savingPrompt ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={handleRebuildPrompt}
              disabled={rebuildState === 'building'}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-text-secondary hover:bg-surface-overlay transition-colors disabled:opacity-40"
              title="Rebuild prompt using LLM"
            >
              <RefreshCw size={12} className={rebuildState === 'building' ? 'animate-spin' : ''} />
              Rebuild
            </button>
          </div>
        </div>
        <textarea
          value={editedPrompt}
          onChange={(e) => {
            setEditedPrompt(e.target.value)
            setPromptDirty(e.target.value !== specialist.prompt)
          }}
          className="w-full h-64 px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-xs text-text-body font-mono resize-y focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40"
          placeholder="Specialist prompt will appear here after building…"
          spellCheck={false}
        />
      </SettingsCard>

      {/* ── Skills Section — "Skill Market" ─────────────────────────── */}
      <SettingsCard>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-xs font-semibold text-text-primary">Skill Market</h4>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefreshRecommendations}
              disabled={refreshingRecs}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-text-secondary hover:bg-surface-overlay transition-colors disabled:opacity-40"
              title="Refresh AI-powered recommendations"
            >
              <RefreshCw size={12} className={refreshingRecs ? 'animate-spin' : ''} />
              Refresh
            </button>
            <button
              onClick={handleImportSkill}
              disabled={importingSkill}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-40 transition-colors"
            >
              <Download size={12} />
              {importingSkill ? 'Importing…' : 'Import Skill'}
            </button>
          </div>
        </div>

        {/* Recommended skills */}
        {recommendedSkills.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-1.5 mb-2">
              <Star size={12} className="text-warning" />
              <span className="text-[11px] font-semibold text-text-primary">
                Recommended for this project
              </span>
            </div>
            <div className="space-y-1">
              {recommendedSkills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  isAttached={attachedSkillIds.has(skill.id)}
                  isEnabled={specialist.skills?.find((s) => s.id === skill.id)?.isEnabled ?? false}
                  recommendation={{
                    relevance: skill.relevance,
                    rationale: skill.rationale
                  }}
                  onToggle={(enabled) => handleToggleSkill(skill.id, enabled)}
                  onAttach={() => handleAttachSkill(skill.id)}
                  onDetach={() => handleDetachSkill(skill.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Divider */}
        {recommendedSkills.length > 0 && otherSkills.length > 0 && (
          <div className="border-t border-border-subtle my-3" />
        )}

        {/* Other skills */}
        {otherSkills.length > 0 && (
          <div>
            <span className="text-[11px] font-semibold text-text-muted mb-2 block">
              Other skills
            </span>
            <div className="space-y-1">
              {otherSkills.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  isAttached={attachedSkillIds.has(skill.id)}
                  isEnabled={specialist.skills?.find((s) => s.id === skill.id)?.isEnabled ?? false}
                  onToggle={(enabled) => handleToggleSkill(skill.id, enabled)}
                  onAttach={() => handleAttachSkill(skill.id)}
                  onDetach={() => handleDetachSkill(skill.id)}
                />
              ))}
            </div>
          </div>
        )}

        {skills.length === 0 && (
          <p className="text-xs text-text-muted py-4 text-center">
            No skills available. Import a .md skill file to get started.
          </p>
        )}
      </SettingsCard>
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({
  status
}: {
  status: 'pending' | 'building' | 'ready' | 'failed'
}): React.JSX.Element {
  const config = {
    pending: { label: 'Pending', className: 'bg-surface-overlay text-text-muted' },
    building: { label: 'Building…', className: 'bg-info-muted text-info' },
    ready: { label: 'Ready', className: 'bg-success-muted text-success' },
    failed: { label: 'Failed', className: 'bg-danger-muted text-danger' }
  } as const

  const { label, className } = config[status]
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium ${className}`}
    >
      {status === 'building' && <Loader2 size={10} className="mr-1 animate-spin" />}
      {label}
    </span>
  )
}

function RebuildButton({
  state,
  onClick,
  progressMessage
}: {
  state: RebuildState
  onClick: () => void
  progressMessage?: string | null
}): React.JSX.Element {
  if (state === 'building') {
    return (
      <button
        disabled
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-overlay text-text-secondary cursor-not-allowed"
      >
        <Loader2 size={14} className="animate-spin" />
        <span className="max-w-[160px] truncate">{progressMessage ?? 'Rebuilding…'}</span>
      </button>
    )
  }

  if (state === 'success') {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-success-muted text-success animate-in fade-in">
        <CheckCircle size={14} />
        Ready
      </div>
    )
  }

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-white hover:bg-primary/90 transition-colors"
    >
      <Hammer size={14} />
      Rebuild
    </button>
  )
}

function SkillRow({
  skill,
  isAttached,
  isEnabled,
  recommendation,
  onToggle,
  onAttach,
  onDetach
}: {
  skill: Skill
  isAttached: boolean
  isEnabled: boolean
  recommendation?: { relevance: number; rationale: string }
  onToggle: (enabled: boolean) => void
  onAttach: () => void
  onDetach: () => void
}): React.JSX.Element {
  // Parse enrichment
  let enrichment: SkillEnrichment | null = null
  if (skill.enrichmentJson) {
    try {
      enrichment = JSON.parse(skill.enrichmentJson)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex items-start gap-2 p-2 rounded-lg hover:bg-surface-overlay/50 transition-colors group">
      {/* Icon + name */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {recommendation && <Star size={11} className="text-warning flex-shrink-0" />}
          <span className="text-xs font-medium text-text-primary truncate">{skill.name}</span>
          {recommendation && (
            <span className="text-[9px] font-medium text-primary bg-primary/10 px-1 py-0.5 rounded-full flex-shrink-0">
              {Math.round(recommendation.relevance * 100)}%
            </span>
          )}
        </div>

        {/* ApplicableTo from enrichment or rationale from recommendation */}
        {recommendation?.rationale ? (
          <p className="text-[10px] text-text-muted mt-0.5 line-clamp-1">
            {recommendation.rationale}
          </p>
        ) : enrichment?.applicableTo ? (
          <p className="text-[10px] text-text-muted mt-0.5 line-clamp-1">
            {enrichment.applicableTo}
          </p>
        ) : skill.description ? (
          <p className="text-[10px] text-text-muted mt-0.5 line-clamp-1">{skill.description}</p>
        ) : null}

        {/* Keywords */}
        {enrichment?.keywords && enrichment.keywords.length > 0 && !recommendation && (
          <div className="flex flex-wrap gap-1 mt-1">
            {enrichment.keywords.slice(0, 5).map((kw) => (
              <span
                key={kw}
                className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] text-text-muted bg-surface-overlay"
              >
                <Tag size={8} />
                {kw}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {isAttached ? (
          <>
            {/* Toggle enabled/disabled */}
            <button
              onClick={() => onToggle(!isEnabled)}
              title={isEnabled ? 'Disable skill' : 'Enable skill'}
              className="p-1 rounded hover:bg-surface-overlay transition-colors"
            >
              {isEnabled ? (
                <ToggleRight size={16} className="text-success" />
              ) : (
                <ToggleLeft size={16} className="text-text-muted" />
              )}
            </button>
            {/* Detach */}
            <button
              onClick={onDetach}
              title="Detach skill"
              className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-danger transition-colors opacity-0 group-hover:opacity-100"
            >
              <Minus size={14} />
            </button>
          </>
        ) : (
          <button
            onClick={onAttach}
            title="Attach skill"
            className="p-1 rounded hover:bg-surface-overlay text-text-muted hover:text-primary transition-colors"
          >
            <Plus size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
