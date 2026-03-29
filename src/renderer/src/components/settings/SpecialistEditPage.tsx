import { useState, useEffect } from 'react'
import { ArrowLeft, Save, Loader2 } from 'lucide-react'
import { useSpecialistStore } from '@renderer/store'
import { Avatar, AvatarPicker } from '@renderer/components/common'
import { getDefaultAvatarForRole } from '@renderer/utils/agentIdentity'
import PixelSpritePicker from './PixelSpritePicker'
import type { Specialist, MarketplaceSpecialist, Skill } from '../../../../shared/types'

/** Common fields between Specialist and MarketplaceSpecialist */
type EditableSpecialist = (Specialist | MarketplaceSpecialist) & {
  prompt?: string
  sourceYaml?: string | null
}

interface SpecialistEditPageProps {
  specialist: EditableSpecialist
  skills: Skill[]
  onBack: () => void
}

export default function SpecialistEditPage({
  specialist,
  skills,
  onBack
}: SpecialistEditPageProps): React.JSX.Element {
  const { updateSpecialist, assignSkill, removeSkill } = useSpecialistStore()
  const { specialists } = useSpecialistStore()

  // ── Form state ──
  const [displayName, setDisplayName] = useState(specialist.displayName)
  const [alias, setAlias] = useState(specialist.alias ?? '')
  const [icon, setIcon] = useState(specialist.icon)
  const [color, setColor] = useState(specialist.color)
  const [prompt, setPrompt] = useState(specialist.prompt ?? '')
  const [priority, setPriority] = useState(specialist.priority)
  const [avatarUrl, setAvatarUrl] = useState(
    specialist.avatarUrl ?? getDefaultAvatarForRole(specialist.agentId)
  )
  const [pixelSpriteId, setPixelSpriteId] = useState<string | null>(
    specialist.pixelSpriteId ?? null
  )
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    new Set(specialist.skills?.map((s) => s.id) ?? [])
  )
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Reset state when specialist changes
  useEffect(() => {
    setDisplayName(specialist.displayName)
    setAlias(specialist.alias ?? '')
    setIcon(specialist.icon)
    setColor(specialist.color)
    setPrompt(specialist.prompt ?? '')
    setPriority(specialist.priority)
    setAvatarUrl(specialist.avatarUrl ?? getDefaultAvatarForRole(specialist.agentId))
    setPixelSpriteId(specialist.pixelSpriteId ?? null)
    setSelectedSkillIds(new Set(specialist.skills?.map((s) => s.id) ?? []))
    setError(null)
    setSaved(false)
  }, [specialist])

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

    setIsSaving(true)
    setError(null)
    setSaved(false)

    try {
      await updateSpecialist(specialist.id, {
        displayName: displayName.trim(),
        icon,
        color,
        prompt,
        priority,
        alias: alias.trim() || null,
        avatarUrl: avatarUrl || null,
        pixelSpriteId
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

      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border-subtle bg-surface-overlay/50">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors"
        >
          <ArrowLeft size={14} />
          Back to Team
        </button>
        <div className="flex-1">
          <h1 className="text-sm font-semibold text-text-primary">
            Edit Specialist: {specialist.displayName}
          </h1>
          <p className="text-xs text-text-muted">{specialist.agentId}</p>
        </div>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="text-xs text-success font-medium">Saved!</span>
          )}
          <button
            onClick={handleSave}
            disabled={isSaving || !displayName.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium
              bg-primary text-white hover:bg-primary-hover
              disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isSaving ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Save size={12} />
            )}
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {error && (
          <div className="px-4 py-3 rounded-lg bg-danger-muted border border-danger/20 text-sm text-danger">
            {error}
          </div>
        )}

        {/* ── Identity Section ── */}
        <section className="space-y-4">
          <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
            Identity
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors"
              />
            </div>

            {/* Alias */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Alias <span className="text-text-muted">(optional)</span>
              </label>
              <input
                type="text"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder='e.g., "Da Vinci"'
                maxLength={50}
                className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors"
              />
              <p className="text-[11px] text-text-muted mt-1">
                Personality name shown in chat. Role name appears as subtitle.
              </p>
            </div>

            {/* Agent ID (locked) */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Agent ID
              </label>
              <input
                type="text"
                value={specialist.agentId}
                disabled
                className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-muted font-mono cursor-not-allowed opacity-60"
              />
            </div>

            {/* Icon & Color */}
            <div className="flex gap-3">
              <div className="w-20">
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  Icon
                </label>
                <input
                  type="text"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  maxLength={4}
                  className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary text-center text-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  Color
                </label>
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
                    className="flex-1 px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors"
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Chat Avatar Section ── */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
            Chat Avatar
          </h2>
          <div className="flex items-center gap-3">
            <Avatar avatarKey={avatarUrl} size="lg" accentColor={color} />
            <button
              type="button"
              onClick={() => setShowAvatarPicker(!showAvatarPicker)}
              className="px-3 py-1.5 text-xs font-medium text-text-body hover:text-text-primary bg-surface-base border border-border-subtle hover:bg-surface-overlay rounded-lg transition-colors"
            >
              {showAvatarPicker ? 'Hide Avatars' : 'Change Avatar'}
            </button>
          </div>
          {showAvatarPicker && (
            <div className="mt-2">
              <AvatarPicker value={avatarUrl} onChange={setAvatarUrl} columns={8} size="md" />
            </div>
          )}
        </section>

        {/* ── Pixel Office Avatar Section ── */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
            Pixel Office Avatar
          </h2>
          <PixelSpritePicker
            value={pixelSpriteId}
            onChange={setPixelSpriteId}
            specialists={specialists}
            currentSpecialistId={specialist.id}
          />
        </section>

        {/* ── Behavior Section ── */}
        <section className="space-y-4">
          <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
            Behavior
          </h2>

          {/* Priority */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Priority <span className="text-text-muted">(lower = higher priority)</span>
            </label>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(parseInt(e.target.value, 10) || 100)}
              min={1}
              className="w-32 px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors"
            />
          </div>

          {/* Prompt */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              System Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              placeholder="System prompt for this specialist..."
              className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors resize-y font-mono"
            />
          </div>
        </section>

        {/* ── Skills Section ── */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
            Skills
          </h2>
          {skills.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {skills.map((skill) => {
                const isAssigned = selectedSkillIds.has(skill.id)
                return (
                  <label
                    key={skill.id}
                    className={`
                      flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-colors
                      border
                      ${isAssigned
                        ? 'bg-primary/5 border-primary/30 text-text-primary'
                        : 'bg-surface-base border-border-subtle text-text-secondary hover:bg-surface-overlay'
                      }
                    `}
                  >
                    <input
                      type="checkbox"
                      checked={isAssigned}
                      onChange={() => handleSkillToggle(skill.id)}
                      className="w-3.5 h-3.5 rounded border-border-subtle text-primary focus:ring-primary/50 cursor-pointer"
                    />
                    <span className="text-xs font-medium truncate">{skill.name}</span>
                  </label>
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-text-muted italic">No skills available</p>
          )}
        </section>

        {/* Bottom spacer */}
        <div className="h-8" />
      </div>
    </div>
  )
}
