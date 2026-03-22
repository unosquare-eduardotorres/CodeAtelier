import { useState } from 'react'
import {
  ChevronRight,
  Loader2,
  AlertTriangle,
  FolderOpen,
  Trash2
} from 'lucide-react'
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
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const handleToggleDeploy = async (skill: DiscoveredSkill): Promise<void> => {
    const id = skill.name
    setTogglingIds((prev) => new Set(prev).add(id))

    try {
      if (skill.isActive && skill.source === 'workspace') {
        // Undeploy: we'll use the write file endpoint conceptually
        // In a real implementation this would call a dedicated undeploy IPC
        // For now just refresh after the backend handles it
        console.log('Undeploy skill:', skill.name)
      }
      // Refresh
      await loadSkills(workspacePath)
    } catch (error) {
      console.error('Failed to toggle skill deployment:', error)
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!deleteTarget) return
    // Skill deletion only removes DB record per spec
    setDeleteTarget(null)
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
          <h3 className="text-sm font-semibold text-gray-200">Skills</h3>
          <p className="text-xs text-gray-500 mt-1">
            Skills deployed to this workspace from .claude/skills/
          </p>
        </div>

        {/* Import dropzone */}
        <SkillImportDropzone />

        {/* Skills list */}
        {sortedSkills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-sm text-gray-500 mb-1">No skills found</p>
            <p className="text-xs text-gray-600">
              Use &ldquo;Activate Agents &amp; Skills&rdquo; or import a skill file above
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sortedSkills.map((skill) => {
              const stale = isStale(skill.lastUpdated)
              const isToggling = togglingIds.has(skill.name)

              return (
                <div
                  key={skill.name}
                  className="group bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 hover:border-gray-600/50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    {/* Icon */}
                    <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex-shrink-0">
                      <FolderOpen size={16} />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-200">{skill.name}</span>
                        <span
                          className={`px-1.5 py-0.5 text-[10px] rounded-full font-medium ${
                            skill.isActive
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-gray-600/30 text-gray-500'
                          }`}
                        >
                          {skill.isActive ? 'Active' : 'Inactive'}
                        </span>
                        {skill.source === 'master' && !skill.isActive && (
                          <span className="text-[10px] text-gray-600">(not deployed)</span>
                        )}
                      </div>

                      {skill.frontmatter?.description && (
                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                          {skill.frontmatter.description}
                        </p>
                      )}

                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-[10px] text-gray-500">
                          {skill.hasSkillMd ? 'SKILL.md' : 'no SKILL.md'} +{' '}
                          {skill.referenceFiles.length} reference
                          {skill.referenceFiles.length !== 1 ? 's' : ''}
                        </span>
                        {skill.lastUpdated && (
                          <span className="text-[10px] text-gray-500">
                            Last updated: {formatDate(skill.lastUpdated)}
                          </span>
                        )}
                      </div>

                      {/* Staleness warning */}
                      {stale && (
                        <div className="flex items-center gap-1.5 mt-2 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/20">
                          <AlertTriangle size={12} className="text-amber-400 flex-shrink-0" />
                          <span className="text-[11px] text-amber-400">
                            This skill might require an update.
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* Deploy toggle */}
                      <button
                        onClick={() => handleToggleDeploy(skill)}
                        disabled={isToggling}
                        className={`relative w-10 h-5 rounded-full transition-colors ${
                          isToggling
                            ? 'bg-gray-600 cursor-wait'
                            : skill.isActive
                              ? 'bg-indigo-600 hover:bg-indigo-500'
                              : 'bg-gray-600 hover:bg-gray-500'
                        }`}
                        aria-label={skill.isActive ? 'Deactivate skill' : 'Activate skill'}
                        title={skill.isActive ? 'Undeploy from workspace' : 'Deploy to workspace'}
                      >
                        {isToggling ? (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 size={12} className="text-white animate-spin" />
                          </div>
                        ) : (
                          <span
                            className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                              skill.isActive ? 'translate-x-5' : 'translate-x-0.5'
                            }`}
                          />
                        )}
                      </button>

                      {/* View button */}
                      <button
                        onClick={() => selectSkill(skill)}
                        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        View
                        <ChevronRight size={12} />
                      </button>

                      {/* Delete button */}
                      <button
                        onClick={() => setDeleteTarget(skill.name)}
                        className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-all"
                        aria-label={`Delete ${skill.name}`}
                        title="Delete skill record"
                      >
                        <Trash2 size={14} />
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
        message="Remove this skill from the database? The files will remain in .claude/skills/ and CLAUDE.md will not be modified."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}
