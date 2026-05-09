/**
 * SpecialistPage — Presentation page for the per-workspace Project Specialist.
 *
 * Layout: Hero Banner → Detected Stack → Skill Market (cards grid) → System Prompt (rendered MD + edit modal)
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import {
  Bot,
  RefreshCw,
  Download,
  Star,
  XCircle,
  Loader2,
  Hammer,
  Pencil,
  CheckCircle
} from 'lucide-react'
import { useWorkspaceStore, useSkillStore, useToastStore } from '@renderer/store'
import { useProjectSpecialistStore } from '@renderer/store/project-specialist.store'
import { Avatar } from '@renderer/components/common'
import { TechBadge, SkillCard, PromptPreviewModal } from '@renderer/components/specialist'
import { getWorkspaceMannequin } from '@renderer/utils/workspaceMannequin'
import type { Skill } from '../../../../shared/types'

// ── Types ────────────────────────────────────────────────────────────────────

type RebuildState = 'idle' | 'building' | 'success' | 'failed'

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

  const [rebuildState, setRebuildState] = useState<RebuildState>('idle')
  const [rebuildError, setRebuildError] = useState<string | null>(null)
  const [editedPrompt, setEditedPrompt] = useState<string>('')
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [promptModalOpen, setPromptModalOpen] = useState(false)
  const [refreshingRecs, setRefreshingRecs] = useState(false)
  const [importingSkill, setImportingSkill] = useState(false)

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

  // Track rebuild state from build progress events
  useEffect(() => {
    if (!buildProgress) return undefined
    if (buildProgress.phase === 'started') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from event stream
      setRebuildState('building')
      setRebuildError(null)
    } else if (buildProgress.phase === 'ready') {
      setRebuildState('success')
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

  const mannequinKey = getWorkspaceMannequin(activeWorkspace?.id ?? '', workspaces)

  // ── No specialist state ──────────────────────────────────────────────────

  if (!specialist) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
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
    <div className="p-6 space-y-8 max-w-5xl mx-auto">
      {/* ── Hero Banner ──────────────────────────────────────────────── */}
      <div className="relative rounded-2xl overflow-hidden bg-surface-overlay border border-border-subtle">
        {/* Radial gradient background — brand gold accent */}
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(ellipse at 30% 50%,
              rgba(184,151,106,0.08) 0%,
              rgba(30,46,51,0.4) 40%,
              transparent 70%)`
          }}
        />

        <div className="relative flex items-center gap-6 p-8">
          {/* Large avatar — rounded rectangle */}
          <div className="flex-shrink-0">
            <Avatar
              avatarKey={mannequinKey}
              size="xxl"
              className="!rounded-2xl"
              accentColor={specialist.color ?? '#B8976A'}
            />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-text-primary mb-1">
              {specialist.displayName}
            </h2>
            <div className="flex items-center gap-2 mb-3">
              <StatusBadge status={specialist.buildStatus} />
              {specialist.lastBuiltAt && (
                <span className="text-[11px] text-text-muted">
                  Built {new Date(specialist.lastBuiltAt).toLocaleDateString()}
                </span>
              )}
            </div>
            <p className="text-xs text-text-secondary">
              Tailored specialist for this workspace
            </p>
          </div>

          {/* Rebuild button — top right area */}
          <div className="flex-shrink-0 self-start">
            <RebuildButton
              state={rebuildState}
              onClick={handleRebuild}
              progressMessage={buildProgress?.message}
            />
          </div>
        </div>
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
        <section>
          <h4 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-3">
            Detected Stack
          </h4>
          <div className="flex flex-wrap gap-2">
            {specialist.detectedTechs.map((tech) => (
              <TechBadge key={tech} tech={tech} />
            ))}
          </div>
        </section>
      )}

      {/* ── Skill Market ─────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
            Skill Market
          </h4>
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
                  isEnabled={
                    specialist.skills?.find((s) => s.id === skill.id)?.isEnabled ?? false
                  }
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
                  isEnabled={
                    specialist.skills?.find((s) => s.id === skill.id)?.isEnabled ?? false
                  }
                  onToggle={(enabled) => handleToggleSkill(skill.id, enabled)}
                  onAttach={() => handleAttachSkill(skill.id)}
                  onDetach={() => handleDetachSkill(skill.id)}
                />
              ))}
            </div>
          </div>
        )}

        {skills.length === 0 && (
          <p className="text-xs text-text-muted py-8 text-center">
            No skills available. Import a .md skill file to get started.
          </p>
        )}
      </section>

      {/* ── System Prompt ────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">
            System Prompt
          </h4>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-text-muted">
              {editedPrompt.length.toLocaleString()} chars
            </span>
            <button
              onClick={() => setPromptModalOpen(true)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-text-secondary hover:bg-surface-overlay transition-colors"
              title="Edit raw prompt"
            >
              <Pencil size={12} />
              Edit
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

        {/* Rendered markdown preview */}
        <div className="bg-surface-overlay border border-border-subtle rounded-xl p-6 max-h-[70vh] overflow-y-auto">
          <div
            className="prose prose-sm max-w-none [&]:max-w-none
              prose-headings:text-text-primary prose-headings:font-semibold
              prose-p:text-text-body prose-strong:text-text-primary
              prose-code:text-code-text prose-code:bg-surface-base prose-code:px-1 prose-code:rounded
              prose-ul:text-text-body prose-li:text-text-body
              prose-a:text-accent"
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
              {specialist.prompt || '*No prompt generated yet. Click Rebuild to generate.*'}
            </ReactMarkdown>
          </div>
        </div>
      </section>

      {/* Edit Prompt Modal */}
      <PromptPreviewModal
        open={promptModalOpen}
        prompt={editedPrompt}
        onSave={handleSavePrompt}
        onClose={() => setPromptModalOpen(false)}
        isSaving={savingPrompt}
      />
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
      {status === 'ready' && <span className="mr-1 w-1.5 h-1.5 rounded-full bg-success inline-block" />}
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
