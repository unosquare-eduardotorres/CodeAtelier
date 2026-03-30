import { useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft,
  Settings,
  RefreshCw,
  Download,
  CheckCircle2,
  Pencil,
  Check,
  GripVertical,
  ChevronUp,
  ChevronDown,
  Loader2
} from 'lucide-react'
import { useUpdateStore, useProfileStore, useSpecialistStore } from '@renderer/store'
import { Avatar, AvatarPicker, PixelSpriteAvatar } from '@renderer/components/common'
import { getDefaultAvatarForRole } from '@renderer/utils/agentIdentity'
import type { Specialist } from '../../../../shared/types'
import AISubscriptionsSection from './AISubscriptionsSection'

function UpdateButton(): React.JSX.Element {
  const { status, availableVersion, checkForUpdates, installUpdate } = useUpdateStore()

  if (status === 'ready') {
    return (
      <button
        onClick={installUpdate}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-success border border-success/30 hover:bg-success-muted transition-colors"
      >
        <CheckCircle2 size={12} />
        Install Update (v{availableVersion})
      </button>
    )
  }

  if (status === 'available') {
    return (
      <button
        onClick={() => useUpdateStore.getState().downloadUpdate()}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-primary-text border border-primary/30 hover:bg-primary-muted transition-colors"
      >
        <Download size={12} />
        Download v{availableVersion}
      </button>
    )
  }

  return (
    <button
      onClick={checkForUpdates}
      disabled={status === 'checking' || status === 'downloading'}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary border border-border-subtle hover:bg-surface-overlay hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <RefreshCw size={12} className={status === 'checking' ? 'animate-spin' : ''} />
      {status === 'checking'
        ? 'Checking...'
        : status === 'downloading'
          ? 'Downloading...'
          : 'Check for Updates'}
    </button>
  )
}

interface SettingsPageProps {
  onBack: () => void
}

function ProfileSection(): React.JSX.Element {
  const { profile, saveProfile } = useProfileStore()
  const [isEditing, setIsEditing] = useState(false)
  const [name, setName] = useState(profile?.displayName ?? '')
  const [avatarKey, setAvatarKey] = useState(profile?.avatarKey ?? 'renaissance-scholar')
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (profile) {
      setName(profile.displayName)
      setAvatarKey(profile.avatarKey)
    }
  }, [profile])

  const handleSave = useCallback(async () => {
    if (!name.trim()) return
    setIsSaving(true)
    try {
      await saveProfile(name.trim(), avatarKey)
      setIsEditing(false)
      setShowAvatarPicker(false)
    } catch (err) {
      console.error('Failed to save profile:', err)
    } finally {
      setIsSaving(false)
    }
  }, [name, avatarKey, saveProfile])

  const handleCancel = useCallback(() => {
    setName(profile?.displayName ?? '')
    setAvatarKey(profile?.avatarKey ?? 'renaissance-scholar')
    setIsEditing(false)
    setShowAvatarPicker(false)
  }, [profile])

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <h4 className="text-sm font-medium text-text-primary">Your Profile</h4>
      <p className="text-xs text-text-secondary mt-0.5 mb-4">
        Your name and avatar appear in all conversations
      </p>
      <div className="flex items-center gap-4">
        <button
          onClick={() => {
            setIsEditing(true)
            setShowAvatarPicker(true)
          }}
          className="relative group cursor-pointer"
          aria-label="Change avatar"
        >
          <Avatar avatarKey={avatarKey} size="lg" />
          <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <Pencil size={14} className="text-white" />
          </div>
        </button>
        <div className="flex-1">
          {isEditing ? (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              maxLength={50}
              className="w-full h-10 px-3 rounded-lg bg-surface-base border border-border-subtle text-sm text-text-primary placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSave()
                if (e.key === 'Escape') handleCancel()
              }}
            />
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary">
                {profile?.displayName ?? 'Developer'}
              </span>
              <button
                onClick={() => setIsEditing(true)}
                className="p-1 rounded-md hover:bg-surface-float text-text-muted hover:text-text-primary transition-colors"
                aria-label="Edit name"
              >
                <Pencil size={12} />
              </button>
            </div>
          )}
        </div>
        {isEditing && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 text-xs font-medium text-text-body hover:text-text-primary bg-surface-float hover:bg-surface-overlay rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!name.trim() || isSaving}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors disabled:opacity-50"
            >
              <Check size={12} />
              Save
            </button>
          </div>
        )}
      </div>

      {/* Avatar picker overlay */}
      {showAvatarPicker && (
        <div className="mt-4 pt-4 border-t border-border-subtle">
          <p className="text-xs text-text-secondary mb-3">Choose an avatar</p>
          <AvatarPicker value={avatarKey} onChange={setAvatarKey} columns={8} size="lg" />
        </div>
      )}
    </div>
  )
}

function SpecialistOrder(): React.JSX.Element {
  const { specialists, reorderSpecialists } = useSpecialistStore()
  const [orderedList, setOrderedList] = useState<Specialist[]>([])
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // Initialize from active specialists sorted by priority
  useEffect(() => {
    const active = [...specialists]
      .filter((s) => s.isActive)
      .sort((a, b) => a.priority - b.priority)
    setOrderedList(active)
  }, [specialists])

  const handleDragStart = (index: number): void => {
    setDraggedIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number): void => {
    e.preventDefault()
    if (draggedIndex === null || draggedIndex === index) return
    const updated = [...orderedList]
    const [moved] = updated.splice(draggedIndex, 1)
    updated.splice(index, 0, moved)
    setOrderedList(updated)
    setDraggedIndex(index)
  }

  const handleDragEnd = async (): Promise<void> => {
    setDraggedIndex(null)
    setIsSaving(true)
    try {
      await reorderSpecialists(orderedList.map((s) => s.id))
    } finally {
      setIsSaving(false)
    }
  }

  const moveItem = useCallback(
    async (from: number, to: number) => {
      const updated = [...orderedList]
      const [moved] = updated.splice(from, 1)
      updated.splice(to, 0, moved)
      setOrderedList(updated)
      setIsSaving(true)
      try {
        await reorderSpecialists(updated.map((s) => s.id))
      } finally {
        setIsSaving(false)
      }
    },
    [orderedList, reorderSpecialists]
  )

  if (orderedList.length === 0) return <></>

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      <h4 className="text-sm font-medium text-text-primary">Specialist Priority Order</h4>
      <p className="text-xs text-text-secondary mt-0.5 mb-4">
        Drag to reorder. Specialists listed first are presented first to the generalist when
        decomposing tasks into sub-tasks.
      </p>
      <div className="space-y-1">
        {orderedList.map((specialist, index) => (
          <div
            key={specialist.id}
            draggable
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDragEnd={handleDragEnd}
            className={`
              flex items-center gap-3 px-3 py-2 rounded-lg border transition-all cursor-grab active:cursor-grabbing
              ${
                draggedIndex === index
                  ? 'border-primary/50 bg-primary/5 scale-[1.02] shadow-md'
                  : 'border-border-subtle bg-surface-base hover:bg-surface-overlay'
              }
            `}
          >
            <GripVertical size={14} className="text-text-muted flex-shrink-0" />
            <span className="text-xs text-text-muted w-5 font-mono">{index + 1}</span>
            {specialist.usePixelForChat && specialist.pixelSpriteId ? (
              <PixelSpriteAvatar spriteId={specialist.pixelSpriteId} size={24} />
            ) : (
              <Avatar
                avatarKey={
                  specialist.avatarUrl ?? getDefaultAvatarForRole(specialist.agentId)
                }
                size="sm"
                accentColor={specialist.color}
              />
            )}
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-text-primary">
                {specialist.displayName}
              </span>
              {specialist.alias && (
                <span className="text-xs text-text-muted ml-1.5">({specialist.alias})</span>
              )}
            </div>
            {/* Up/Down buttons for accessibility */}
            <div className="flex flex-col gap-0.5">
              <button
                disabled={index === 0}
                onClick={() => moveItem(index, index - 1)}
                className="p-0.5 rounded hover:bg-surface-float disabled:opacity-20"
              >
                <ChevronUp size={12} />
              </button>
              <button
                disabled={index === orderedList.length - 1}
                onClick={() => moveItem(index, index + 1)}
                className="p-0.5 rounded hover:bg-surface-float disabled:opacity-20"
              >
                <ChevronDown size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {isSaving && (
        <p className="text-[11px] text-text-muted mt-2 flex items-center gap-1">
          <Loader2 size={10} className="animate-spin" /> Saving order...
        </p>
      )}
    </div>
  )
}

export default function SettingsPage({ onBack }: SettingsPageProps): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col bg-surface-raised min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border-subtle bg-surface-raised">
        <button
          onClick={onBack}
          className="p-1.5 rounded-md hover:bg-surface-overlay text-text-secondary hover:text-text-primary transition-colors"
          aria-label="Back to chat"
          title="Back to chat"
        >
          <ArrowLeft size={16} />
        </button>
        <Settings size={16} className="text-primary-text" />
        <span className="text-sm font-semibold text-text-primary">App Settings</span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <div className="space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-text-primary mb-2">Application</h3>
              <p className="text-xs text-text-secondary">
                App-level settings and updates. Agents and skills are managed per workspace in
                Workspace Settings.
              </p>
            </div>

            {/* Profile section */}
            <ProfileSection />

            {/* AI Subscriptions section */}
            <AISubscriptionsSection />

            {/* Specialist Priority Order */}
            <SpecialistOrder />

            {/* Update section */}
            <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-medium text-text-primary">Updates</h4>
                  <p className="text-xs text-text-secondary mt-0.5">
                    Check for and install application updates
                  </p>
                </div>
                <UpdateButton />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
