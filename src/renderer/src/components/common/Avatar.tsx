import { useState, useCallback } from 'react'
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

// ── Accent colors for initials circles (deterministic by first char) ──

const INITIALS_COLORS = [
  'bg-blue-600',
  'bg-emerald-600',
  'bg-violet-600',
  'bg-cyan-600',
  'bg-rose-600',
  'bg-indigo-600',
  'bg-teal-600',
  'bg-purple-600'
] as const

function getInitialsColor(key: string): string {
  const code = (key.charCodeAt(0) || 0) % INITIALS_COLORS.length
  return INITIALS_COLORS[code]
}

function getInitials(key: string): string {
  // Use first letter of the key (e.g. "da-vinci" → "D", "user" → "U")
  const cleaned = key.replace(/[-_]/g, ' ')
  return cleaned.charAt(0).toUpperCase()
}

// ── Font size for initials ──

const INITIALS_SIZE_MAP = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
  xl: 'text-lg',
  xxl: 'text-3xl'
} as const

/**
 * Renders a bundled portrait image by key, themed to the active theme.
 * Falls back to Code Atelier if the key or theme is unknown.
 * If the image is a placeholder (naturalWidth ≤ 4), renders an initials
 * circle instead. This benefits chat/grill/blueprint equally.
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
  const [isPlaceholder, setIsPlaceholder] = useState(false)

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    // Detect 68-byte placeholder PNGs — they decode to tiny dimensions
    if (e.currentTarget.naturalWidth <= 4) {
      setIsPlaceholder(true)
    }
  }, [])

  const baseStyle: React.CSSProperties = {
    width: px,
    height: px,
    minWidth: px,
    minHeight: px,
    ...(accentColor ? { outline: `2px solid ${accentColor}`, outlineOffset: 2 } : {})
  }

  // Render initials circle for unknown keys or detected placeholders
  if (!src || isPlaceholder) {
    if (!src) {
      rendererLog.warn(`Avatar: unknown key "${avatarKey}"`)
    }
    const colorClass = getInitialsColor(avatarKey)
    const sizeClass = INITIALS_SIZE_MAP[size]
    return (
      <div
        className={`inline-flex items-center justify-center rounded-full ${colorClass} ${className}`}
        style={baseStyle}
        aria-hidden="true"
      >
        <span className={`${sizeClass} font-semibold text-white select-none`}>
          {getInitials(avatarKey)}
        </span>
      </div>
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
      onLoad={handleLoad}
    />
  )
}
