import { useState, useEffect } from 'react'
import { ArrowLeft, Save, Loader2, RefreshCw, Check, Shield } from 'lucide-react'
import { useSpecialistStore } from '@renderer/store'
import { Avatar, AvatarPicker, PixelSpriteAvatar } from '@renderer/components/common'
import { getDefaultAvatarForRole } from '@renderer/utils/agentIdentity'
import PixelSpritePicker from './PixelSpritePicker'
import CoreAgentPromptEditor from './CoreAgentPromptEditor'
import type { Specialist, MarketplaceSpecialist } from '../../../../shared/types'

/** Common fields between Specialist and MarketplaceSpecialist */
type EditableSpecialist = (Specialist | MarketplaceSpecialist) & {
  prompt?: string
  sourceYaml?: string | null
}

interface SpecialistEditPageProps {
  specialist: EditableSpecialist
  onBack: () => void
}

export default function SpecialistEditPage({
  specialist,
  onBack
}: SpecialistEditPageProps): React.JSX.Element {
  const { updateSpecialist } = useSpecialistStore()
  const { specialists } = useSpecialistStore()

  // Detect core agent and map to agentRole
  const isCore = 'isCore' in specialist ? specialist.isCore : false
  const isUserSpecialist = specialist.agentId === 'user'
  const coreAgentRole: 'generalist' | null =
    isCore && !isUserSpecialist ? 'generalist' : null

  // ── Form state ──
  const [displayName, setDisplayName] = useState(specialist.displayName)
  const [alias, setAlias] = useState(specialist.alias ?? '')
  const [color, setColor] = useState(specialist.color)
  const [prompt, setPrompt] = useState(specialist.prompt ?? '')
  const [avatarUrl, setAvatarUrl] = useState(
    specialist.avatarUrl ?? getDefaultAvatarForRole(specialist.agentId)
  )
  const [pixelSpriteId, setPixelSpriteId] = useState<string | null>(
    specialist.pixelSpriteId ?? null
  )
  const [usePixelForChat, setUsePixelForChat] = useState(
    (specialist as Specialist).usePixelForChat ?? false
  )
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Reset state when specialist changes
  useEffect(() => {
    setDisplayName(specialist.displayName)
    setAlias(specialist.alias ?? '')
    setColor(specialist.color)
    setPrompt(specialist.prompt ?? '')
    setAvatarUrl(specialist.avatarUrl ?? getDefaultAvatarForRole(specialist.agentId))
    setPixelSpriteId(specialist.pixelSpriteId ?? null)
    setUsePixelForChat((specialist as Specialist).usePixelForChat ?? false)
    setError(null)
    setSaved(false)
  }, [specialist])

  const handleSave = async (): Promise<void> => {
    if (!displayName.trim()) {
      setError('Display name is required')
      return
    }

    // Alias duplicate validation
    if (alias.trim()) {
      const duplicate = specialists.find(
        (s) => s.id !== specialist.id && s.alias?.toLowerCase() === alias.trim().toLowerCase()
      )
      if (duplicate) {
        setError(
          `Alias "${alias.trim()}" is already used by ${duplicate.displayName}. Please choose a unique alias.`
        )
        return
      }
    }

    setIsSaving(true)
    setError(null)
    setSaved(false)

    try {
      await updateSpecialist(specialist.id, {
        displayName: displayName.trim(),
        color,
        prompt,
        alias: alias.trim() || null,
        avatarUrl: avatarUrl || null,
        pixelSpriteId,
        usePixelForChat
      })

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
          <h1 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            {isCore && <Shield size={14} className="text-mode-plan-text" />}
            {isUserSpecialist
              ? 'Edit Your Profile'
              : isCore
                ? 'Edit Core Agent'
                : 'Edit Specialist'}
            : {specialist.displayName}
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
              {alias.trim() &&
                specialists.some(
                  (s) =>
                    s.id !== specialist.id &&
                    s.alias?.toLowerCase() === alias.trim().toLowerCase()
                ) && (
                  <p className="text-[11px] text-warning mt-1">
                    This alias is already used by{' '}
                    <strong>
                      {
                        specialists.find(
                          (s) =>
                            s.id !== specialist.id &&
                            s.alias?.toLowerCase() === alias.trim().toLowerCase()
                        )?.displayName
                      }
                    </strong>
                  </p>
                )}
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

            {/* Color */}
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Accent Color
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
              <p className="text-[11px] text-text-muted mt-1">
                Used for accent borders and name coloring in chat and status cards.
              </p>
            </div>
          </div>
        </section>

        {/* ── Chat Avatar Section ── */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
            Chat Avatar
          </h2>
          <p className="text-[11px] text-text-muted">
            Shown next to messages in the chat panel when this specialist responds.
          </p>
          <div className="flex items-center gap-3">
            {usePixelForChat && pixelSpriteId ? (
              <PixelSpriteAvatar spriteId={pixelSpriteId} size={48} className="rounded-lg" />
            ) : (
              <Avatar avatarKey={avatarUrl} size="lg" accentColor={color} />
            )}
            <button
              type="button"
              onClick={() => setShowAvatarPicker(!showAvatarPicker)}
              className="px-3 py-1.5 text-xs font-medium text-text-body hover:text-text-primary bg-surface-base border border-border-subtle hover:bg-surface-overlay rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={usePixelForChat}
            >
              {usePixelForChat ? 'Using Pixel Sprite' : showAvatarPicker ? 'Hide Avatars' : 'Change Avatar'}
            </button>
          </div>
          {/* Only show the avatar picker when NOT using pixel for chat */}
          {showAvatarPicker && !usePixelForChat && (
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
          <p className="text-[11px] text-text-muted">
            Character sprite shown in the virtual pixel office environment.
          </p>
          <PixelSpritePicker
            value={pixelSpriteId}
            onChange={setPixelSpriteId}
            specialists={specialists}
            currentSpecialistId={specialist.id}
          />
          {pixelSpriteId && (
            <button
              type="button"
              onClick={() => setUsePixelForChat(!usePixelForChat)}
              className={`
                inline-flex items-center gap-2 mt-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all
                ${usePixelForChat
                  ? 'bg-primary text-white'
                  : 'bg-surface-base text-text-secondary border border-border-subtle hover:bg-surface-overlay'
                }
              `}
            >
              {usePixelForChat && <Check size={12} />}
              Use as chat avatar
            </button>
          )}
        </section>

        {/* ── System Prompts Section (core agents) or Behavior Section (specialists) ── */}
        {/* User specialist has no AI prompt or system prompts — skip both sections */}
        {isUserSpecialist ? null : isCore && coreAgentRole ? (
          <section className="space-y-4">
            <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
              System Prompts
            </h2>
            <p className="text-[11px] text-text-muted">
              Edit the system prompts used by this core agent. Each mode has its own prompt.
              Changes take effect on the next conversation.
            </p>
            <CoreAgentPromptEditor agentRole={coreAgentRole} />
          </section>
        ) : (
          <section className="space-y-4">
            <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
              Behavior
            </h2>

            {/* Prompt */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-text-secondary">System Prompt</label>
                {specialist.sourceYaml && (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const yamlPath = `.claude/agents/${specialist.agentId}.yml`
                        const content = await window.api.readWorkspaceFile({ filePath: yamlPath })
                        const parts = content.split(/^---$/m)
                        const body = parts.length >= 3 ? parts.slice(2).join('---').trim() : ''
                        if (body) {
                          setPrompt(body)
                        } else {
                          setError('No system prompt body found in the YAML file')
                        }
                      } catch {
                        setError('Could not read YAML file — is a workspace open?')
                      }
                    }}
                    className="flex items-center gap-1 text-[11px] text-primary hover:text-primary-hover transition-colors"
                  >
                    <RefreshCw size={10} />
                    Reload from YAML
                  </button>
                )}
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={6}
                placeholder="System prompt for this specialist..."
                className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors resize-y font-mono"
              />
              <p className="text-[11px] text-text-muted mt-1">
                Sourced from{' '}
                <code className="text-[10px] font-mono bg-surface-base px-1 rounded">
                  .claude/agents/{specialist.agentId}.yml
                </code>
                . Edits here override the YAML content.
              </p>
            </div>
          </section>
        )}

        {/* ── Skills Section (read-only) ── */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">
            Skills
          </h2>
          <p className="text-[11px] text-text-muted">
            Skills assigned to this specialist. Managed through agent YAML configuration files.
          </p>
          {specialist.skills && specialist.skills.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {specialist.skills.map((skill) => (
                <div
                  key={skill.id}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-primary/5 border border-primary/30 text-text-primary"
                >
                  <div className="w-3.5 h-3.5 rounded bg-primary/20 flex items-center justify-center flex-shrink-0">
                    <Check size={10} className="text-primary" />
                  </div>
                  <span className="text-xs font-medium truncate">{skill.name}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-muted italic">No skills assigned</p>
          )}
        </section>

        {/* Bottom spacer */}
        <div className="h-8" />
      </div>
    </div>
  )
}
