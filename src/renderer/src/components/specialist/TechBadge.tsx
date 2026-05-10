import { useState } from 'react'
import { Code2, TestTube2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { getDeviconUrl } from '@renderer/utils/techIcons'

interface TechBadgeProps {
  tech: string
}

/**
 * Lucide fallback icons for tech names that have no devicon equivalent.
 * Prevents misleading icons (e.g. showing Jest logo for generic "testing").
 */
const LUCIDE_FALLBACK: Record<string, LucideIcon> = {
  testing: TestTube2
}

/**
 * A card-style badge that shows a large devicon SVG icon + tech name.
 * Uses a vertical layout (icon on top, label below) for visual prominence.
 * Falls back to a Lucide icon from LUCIDE_FALLBACK, or a generic Code2 icon
 * for completely unrecognized techs or when the CDN image fails to load.
 */
export default function TechBadge({ tech }: TechBadgeProps): React.JSX.Element {
  const iconUrl = getDeviconUrl(tech)
  const [imgFailed, setImgFailed] = useState(false)

  const showImg = iconUrl && !imgFailed
  const FallbackIcon = LUCIDE_FALLBACK[tech.toLowerCase()] ?? Code2

  return (
    <span
      className="inline-flex flex-col items-center justify-center gap-1.5
        px-4 py-3 rounded-xl
        bg-surface-overlay border border-border-subtle
        text-xs font-medium text-text-body
        hover:border-border-default hover:bg-surface-float transition-colors
        min-w-[72px]"
    >
      {showImg ? (
        <img
          src={iconUrl}
          alt=""
          width={28}
          height={28}
          className="flex-shrink-0"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <FallbackIcon size={24} className="text-text-muted flex-shrink-0" />
      )}
      <span className="text-[11px]">{tech}</span>
    </span>
  )
}
