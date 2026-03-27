import { useState } from 'react'
import { ChevronRight, Loader2, AlertTriangle, FolderOpen, Trash2, RefreshCw } from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import { ConfirmDialog } from '@renderer/components/common'
import SkillImportDropzone from './SkillImportDropzone'
import type { DiscoveredSkill } from '../../../../shared/types'

function isStale(lastUpdated: string | null): boolean {
  if (!lastUpdated) return false
  const date = new Date(lastUpdated)
  const sixMonthsAgo = new Date()
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
  return date < sixMonthsAgo
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Unknown'
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  } catch {
    return dateStr
  }
}

interface SkillsListProps {
  workspacePath: string
}

export default function SkillsList({ workspacePath }: SkillsListProps): React.JSX.Element {
  const { skills, selectSkill, loadSkills } = useSettingsStore()
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<DiscoveredSkill | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const handleSync = async (skill: DiscoveredSkill): Promise<void> => {
    const id = skill.name
    setSyncingIds((prev) => new Set(prev).add(id))

    try {
      await window.api.syncSkillToWorkspace({
        workspacePath,
        skillName: skill.name
      })
      await loadSkills(workspacePath)
    } catch (error) {
      console.error('Failed to sync skill:', error)
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!deleteTarget) return
    setDeletingId(deleteTarget.name)

    try {
      await window.api.deleteSkillFromWorkspace({
        workspacePath,
        skillName: deleteTarget.name
      })
      await loadSkills(workspacePath)
    } catch (error) {
      console.error('Failed to delete skill:', error)
    } finally {
      setDeleteTarget(null)
      setDeletingId(null)
    }
  }

  // Sort: active/workspace first, then by name
  const sortedSkills = [...skills].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      <div className="space-y-4">
        {/* Section header */}
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Skills</h3>
          <p className="text-xs text-text-secondary mt-1">
            Skills deployed to this workspace from .claude/skills/
          </p>
        </div>

        {/* Import dropzone */}
        <SkillImportDropzone />

        {/* Skills list */}
        {sortedSkills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-sm text-text-secondary mb-1">No skills found</p>
            <p className="text-xs text-text-muted">
              Use &ldquo;Activate Agents &amp; Skills&rdquo; or import a skill file above
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sortedSkills.map((skill) => {
              const stale = isStale(skill.lastUpdated)
              const isSyncing = syncingIds.has(skill.name)
              const isDeleting = deletingId === skill.name

              return (
                <div
                  key={skill.name}
                  className="bg-surface-overlay border border-border-subtle rounded-xl p-4 hover:border-border-default transition-colors shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    {/* Icon */}
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary-muted text-primary-text flex-shrink-0">
                      <FolderOpen size={16} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{skill.name}</span>
                        <span
                          className={`px-1.5 py-0.5 text-xs rounded-full font-medium ${
                            skill.isActive
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-surface-float text-text-muted'
                          }`}
                        >
                          {skill.isActive ? 'Deployed' : 'Not deployed'}
                        </span>
                      </div>

                      {skill.frontmatter?.description && (
                        <p className="text-xs text-text-secondary mt-0.5 line-clamp-1">
                          {skill.frontmatter.description}
                        </p>
                      )}

                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-xs text-text-muted">
                          {skill.hasSkillMd ? 'SKILL.md' : 'no SKILL.md'} +{' '}
                          {skill.referenceFiles.length} reference
                          {skill.referenceFiles.length !== 1 ? 's' : ''}
                        </span>
                        {skill.lastUpdated && (
                          <span className="text-xs text-text-muted">
                            Last updated: {formatDate(skill.lastUpdated)}
                          </span>
                        )}
                      </div>

                      {/* Staleness warning */}
                      {stale && (
                        <div className="flex items-center gap-1.5 mt-2 px-2 py-1 rounded-md bg-warning-muted border border-amber-500/20">
                          <AlertTriangle size={12} className="text-amber-400 flex-shrink-0" />
                          <span className="text-xs text-amber-400">
                            This skill might require an update.
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Actions — always visible */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {/* Sync button */}
                      <button
                        onClick={() => handleSync(skill)}
                        disabled={isSyncing}
                        className="p-1.5 rounded-md hover:bg-primary-muted text-text-secondary hover:text-primary-text transition-colors disabled:opacity-50 disabled:cursor-wait"
                        aria-label={`Sync ${skill.name}`}
                        title="Sync skill to workspace & CLAUDE.md"
                      >
                        {isSyncing ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                      </button>

                      {/* View button */}
                      <button
                        onClick={() => selectSkill(skill)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface-float transition-colors"
                      >
                        View
                        <ChevronRight size={12} />
                      </button>

                      {/* Delete button */}
                      <button
                        onClick={() => setDeleteTarget(skill)}
                        disabled={isDeleting}
                        className="p-1.5 rounded-md hover:bg-danger-muted text-text-muted hover:text-red-400 transition-colors disabled:opacity-50"
                        aria-label={`Delete ${skill.name}`}
                        title="Delete skill from workspace & CLAUDE.md"
                      >
                        {isDeleting ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete Skill"
        message={`Remove "${deleteTarget?.name ?? ''}" from this workspace? This will delete the skill directory from .claude/skills/ and remove references from CLAUDE.md.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}
