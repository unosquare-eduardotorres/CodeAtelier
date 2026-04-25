import { AVATAR_IMAGES, type AvatarKey } from '@renderer/assets/avatars'
import { rendererLog } from '@renderer/utils/logger'

interface AvatarProps {
  avatarKey: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  accentColor?: string
}

// Sizes bumped across the board. xl (chat bubble) grows from 54 → 80.
const SIZE_MAP = {
  sm: 32,
  md: 48,
  lg: 64,
  xl: 80
} as const

/**
 * Renders a bundled portrait image by key. No SVG, no initials fallback.
 * If the key is unknown (should never happen via our resolution chain),
 * renders a neutral placeholder circle and logs a warning.
 */
export default function Avatar({
  avatarKey,
  size = 'md',
  className = '',
  accentColor
}: AvatarProps): React.JSX.Element {
  const px = SIZE_MAP[size]
  const src = AVATAR_IMAGES[avatarKey as AvatarKey]

  const baseStyle: React.CSSProperties = {
    width: px,
    height: px,
    minWidth: px,
    minHeight: px,
    ...(accentColor ? { outline: `2px solid ${accentColor}`, outlineOffset: 2 } : {})
  }

  if (!src) {
    rendererLog.warn(`Avatar: unknown key "${avatarKey}"`)
    return (
      <div
        className={`inline-block rounded-full bg-surface-overlay ${className}`}
        style={baseStyle}
        aria-hidden="true"
      />
    )
  }

  return (
    <img
      src={src}
      width={px}
      height={px}
      className={`inline-block rounded-full object-cover transition-all duration-150 ${className}`}
      style={baseStyle}
      alt=""
      aria-hidden="true"
    />
  )
}
