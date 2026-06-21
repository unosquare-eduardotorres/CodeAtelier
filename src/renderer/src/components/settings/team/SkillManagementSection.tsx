/**
 * SkillManagementSection — skill tags strip, expand/collapse detail,
 * sync, delete, import. Extracted from TeamPage for decomposition.
 */

import { useState, forwardRef, useImperativeHandle } from 'react'
import {
  RefreshCw,
  Trash2,
  Loader2,
  ChevronRight,
  FolderOpen,
  AlertTriangle,
  X,
  Upload,
  Sparkles
} from 'lucide-react'
import { useSettingsStore } from '@renderer/store/settings.store'
import { ConfirmDialog } from '@renderer/components/common'
import SkillImportDropzone from '../SkillImportDropzone'
import type { DiscoveredSkill } from '../../../../../shared/types'
import { isStale, formatDate } from './useTeamPageData'

// ── Types ──

export interface SkillManagementSectionProps {
  workspacePath: string
  sortedSkills: DiscoveredSkill[]
  skills: DiscoveredSkill[]
  skillAgentMap: Map<string, { name: string; icon: string }[]>
  onAgentClick: (agentName: string) => void
}

export interface SkillManagementHandle {
  scrollToSkill: (skillName: string) => void
}

// ── Component ──

const SkillManagementSection = forwardRef<SkillManagementHandle, SkillManagementSectionProps>(
  function SkillManagementSection(
    { workspacePath, sortedSkills, skills, skillAgentMap, onAgentClick },
    ref
  ) {
    const { loadSkills, selectSkill } = useSettingsStore()

    // Skill interaction state
    const [expandedSkill, setExpandedSkill] = useState<string | null>(null)
    const [syncingSkillIds, setSyncingSkillIds] = useState<Set<string>>(new Set())
    const [deleteSkillTarget, setDeleteSkillTarget] = useState<DiscoveredSkill | null>(null)
    const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null)
    const [showImport, setShowImport] = useState(false)

    // ── Skill handlers ──

    const handleSyncSkill = async (skill: DiscoveredSkill): Promise<void> => {
      const id = skill.name
      setSyncingSkillIds((prev) => new Set(prev).add(id))
      try {
        await window.api.syncSkillToWorkspace({ workspacePath, skillName: skill.name })
        await loadSkills(workspacePath)
      } catch (error) {
        console.error('Failed to sync skill:', error)
      } finally {
        setSyncingSkillIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }

    const handleDeleteSkillConfirm = async (): Promise<void> => {
      if (!deleteSkillTarget) return
      setDeletingSkillId(deleteSkillTarget.name)
      try {
        await window.api.deleteSkillFromWorkspace({
          workspacePath,
          skillName: deleteSkillTarget.name
        })
        if (expandedSkill === deleteSkillTarget.name) {
          setExpandedSkill(null)
        }
        await loadSkills(workspacePath)
      } catch (error) {
        console.error('Failed to delete skill:', error)
      } finally {
        setDeleteSkillTarget(null)
        setDeletingSkillId(null)
      }
    }

    // Expose scrollToSkill to parent for cross-section navigation
    useImperativeHandle(
      ref,
      () => ({
        scrollToSkill: (skillName: string): void => {
          setExpandedSkill(skillName)
          setTimeout(() => {
            const el = document.getElementById(`skill-tag-${skillName}`)
            el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          }, 100)
        }
      }),
      []
    )

    return (
      <>
        <section data-testid="skill-management-section">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-mode-build-text" />
              <h3 className="text-sm font-semibold text-text-primary">
                Skills ({sortedSkills.length})
              </h3>
            </div>
            <button
              onClick={() => setShowImport(!showImport)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                showImport
                  ? 'bg-primary-muted text-primary-text'
                  : 'text-text-secondary border border-border-subtle hover:bg-surface-float'
              }`}
              aria-label={showImport ? 'Hide import area' : 'Import a skill'}
            >
              <Upload size={12} />
              Import Skill
            </button>
          </div>

          {/* Import dropzone — inline toggle */}
          {showImport && (
            <div className="mb-4">
              <SkillImportDropzone />
            </div>
          )}

          {/* Skill tags row */}
          {sortedSkills.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm text-text-secondary mb-1">No skills found</p>
              <p className="text-xs text-text-muted">
                Deploy the team or import a skill file to get started
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Compact tag strip */}
              <div className="flex flex-wrap gap-2">
                {sortedSkills.map((skill) => {
                  const stale = isStale(skill.lastUpdated)
                  const agentCount = skillAgentMap.get(skill.name)?.length ?? 0
                  const isExpanded = expandedSkill === skill.name

                  return (
                    <button
                      key={skill.name}
                      id={`skill-tag-${skill.name}`}
                      data-testid="skill-management-tag"
                      onClick={() => setExpandedSkill(isExpanded ? null : skill.name)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all min-h-[36px] ${
                        isExpanded
                          ? 'bg-primary-muted text-primary-text border border-primary/30 shadow-sm'
                          : 'bg-surface-overlay text-text-body border border-border-subtle hover:border-border-default hover:shadow-sm'
                      }`}
                      aria-label={`Skill: ${skill.name} (${agentCount} agent${agentCount !== 1 ? 's' : ''})`}
                      aria-expanded={isExpanded}
                    >
                      <FolderOpen
                        size={12}
                        className={isExpanded ? 'text-primary-text' : 'text-text-muted'}
                      />
                      <span>{skill.name}</span>
                      {agentCount > 0 && <span className="text-text-muted">({agentCount})</span>}
                      {stale && <AlertTriangle size={10} className="text-mode-build-text" />}
                      {!skill.isActive && (
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-surface-overlay"
                          title="Not deployed"
                        />
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Expanded skill detail */}
              {expandedSkill &&
                (() => {
                  const skill = skills.find((s) => s.name === expandedSkill)
                  if (!skill) return null
                  return (
                    <SkillDetailPanel
                      skill={skill}
                      skillAgentMap={skillAgentMap}
                      syncingSkillIds={syncingSkillIds}
                      deletingSkillId={deletingSkillId}
                      onSyncSkill={handleSyncSkill}
                      onSelectSkill={selectSkill}
                      onDeleteSkill={setDeleteSkillTarget}
                      onClose={() => setExpandedSkill(null)}
                      onAgentClick={onAgentClick}
                    />
                  )
                })()}
            </div>
          )}
        </section>

        {/* Delete skill confirmation */}
        <ConfirmDialog
          isOpen={deleteSkillTarget !== null}
          title="Delete Skill"
          message={`Remove "${deleteSkillTarget?.name ?? ''}" from this workspace? This will delete the skill directory from .claude/skills/ and remove references from CLAUDE.md.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          variant="danger"
          onConfirm={handleDeleteSkillConfirm}
          onCancel={() => setDeleteSkillTarget(null)}
        />
      </>
    )
  }
)

export default SkillManagementSection

// ── Skill Detail Panel Sub-component ──

interface SkillDetailPanelProps {
  skill: DiscoveredSkill
  skillAgentMap: Map<string, { name: string; icon: string }[]>
  syncingSkillIds: Set<string>
  deletingSkillId: string | null
  onSyncSkill: (skill: DiscoveredSkill) => void
  onSelectSkill: (skill: DiscoveredSkill) => void
  onDeleteSkill: (skill: DiscoveredSkill) => void
  onClose: () => void
  onAgentClick: (agentName: string) => void
}

function SkillDetailPanel({
  skill,
  skillAgentMap,
  syncingSkillIds,
  deletingSkillId,
  onSyncSkill,
  onSelectSkill,
  onDeleteSkill,
  onClose,
  onAgentClick
}: SkillDetailPanelProps): React.JSX.Element {
  const stale = isStale(skill.lastUpdated)
  const usedByAgents = skillAgentMap.get(skill.name) ?? []
  const isSyncing = syncingSkillIds.has(skill.name)
  const isDeleting = deletingSkillId === skill.name

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-5 space-y-3 animate-in fade-in duration-200">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-primary-muted text-primary-text flex-shrink-0 mt-0.5">
            <FolderOpen size={16} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-text-primary">{skill.name}</h4>
              <span
                className={`px-1.5 py-0.5 text-xs rounded-full font-medium ${
                  skill.isActive
                    ? 'bg-success-muted text-success'
                    : 'bg-surface-float text-text-muted'
                }`}
              >
                {skill.isActive ? 'Deployed' : 'Not deployed'}
              </span>
            </div>
            {skill.frontmatter?.description && (
              <p className="text-xs text-text-secondary mt-0.5">{skill.frontmatter.description}</p>
            )}
            <div className="flex items-center gap-3 mt-1.5">
              <span className="text-xs text-text-muted">
                {skill.hasSkillMd ? 'SKILL.md' : 'no SKILL.md'} + {skill.referenceFiles.length}{' '}
                reference
                {skill.referenceFiles.length !== 1 ? 's' : ''}
              </span>
              {skill.lastUpdated && (
                <span className="text-xs text-text-muted">
                  Updated: {formatDate(skill.lastUpdated)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => onSyncSkill(skill)}
            disabled={isSyncing}
            className="p-1.5 rounded-md hover:bg-primary-muted text-text-secondary hover:text-primary-text transition-colors disabled:opacity-50"
            aria-label={`Sync ${skill.name}`}
            title="Sync skill to workspace"
          >
            {isSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          <button
            onClick={() => onSelectSkill(skill)}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-surface-float transition-colors"
            aria-label={`View full details for ${skill.name}`}
          >
            View
            <ChevronRight size={12} />
          </button>
          <button
            onClick={() => onDeleteSkill(skill)}
            disabled={isDeleting}
            className="p-1.5 rounded-md hover:bg-danger-muted text-text-muted hover:text-danger transition-colors disabled:opacity-50"
            aria-label={`Delete ${skill.name}`}
            title="Delete skill from workspace"
          >
            {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-float text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close skill detail"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Staleness warning */}
      {stale && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-warning-muted border border-mode-build/20">
          <AlertTriangle size={12} className="text-mode-build-text flex-shrink-0" />
          <span className="text-xs text-mode-build-text">This skill might require an update.</span>
        </div>
      )}

      {/* Used by agents */}
      {usedByAgents.length > 0 && (
        <div>
          <label className="text-xs text-text-muted uppercase tracking-wider font-medium">
            Used by
          </label>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {usedByAgents.map((a) => (
              <button
                key={a.name}
                onClick={() => onAgentClick(a.name)}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-surface-float text-text-body hover:bg-surface-overlay hover:text-text-primary transition-colors cursor-pointer"
                aria-label={`Navigate to agent: ${a.name}`}
              >
                <span>{a.icon}</span>
                <span>{a.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {usedByAgents.length === 0 && (
        <p className="text-xs text-text-muted italic">No agents currently reference this skill</p>
      )}
    </div>
  )
}
