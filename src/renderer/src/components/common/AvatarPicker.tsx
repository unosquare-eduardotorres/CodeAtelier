import { useCallback } from 'react'
import { AVATAR_LIBRARY } from './AvatarLibrary'
import Avatar from './Avatar'

interface AvatarPickerProps {
  value: string
  onChange: (key: string) => void
  columns?: number
  size?: 'sm' | 'md' | 'lg'
}

/**
 * Reusable avatar selection grid.
 * Used in WelcomeModal, SettingsPage, SpecialistForm, and CoreAgentSettings.
 *
 * UI/UX Pro Max compliance:
 * - Touch targets: 48px avatars with 12px gap (meets 44×44 minimum)
 * - Focus states: ring-2 on focus-visible
 * - Keyboard nav: Tab through grid, Enter/Space to select
 * - aria-label on each button
 * - Selected state: ring + scale(1.05)
 * - Hover: scale(1.08) with 150ms ease-out
 * - Reduced motion: respects prefers-reduced-motion via Tailwind
 */
export default function AvatarPicker({
  value,
  onChange,
  columns = 4,
  size = 'lg'
}: AvatarPickerProps): React.JSX.Element {
  const handleSelect = useCallback(
    (key: string) => {
      onChange(key)
    },
    [onChange]
  )

  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      role="radiogroup"
      aria-label="Choose an avatar"
    >
      {AVATAR_LIBRARY.map((avatar) => {
        const isSelected = value === avatar.key
        return (
          <button
            key={avatar.key}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={`Select ${avatar.label} avatar`}
            onClick={() => handleSelect(avatar.key)}
            className={`
              flex items-center justify-center p-1.5 rounded-xl
              transition-all duration-150 ease-out cursor-pointer
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base
              hover:scale-[1.08] active:scale-95
              motion-reduce:transition-none motion-reduce:hover:scale-100
              ${
                isSelected
                  ? 'ring-2 ring-primary ring-offset-2 ring-offset-surface-base scale-105 bg-primary/10'
                  : 'hover:bg-surface-overlay'
              }
            `}
          >
            <Avatar avatarKey={avatar.key} size={size} />
          </button>
        )
      })}
    </div>
  )
}
