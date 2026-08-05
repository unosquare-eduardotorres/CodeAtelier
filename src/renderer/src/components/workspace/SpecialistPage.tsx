/**
 * SpecialistPage — Presentation page for the per-workspace Project Specialist.
 *
 * Layout: Hero Banner → Detected Stack → Skill Market (cards grid) → System Prompt (rendered MD + edit modal)
 */

import { useState, useEffect, useCallback } from 'react'
import { Bot } from 'lucide-react'
import { useWorkspaceStore, useSkillStore, useToastStore } from '@renderer/store'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'
import { TechBadge } from '@renderer/components/specialist'
import { getWorkspaceMannequin } from '@renderer/utils/workspaceMannequin'
import { useSpecialistSkillData } from './specialist/useSpecialistSkillData'
import { SpecialistHeroBanner } from './specialist/SpecialistHeroBanner'
import { SkillMarketSection } from './specialist/SkillMarketSection'
import { SystemPromptSection } from './specialist/SystemPromptSection'

// ── Types ────────────────────────────────────────────────────────────────────

type RebuildState = 'idle' | 'building' | 'success' | 'failed'

// ── Hooks ─────────────────────────────────────────────────────────────────

/** Track rebuild lifecycle from build-progress events. */
function useRebuildState(
  buildProgress: { phase: string; message?: string } | null | undefined
): {
  rebuildState: RebuildState
  rebuildError: string | null
  setRebuildState: (s: RebuildState) => void
  setRebuildError: (e: string | null) => void
} {
  const [rebuildState, setRebuildState] = useState<RebuildState>('idle')
  const [rebuildError, setRebuildError] = useState<string | null>(null)

  useEffect(() => {
    if (!buildProgress) return undefined
    if (buildProgress.phase === 'started') {
      setRebuildState('building')
      setRebuildError(null)
    } else if (buildProgress.phase === 'ready') {
      setRebuildState('success')
      const timer = setTimeout(() => setRebuildState('idle'), 2500)
      return () => clearTimeout(timer)
    } else if (buildProgress.phase === 'failed') {
      setRebuildState('failed')
      setRebuildError(buildProgress.message ?? null)
    }
    return undefined
  }, [buildProgress])

  return { rebuildState, rebuildError, setRebuildState, setRebuildError }
}

/** Manage skill import/toggle/attach/detach/recommend actions. */
function useSkillActions(opts: {
  specialist: { id: string } | null
  workspaceId: string | null
  toggleSkill: (sid: string, skillId: string, enabled: boolean) => Promise<void>
  attachSkill: (sid: string, skillId: string) => Promise<void>
  detachSkill: (sid: string, skillId: string) => Promise<void>
  refreshRecommendations: (sid: string) => Promise<void>
  importSkill: (filePath: string) => Promise<{ success: boolean; error?: string | null }>
  loadForWorkspace: (workspaceId: string) => Promise<void>
  addToast: (t: Omit<import('@renderer/store/toast.store').Toast, 'id' | 'createdAt'>) => void
}): {
  handleImportSkill: () => Promise<void>
  handleToggleSkill: (skillId: string, enabled: boolean) => Promise<void>
  handleAttachSkill: (skillId: string) => Promise<void>
  handleDetachSkill: (skillId: string) => Promise<void>
  handleRefreshRecommendations: () => Promise<void>
  importingSkill: boolean
  refreshingRecs: boolean
} {
  const {
    specialist, workspaceId, toggleSkill, attachSkill, detachSkill,
    refreshRecommendations, importSkill, loadForWorkspace, addToast
  } = opts
  const [isImporting, setIsImporting] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const handleImportSkill = useCallback(async () => {
    setIsImporting(true)
    try {
      const filePath = await window.api.selectSkillFile()
      if (!filePath) {
        setIsImporting(false)
        return
      }
      const result = await importSkill(filePath)
      if (result.success) {
        addToast({ message: 'Skill imported successfully', type: 'success' })
        if (workspaceId) await loadForWorkspace(workspaceId)
      } else {
        addToast({ message: result.error ?? 'Import failed', type: 'error' })
      }
    } catch (err) {
      addToast({ message: (err as Error).message, type: 'error' })
    } finally {
      setIsImporting(false)
    }
  }, [importSkill, workspaceId, loadForWorkspace, addToast])

  const handleRefreshRecommendations = useCallback(async () => {
    if (!specialist) return
    setIsRefreshing(true)
    try {
      await refreshRecommendations(specialist.id)
      addToast({ message: 'Recommendations refreshed', type: 'success' })
    } catch {
      addToast({ message: 'Failed to refresh recommendations', type: 'error' })
    } finally {
      setIsRefreshing(false)
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

  return {
    handleImportSkill,
    handleToggleSkill,
    handleAttachSkill,
    handleDetachSkill,
    handleRefreshRecommendations,
    importingSkill: isImporting,
    refreshingRecs: isRefreshing
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SpecialistPage(): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const workspaces = useWorkspaceStore((s) => s.workspaces)
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

  const [editedPrompt, setEditedPrompt] = useState<string>('')
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [promptModalOpen, setPromptModalOpen] = useState(false)

  const { rebuildState, rebuildError, setRebuildState, setRebuildError } =
    useRebuildState(buildProgress)
  const {
    handleImportSkill,
    handleToggleSkill,
    handleAttachSkill,
    handleDetachSkill,
    handleRefreshRecommendations,
    importingSkill,
    refreshingRecs
  } = useSkillActions({
    specialist,
    workspaceId,
    toggleSkill,
    attachSkill,
    detachSkill,
    refreshRecommendations,
    importSkill,
    loadForWorkspace,
    addToast
  })

  // ── Effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (workspaceId) void loadForWorkspace(workspaceId)
  }, [workspaceId, loadForWorkspace])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  // Sync local prompt when specialist prompt changes
  useEffect(() => {
    if (specialist?.prompt !== undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from external store update
      setEditedPrompt(specialist.prompt)
    }
  }, [specialist?.prompt])

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

  const handleSavePrompt = useCallback(
    async (newPrompt: string) => {
      if (!specialist) return
      setSavingPrompt(true)
      try {
        await updatePrompt(specialist.id, newPrompt)
        setPromptModalOpen(false)
        addToast({ message: 'Prompt saved', type: 'success' })
      } catch {
        addToast({ message: 'Failed to save prompt', type: 'error' })
      } finally {
        setSavingPrompt(false)
      }
    },
    [specialist, updatePrompt, addToast]
  )

  // ── Derived data ─────────────────────────────────────────────────────────

  const { attachedSkillIds, recommendedSkills, otherSkills } = useSpecialistSkillData({
    skills,
    specialistSkills: specialist?.skills,
    skillRecommendations: specialist?.skillRecommendations ?? undefined
  })

  const mannequinKey = getWorkspaceMannequin(activeWorkspace?.id ?? '', workspaces)

  const handleGoToIngestion = useCallback(() => {
    window.dispatchEvent(new CustomEvent('navigate-to-memory'))
  }, [])

  // ── No specialist state ──────────────────────────────────────────────────

  if (!specialist) {
    return (
      <div data-testid="specialist-page" className="flex-1 flex flex-col items-center justify-center p-12 text-center">
        <div className="w-16 h-16 rounded-2xl bg-surface-overlay border border-border-subtle flex items-center justify-center mb-4">
          <Bot size={28} className="text-text-muted" />
        </div>
        <h3 className="text-sm font-semibold text-text-primary mb-1">No Specialist Yet</h3>
        <p className="text-xs text-text-secondary max-w-xs">
          No specialist configured for this workspace. Open a chat to get started — the build wizard
          will guide you.
        </p>
      </div>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div data-testid="specialist-page" className="p-6 space-y-8 max-w-5xl mx-auto">
      <SpecialistHeroBanner
        displayName={specialist.displayName}
        buildStatus={specialist.buildStatus}
        lastBuiltAt={specialist.lastBuiltAt}
        buildMethod={specialist.buildMethod}
        ingestion={specialist.ingestion}
        color={specialist.color}
        mannequinKey={mannequinKey}
        rebuildState={rebuildState}
        rebuildError={rebuildError}
        progressMessage={buildProgress?.message}
        storeError={storeError}
        onRebuild={handleRebuild}
        onClearError={clearError}
        onGoToIngestion={handleGoToIngestion}
      />

      {/* ── Detected Stack ──────────────────────────────────────────── */}
      {/* Rendered unconditionally: silently hiding the section made "detected
          nothing" indistinguishable from "this section doesn't exist". */}
      <section data-testid="specialist-detected-stack">
        <h4 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-3">
          Detected Stack
        </h4>
        {specialist.detectedTechs.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {specialist.detectedTechs.map((tech) => (
              <TechBadge key={tech} tech={tech} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-text-secondary">
            No stack detected — run Deep Ingestion, then rebuild.
          </p>
        )}
      </section>

      <SkillMarketSection
        recommendedSkills={recommendedSkills}
        otherSkills={otherSkills}
        attachedSkillIds={attachedSkillIds}
        specialistSkills={specialist.skills}
        refreshingRecs={refreshingRecs}
        importingSkill={importingSkill}
        totalSkillCount={skills.length}
        onRefreshRecommendations={handleRefreshRecommendations}
        onImportSkill={handleImportSkill}
        onToggleSkill={handleToggleSkill}
        onAttachSkill={handleAttachSkill}
        onDetachSkill={handleDetachSkill}
      />

      <SystemPromptSection
        prompt={specialist.prompt}
        editedPrompt={editedPrompt}
        rebuildState={rebuildState}
        promptModalOpen={promptModalOpen}
        savingPrompt={savingPrompt}
        onOpenModal={() => setPromptModalOpen(true)}
        onCloseModal={() => setPromptModalOpen(false)}
        onRebuildPrompt={handleRebuildPrompt}
        onSavePrompt={handleSavePrompt}
      />
    </div>
  )
}
