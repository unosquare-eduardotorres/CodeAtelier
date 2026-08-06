import { useState, useCallback, useRef, useEffect } from 'react'
import { User, Check } from 'lucide-react'
import Avatar from '../common/Avatar'
import {
  useUserAvatarVariant,
  useAppPreferenceActions,
  useChatBubbleSize,
  useProfileStore,
  useChatAvatarSize
} from '@renderer/store'
import { USER_AVATAR_OPTIONS } from '@renderer/assets/avatars'
import type { UserAvatarVariant } from '../../../../shared/types'

const SIZE_PREVIEW = [
  { size: 'sm' as const, px: 32, label: '32px' },
  { size: 'md' as const, px: 48, label: '48px' },
  { size: 'lg' as const, px: 64, label: '64px' },
  { size: 'xl' as const, px: 80, label: '80px' },
  { size: 'xxl' as const, px: 120, label: '120px' }
]

const BUBBLE_TO_AVATAR: Record<string, string> = {
  small: 'md',
  medium: 'lg',
  large: 'xl',
  xl: 'xl'
}

export default function ProfileSection(): React.JSX.Element {
  const currentVariant = useUserAvatarVariant()
  const currentBubbleSize = useChatBubbleSize()
  const chatAvatarSize = useChatAvatarSize()
  const { setPreference } = useAppPreferenceActions()
  const profile = useProfileStore((s) => s.profile)
  const saveProfile = useProfileStore((s) => s.saveProfile)

  const displayName = profile?.displayName ?? ''
  const [editName, setEditName] = useState(displayName)
  const [isSaving, setIsSaving] = useState(false)
  const nameChanged = editName.trim() !== displayName

  // Sync editName when profile loads/changes externally
  const prevNameRef = useRef(displayName)
  useEffect(() => {
    if (prevNameRef.current !== displayName) {
      setEditName(displayName)
      prevNameRef.current = displayName
    }
  }, [displayName])

  const handleSaveName = useCallback(async () => {
    if (!nameChanged || !editName.trim()) return
    setIsSaving(true)
    try {
      await saveProfile(editName.trim(), 'user')
    } catch {
      // profile store logs the error
    } finally {
      setIsSaving(false)
    }
  }, [editName, nameChanged, saveProfile])

  return (
    <div className="bg-surface-overlay border border-border-subtle rounded p-4 shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <User size={14} className="text-primary-text" />
        <h4 className="text-sm font-medium text-text-primary">Profile</h4>
      </div>
      <p className="text-xs text-text-secondary mb-4">
        Personalize how you appear in conversations.
      </p>

      {/* Avatar selector */}
      <p className="text-xs font-medium text-text-secondary mb-2">Your Avatar</p>
      <div className="grid grid-cols-3 gap-3">
        {USER_AVATAR_OPTIONS.map((opt) => (
          <button
            key={opt.variant}
            aria-label={`Select ${opt.label} avatar`}
            onClick={() =>
              void setPreference('userAvatarVariant', opt.variant).catch(console.error)
            }
            className={`relative flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
              currentVariant === opt.variant
                ? 'border-primary bg-primary-muted'
                : 'border-border-subtle hover:border-border-default hover:bg-surface-base'
            }`}
          >
            {currentVariant === opt.variant && (
              <div className="absolute top-2 right-2">
                <Check size={14} className="text-primary-text" />
              </div>
            )}
            <Avatar avatarKey={`user-${opt.variant}` as `user-${UserAvatarVariant}`} size="lg" />
            <span className="text-xs font-medium text-text-primary">{opt.label}</span>
            <span className="text-[10px] text-text-muted text-center leading-tight">
              {opt.description}
            </span>
          </button>
        ))}
      </div>

      {/* Size preview gallery */}
      <div className="mt-5">
        <p className="text-xs font-medium text-text-secondary mb-3">Size Preview</p>
        <div className="flex items-end gap-4 px-2">
          {SIZE_PREVIEW.map(({ size, label }) => {
            const isActive = BUBBLE_TO_AVATAR[currentBubbleSize] === size

            return (
              <div key={size} className="flex flex-col items-center gap-1.5">
                <Avatar avatarKey="user" size={size} />
                <span
                  className={`text-[10px] ${
                    isActive ? 'text-primary-text font-semibold' : 'text-text-muted'
                  }`}
                >
                  {label}
                </span>
                <span
                  className={`text-[9px] ${isActive ? 'text-primary-text' : 'text-text-muted'}`}
                >
                  {size}
                </span>
              </div>
            )
          })}
        </div>
        <p className="text-[10px] text-text-muted mt-2">
          Your current bubble size ({currentBubbleSize}) uses the highlighted size.
        </p>
      </div>

      {/* Live chat bubble preview */}
      <div
        className="mt-5 bg-surface-base rounded-xl p-4 border border-border-subtle"
        aria-live="polite"
      >
        <p className="text-[11px] text-text-muted mb-3 uppercase tracking-wider font-medium">
          Live Preview
        </p>
        <div className="flex items-start gap-3 flex-row-reverse">
          <Avatar avatarKey="user" size={chatAvatarSize} />
          <div className="flex flex-col items-end">
            <span className="text-xs text-text-secondary mb-1 px-1">
              {editName.trim() || 'You'}
            </span>
            <div className="rounded-2xl px-4 py-2.5 bg-primary/90 text-white text-sm">
              Hey team, let&apos;s build something amazing!
            </div>
          </div>
        </div>
      </div>

      {/* Display name editor */}
      <div className="mt-5">
        <label className="block text-xs font-medium text-text-secondary mb-1.5">Display Name</label>
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          maxLength={50}
          className="w-full px-3 py-2 rounded-lg bg-surface-base border border-border-subtle
                     text-sm text-text-primary placeholder-text-muted
                     focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <p className="text-xs text-text-muted mt-1.5">Appears in chat messages and workspaces.</p>
        <button
          onClick={() => void handleSaveName()}
          disabled={isSaving || !nameChanged}
          className="mt-3 px-4 py-2 rounded-lg text-xs font-medium
                     bg-primary hover:bg-primary-hover text-white
                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isSaving ? 'Saving...' : 'Save Name'}
        </button>
      </div>
    </div>
  )
}
