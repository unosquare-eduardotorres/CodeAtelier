import { useAppTheme } from '@renderer/store'
import { getAvatarImage, type AvatarKey } from '@renderer/assets/avatars'
import { rendererLog } from '@renderer/utils/logger'

interface AvatarProps {
  avatarKey: string
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'xxl'
  className?: string
  accentColor?: string
}

// Sizes bumped across the board. xl (chat bubble) grows from 54 → 80.
// xxl (120px) is used for the specialist hero banner.
const SIZE_MAP = {
  sm: 32,
  md: 48,
  lg: 64,
  xl: 80,
  xxl: 120
} as const

/**
 * Renders a bundled portrait image by key, themed to the active theme.
 * Falls back to Code Atelier if the key or theme is unknown.
 * If the key is unknown (should never happen via our resolution chain),
 * renders a neutral placeholder circle and logs a warning.
 */
export default function Avatar({
  avatarKey,
  size = 'md',
  className = '',
  accentColor
}: AvatarProps): React.JSX.Element {
  const theme = useAppTheme()
  const px = SIZE_MAP[size]
  const src = getAvatarImage(avatarKey as AvatarKey, theme)

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
