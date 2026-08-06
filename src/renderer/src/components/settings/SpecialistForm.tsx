import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { useSpecialistStore, useWorkspaceStore } from '@renderer/store'
import { Avatar } from '@renderer/components/common'
import { getWorkspaceMannequin } from '@renderer/utils/workspaceMannequin'
import type { Specialist, Skill } from '../../../../shared/types'

interface SpecialistFormProps {
  specialist: Specialist | null
  skills: Skill[]
  onClose: () => void
}

export default function SpecialistForm({
  specialist,
  skills,
  onClose
}: SpecialistFormProps): React.JSX.Element {
  const { createSpecialist, updateSpecialist, assignSkill, removeSkill } = useSpecialistStore()

  const [displayName, setDisplayName] = useState(specialist?.displayName ?? '')
  const [agentId, setAgentId] = useState(specialist?.agentId ?? '')
  const [icon, setIcon] = useState(specialist?.icon ?? '🔧')
  const [color, setColor] = useState(specialist?.color ?? '#6366F1')
  const [prompt, setPrompt] = useState(specialist?.prompt ?? '')
  const [priority, setPriority] = useState(specialist?.priority ?? 100)
  const [alias, setAlias] = useState(specialist?.alias ?? '')
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    new Set(specialist?.skills?.map((s) => s.id) ?? [])
  )
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Avatars are no longer user-choosable per specialist — show the active
  // workspace's mannequin as a read-only preview.
  const activeWs = useWorkspaceStore((s) => s.activeWorkspace)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const mannequinKey = activeWs ? getWorkspaceMannequin(activeWs.id, workspaces) : 'mannequin-main'

  const isEditing = specialist !== null

  // Auto-generate agentId from displayName for new specialists
  useEffect(() => {
    if (!isEditing && displayName) {
      const slug = displayName
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim()
      // eslint-disable-next-line react-hooks/set-state-in-effect -- derive slug from display name
      setAgentId(slug)
    }
  }, [displayName, isEditing])

  const handleSkillToggle = (skillId: string): void => {
    setSelectedSkillIds((prev) => {
      const next = new Set(prev)
      if (next.has(skillId)) {
        next.delete(skillId)
      } else {
        next.add(skillId)
      }
      return next
    })
  }

  const handleSave = async (): Promise<void> => {
    if (!displayName.trim()) {
      setError('Display name is required')
      return
    }
    if (!agentId.trim()) {
      setError('Agent ID is required')
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      if (isEditing) {
        await updateSpecialist(specialist.id, {
          displayName: displayName.trim(),
          icon,
          color,
          prompt,
          priority,
          alias: alias.trim() || null
        })

        // Sync skills
        const currentSkillIds = new Set(specialist.skills?.map((s) => s.id) ?? [])
        for (const skillId of selectedSkillIds) {
          if (!currentSkillIds.has(skillId)) {
            await assignSkill(specialist.id, skillId)
          }
        }
        for (const skillId of currentSkillIds) {
          if (!selectedSkillIds.has(skillId)) {
            await removeSkill(specialist.id, skillId)
          }
        }
      } else {
        const created = await createSpecialist({
          agentId: agentId.trim(),
          displayName: displayName.trim(),
          icon,
          color,
          prompt,
          priority
        })

        // Assign any selected skills to the newly created specialist
        for (const skillId of selectedSkillIds) {
          await assignSkill(created.id, skillId)
        }
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div
        data-testid="specialist-form"
        className="relative bg-surface-overlay border border-border-subtle rounded shadow-2xl w-full max-w-lg mx-4 max-h-[85vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <h2 className="text-base font-semibold text-text-primary">
            {isEditing ? 'Edit Specialist' : 'Add Specialist'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-float text-text-secondary hover:text-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && (
            <div className="px-3 py-2 rounded-lg bg-danger-muted border border-danger/20 text-sm text-danger">
              {error}
            </div>
          )}

          {/* Display Name */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Display Name
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g., React Architect"
              className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
          </div>

          {/* Alias (optional personality name) */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Alias <span className="text-text-muted">(optional)</span>
            </label>
            <input
              type="text"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder='e.g., "Archie"'
              maxLength={50}
              className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
            <p className="text-[11px] text-text-muted mt-1">
              A personality name shown in chat. The role name will appear as a subtitle.
            </p>
          </div>

          {/* Avatar (read-only — one mannequin per workspace) */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Avatar</label>
            <Avatar avatarKey={mannequinKey} size="lg" accentColor={color} />
            <p className="text-xs text-text-muted mt-2">
              Specialist avatars are assigned automatically per workspace.
            </p>
          </div>

          {/* Agent ID */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Agent ID</label>
            <input
              type="text"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="e.g., react-architect"
              disabled={isEditing}
              className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          {/* Icon & Color */}
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Icon (emoji)
              </label>
              <input
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                maxLength={4}
                className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary text-center text-lg"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-text-secondary mb-1.5">Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-10 h-10 rounded-lg border border-border-subtle cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  placeholder="#6366F1"
                  className="flex-1 px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary font-mono focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                />
              </div>
            </div>
          </div>

          {/* Priority */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Priority (lower = higher priority)
            </label>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(parseInt(e.target.value, 10) || 100)}
              min={1}
              className="w-32 px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
            />
          </div>

          {/* Prompt */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Instructions for this specialist agent..."
              rows={4}
              className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary resize-y"
            />
          </div>

          {/* Skills assignment */}
          {skills.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Assigned Skills
              </label>
              <div className="space-y-1.5">
                {skills.map((skill) => (
                  <label
                    key={skill.id}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-surface-base border border-border-subtle cursor-pointer hover:border-border-default transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedSkillIds.has(skill.id)}
                      onChange={() => handleSkillToggle(skill.id)}
                      className="rounded border-border-default text-primary focus:ring-primary bg-surface-overlay"
                    />
                    <span className="text-sm text-text-body">{skill.name}</span>
                    {!skill.isActive && (
                      <span className="text-[10px] text-text-muted">(inactive)</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border-subtle">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-text-body hover:text-text-primary bg-surface-float hover:bg-surface-overlay rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Specialist'}
          </button>
        </div>
      </div>
    </div>
  )
}
