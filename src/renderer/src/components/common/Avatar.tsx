import { useState, useCallback, useEffect } from 'react'
import { useAppTheme, useUserAvatarVariant } from '@renderer/store'
import { getAvatarImage, resolveUserAvatarKey, type AvatarKey } from '@renderer/assets/avatars'
import { rendererLog } from '@renderer/utils/logger'
import type { AppTheme } from '../../../../shared/types'

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

// ── Theme tint overlays — subtle color wash for non-native themes ──
const THEME_TINT: Record<AppTheme, string | null> = {
  'code-atelier': null,
  developer: null,
  glass: 'rgba(124,140,247,0.12)',
  porcelain: 'rgba(71,85,105,0.08)'
}

/**
 * Renders a bundled portrait image by key, themed to the active theme.
 * Falls back to Code Atelier if the key or theme is unknown.
 * If the image is a placeholder (naturalWidth ≤ 4), renders an initials
 * circle instead. This benefits chat/grill/blueprint equally.
 *
 * When avatarKey is 'user', resolves to the user's chosen variant
 * (user-1/2/3) from app preferences. Specific variant keys like
 * 'user-1' bypass resolution (used by the avatar picker).
 */
export default function Avatar({
  avatarKey,
  size = 'md',
  className = '',
  accentColor
}: AvatarProps): React.JSX.Element {
  const theme = useAppTheme()
  const userAvatarVariant = useUserAvatarVariant()
  const px = SIZE_MAP[size]

  // Resolve 'user' role key → specific variant image key
  const resolvedKey = avatarKey === 'user' ? resolveUserAvatarKey(userAvatarVariant) : avatarKey

  const src = getAvatarImage(resolvedKey as AvatarKey, theme)
  const [isPlaceholder, setIsPlaceholder] = useState(false)

  // Reset placeholder detection when the avatar source changes
  useEffect(() => {
    setIsPlaceholder(false)
  }, [resolvedKey, theme])

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    // Detect 68-byte placeholder PNGs — they decode to tiny dimensions
    if (e.currentTarget.naturalWidth <= 4) {
      setIsPlaceholder(true)
    }
  }, [])

  // Render initials circle for unknown keys or detected placeholders
  if (!src || isPlaceholder) {
    if (!src) {
      rendererLog.warn(`Avatar: unknown key "${avatarKey}"`)
    }
    const colorClass = getInitialsColor(avatarKey)
    const sizeClass = INITIALS_SIZE_MAP[size]
    const initialsStyle: React.CSSProperties = {
      width: px,
      height: px,
      ...(accentColor ? { outline: `2px solid ${accentColor}`, outlineOffset: 2 } : {})
    }
    return (
      <div
        className="relative inline-flex"
        style={{ width: px, height: px, minWidth: px, minHeight: px }}
      >
        <div
          className={`inline-flex items-center justify-center rounded-full ${colorClass} ${className}`}
          style={initialsStyle}
          aria-hidden="true"
        >
          <span className={`${sizeClass} font-semibold text-white select-none`}>
            {getInitials(avatarKey)}
          </span>
        </div>
      </div>
    )
  }

  const tint = THEME_TINT[theme]
  const isUserVariant = resolvedKey.startsWith('user-')

  const wrapperStyle: React.CSSProperties = {
    width: px,
    height: px,
    minWidth: px,
    minHeight: px
  }

  const imgStyle: React.CSSProperties = {
    width: px,
    height: px,
    ...(accentColor ? { outline: `2px solid ${accentColor}`, outlineOffset: 2 } : {})
  }

  return (
    <div className="relative inline-flex" style={wrapperStyle}>
      <img
        src={src}
        width={px}
        height={px}
        className={`inline-block rounded-full object-cover transition-opacity duration-150 ${className}`}
        style={imgStyle}
        alt=""
        aria-hidden="true"
        onLoad={handleLoad}
      />
      {tint && !isPlaceholder && isUserVariant && (
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{ backgroundColor: tint, mixBlendMode: 'color' }}
        />
      )}
    </div>
  )
}
