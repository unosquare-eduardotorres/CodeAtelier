import { useMemo } from 'react'
import { AVATAR_MAP } from './AvatarLibrary'

interface AvatarProps {
  avatarKey: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  fallbackInitials?: string
  className?: string
  accentColor?: string
}

const SIZE_MAP = {
  sm: 24,
  md: 36,
  lg: 48,
  xl: 54
} as const

/**
 * Renders a built-in SVG avatar from the avatar library.
 * Falls back to initials in a colored circle if the key isn't found.
 *
 * Multi-color rendering: Injects CSS custom properties (--av-bg, --av-skin,
 * --av-hair, --av-clothing, --av-accessory, --av-eyes) from the avatar's
 * palette so each character has distinct, vibrant colors.
 *
 * Follows UI/UX Pro Max guidelines:
 * - Touch targets ≥ 44px when interactive (handled by parent)
 * - Smooth transitions on avatar changes
 * - Accessible with aria-hidden (decorative image)
 */
export default function Avatar({
  avatarKey,
  size = 'md',
  fallbackInitials,
  className = '',
  accentColor
}: AvatarProps): React.JSX.Element {
  const px = SIZE_MAP[size]
  const definition = AVATAR_MAP[avatarKey]

  const initials = useMemo(() => {
    if (fallbackInitials) {
      return fallbackInitials
        .split(' ')
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    }
    return avatarKey.charAt(0).toUpperCase()
  }, [fallbackInitials, avatarKey])

  const colorStyle = accentColor ? { color: accentColor } : undefined

  if (!definition) {
    // Fallback: initials in a colored circle
    return (
      <div
        className={`inline-flex items-center justify-center rounded-full bg-surface-overlay transition-all duration-150 ${className}`}
        style={{
          width: px,
          height: px,
          minWidth: px,
          minHeight: px,
          ...colorStyle
        }}
        aria-hidden="true"
      >
        <span
          className="font-semibold text-text-primary select-none"
          style={{ fontSize: px * 0.38 }}
        >
          {initials}
        </span>
      </div>
    )
  }

  // Build CSS variables from palette for multi-color rendering
  const palette = definition.palette
  const style: React.CSSProperties = {
    minWidth: px,
    minHeight: px,
    // Legacy: keep color for any remaining currentColor references
    color: accentColor ?? definition.defaultColor,
    // Palette variables consumed by SVG content
    '--av-bg': definition.bgColor,
    '--av-skin': palette.skin,
    '--av-hair': palette.hair,
    '--av-clothing': palette.clothing,
    '--av-accessory': palette.accessory,
    '--av-eyes': palette.eyes
  } as React.CSSProperties

  return (
    <svg
      viewBox="0 0 48 48"
      width={px}
      height={px}
      className={`inline-block rounded-full transition-all duration-150 ${className}`}
      style={style}
      aria-hidden="true"
      role="img"
      dangerouslySetInnerHTML={{ __html: definition.svgContent }}
    />
  )
}
