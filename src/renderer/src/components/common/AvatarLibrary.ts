/**
 * Built-in avatar library: 16 SVG avatar definitions rendered as inline SVG paths.
 * Each avatar has a unique key, label, category, and a default accent color.
 *
 * The SVG strings are designed as 48×48 viewBox with a consistent circular style.
 */

export interface AvatarDefinition {
  key: string
  label: string
  category: 'space' | 'creative' | 'tech' | 'nature' | 'classic'
  defaultColor: string
  /** Inline SVG markup (without the outer <svg> tag — just the inner paths/groups) */
  svgContent: string
}

/**
 * All built-in avatars. The SVG content uses a 48×48 viewBox.
 * Each avatar is a stylized icon that works well at 24–48px.
 */
export const AVATAR_LIBRARY: AvatarDefinition[] = [
  // ── Space ──
  {
    key: 'astronaut',
    label: 'Astronaut',
    category: 'space',
    defaultColor: '#6366F1',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="18" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
      <rect x="18" y="14" width="12" height="10" rx="3" fill="currentColor" opacity="0.3"/>
      <circle cx="22" cy="18" r="1.5" fill="currentColor"/>
      <circle cx="26" cy="18" r="1.5" fill="currentColor"/>
      <path d="M16 30 C16 26 20 24 24 24 C28 24 32 26 32 30 L32 36 C32 38 30 40 28 40 L20 40 C18 40 16 38 16 36Z" fill="currentColor" opacity="0.4"/>
      <rect x="20" y="30" width="8" height="4" rx="1" fill="currentColor" opacity="0.6"/>`
  },
  {
    key: 'alien',
    label: 'Alien',
    category: 'space',
    defaultColor: '#10B981',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <ellipse cx="24" cy="20" rx="12" ry="14" fill="currentColor" opacity="0.3"/>
      <ellipse cx="18" cy="18" rx="4" ry="5" fill="currentColor" opacity="0.5"/>
      <ellipse cx="30" cy="18" rx="4" ry="5" fill="currentColor" opacity="0.5"/>
      <circle cx="18" cy="18" r="2" fill="currentColor"/>
      <circle cx="30" cy="18" r="2" fill="currentColor"/>
      <path d="M20 28 Q24 32 28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`
  },
  {
    key: 'rocket-pilot',
    label: 'Rocket Pilot',
    category: 'space',
    defaultColor: '#F97316',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <path d="M24 8 L28 20 L32 32 L24 28 L16 32 L20 20 Z" fill="currentColor" opacity="0.4"/>
      <circle cx="24" cy="20" r="4" fill="currentColor" opacity="0.6"/>
      <path d="M14 34 L18 30" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M34 34 L30 30" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <circle cx="24" cy="20" r="2" fill="currentColor"/>`
  },
  // ── Creative ──
  {
    key: 'artist',
    label: 'Artist',
    category: 'creative',
    defaultColor: '#EC4899',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <ellipse cx="24" cy="30" rx="12" ry="8" fill="currentColor" opacity="0.25"/>
      <circle cx="16" cy="28" r="2.5" fill="currentColor" opacity="0.6"/>
      <circle cx="22" cy="25" r="2.5" fill="currentColor" opacity="0.5"/>
      <circle cx="28" cy="28" r="2.5" fill="currentColor" opacity="0.7"/>
      <circle cx="32" cy="32" r="2.5" fill="currentColor" opacity="0.4"/>
      <path d="M30 10 L32 24" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <circle cx="30" cy="10" r="3" fill="currentColor" opacity="0.5"/>
      <circle cx="24" cy="16" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/>`
  },
  {
    key: 'musician',
    label: 'Musician',
    category: 'creative',
    defaultColor: '#8B5CF6',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="18" cy="34" r="5" fill="currentColor" opacity="0.4"/>
      <circle cx="30" cy="30" r="5" fill="currentColor" opacity="0.4"/>
      <path d="M23 34 L23 12" stroke="currentColor" stroke-width="2"/>
      <path d="M35 30 L35 10" stroke="currentColor" stroke-width="2"/>
      <path d="M23 12 L35 10" stroke="currentColor" stroke-width="2"/>
      <rect x="23" y="10" width="12" height="4" rx="1" fill="currentColor" opacity="0.3"/>`
  },
  {
    key: 'writer',
    label: 'Writer',
    category: 'creative',
    defaultColor: '#D97706',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <rect x="14" y="12" width="20" height="26" rx="2" fill="currentColor" opacity="0.25"/>
      <line x1="18" y1="18" x2="30" y2="18" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
      <line x1="18" y1="22" x2="28" y2="22" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
      <line x1="18" y1="26" x2="26" y2="26" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
      <line x1="18" y1="30" x2="24" y2="30" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
      <path d="M30 8 L36 14 L34 16 L28 10 Z" fill="currentColor" opacity="0.6"/>`
  },
  // ── Tech ──
  {
    key: 'hacker',
    label: 'Hacker',
    category: 'tech',
    defaultColor: '#22C55E',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <rect x="10" y="14" width="28" height="18" rx="3" fill="currentColor" opacity="0.3"/>
      <rect x="12" y="16" width="24" height="14" rx="2" fill="currentColor" opacity="0.15"/>
      <text x="16" y="26" font-family="monospace" font-size="6" fill="currentColor" opacity="0.7">&gt;_</text>
      <rect x="18" y="32" width="12" height="2" rx="1" fill="currentColor" opacity="0.4"/>
      <rect x="16" y="34" width="16" height="2" rx="1" fill="currentColor" opacity="0.3"/>`
  },
  {
    key: 'robot',
    label: 'Robot',
    category: 'tech',
    defaultColor: '#06B6D4',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <rect x="14" y="14" width="20" height="16" rx="4" fill="currentColor" opacity="0.35"/>
      <rect x="18" y="18" width="4" height="4" rx="1" fill="currentColor" opacity="0.7"/>
      <rect x="26" y="18" width="4" height="4" rx="1" fill="currentColor" opacity="0.7"/>
      <rect x="20" y="26" width="8" height="2" rx="1" fill="currentColor" opacity="0.5"/>
      <rect x="16" y="32" width="16" height="8" rx="3" fill="currentColor" opacity="0.25"/>
      <line x1="24" y1="10" x2="24" y2="14" stroke="currentColor" stroke-width="2"/>
      <circle cx="24" cy="9" r="2" fill="currentColor" opacity="0.5"/>`
  },
  {
    key: 'cyborg',
    label: 'Cyborg',
    category: 'tech',
    defaultColor: '#EF4444',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="20" r="10" fill="currentColor" opacity="0.25"/>
      <circle cx="20" cy="18" r="3" fill="currentColor" opacity="0.5"/>
      <circle cx="28" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <circle cx="28" cy="18" r="1.5" fill="currentColor" opacity="0.8"/>
      <path d="M18 26 Q24 30 30 26" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <path d="M14 32 L18 28" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M34 32 L30 28" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M32 16 L38 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`
  },
  // ── Nature ──
  {
    key: 'botanist',
    label: 'Botanist',
    category: 'nature',
    defaultColor: '#16A34A',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <path d="M24 38 L24 20" stroke="currentColor" stroke-width="2"/>
      <path d="M24 20 Q16 14 18 8 Q24 12 24 20" fill="currentColor" opacity="0.4"/>
      <path d="M24 26 Q32 20 30 14 Q24 18 24 26" fill="currentColor" opacity="0.5"/>
      <path d="M24 32 Q16 28 18 22 Q24 26 24 32" fill="currentColor" opacity="0.35"/>
      <circle cx="20" cy="36" r="2" fill="currentColor" opacity="0.3"/>
      <circle cx="28" cy="38" r="1.5" fill="currentColor" opacity="0.3"/>`
  },
  {
    key: 'explorer',
    label: 'Explorer',
    category: 'nature',
    defaultColor: '#CA8A04',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <path d="M12 22 L24 10 L36 22" fill="currentColor" opacity="0.3"/>
      <path d="M16 24 L24 14 L32 24" fill="currentColor" opacity="0.2"/>
      <circle cx="24" cy="30" r="7" fill="currentColor" opacity="0.3"/>
      <circle cx="24" cy="30" r="4" fill="currentColor" opacity="0.15"/>
      <path d="M24 26 L24 22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M24 26 L26 28" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`
  },
  {
    key: 'ranger',
    label: 'Ranger',
    category: 'nature',
    defaultColor: '#65A30D',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <path d="M14 24 L24 10 L34 24 Z" fill="currentColor" opacity="0.3"/>
      <ellipse cx="24" cy="16" rx="10" ry="3" fill="currentColor" opacity="0.25"/>
      <circle cx="24" cy="28" r="6" fill="currentColor" opacity="0.3"/>
      <circle cx="22" cy="27" r="1.5" fill="currentColor" opacity="0.6"/>
      <circle cx="26" cy="27" r="1.5" fill="currentColor" opacity="0.6"/>
      <path d="M22 31 Q24 33 26 31" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>`
  },
  // ── Classic ──
  {
    key: 'detective',
    label: 'Detective',
    category: 'classic',
    defaultColor: '#64748B',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="20" cy="24" r="8" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.5"/>
      <path d="M26 30 L34 38" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity="0.6"/>
      <path d="M10 16 L38 16" stroke="currentColor" stroke-width="2" opacity="0.3"/>
      <path d="M12 16 Q24 6 36 16" fill="currentColor" opacity="0.25"/>`
  },
  {
    key: 'architect',
    label: 'Architect',
    category: 'classic',
    defaultColor: '#6366F1',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <rect x="12" y="20" width="24" height="18" rx="1" fill="currentColor" opacity="0.25"/>
      <path d="M12 20 L24 10 L36 20" fill="currentColor" opacity="0.35"/>
      <rect x="20" y="28" width="8" height="10" fill="currentColor" opacity="0.3"/>
      <rect x="14" y="24" width="5" height="5" rx="1" fill="currentColor" opacity="0.4"/>
      <rect x="29" y="24" width="5" height="5" rx="1" fill="currentColor" opacity="0.4"/>`
  },
  {
    key: 'scholar',
    label: 'Scholar',
    category: 'classic',
    defaultColor: '#10B981',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <rect x="12" y="14" width="18" height="22" rx="2" fill="currentColor" opacity="0.3"/>
      <rect x="14" y="16" width="14" height="18" rx="1" fill="currentColor" opacity="0.15"/>
      <line x1="16" y1="20" x2="26" y2="20" stroke="currentColor" stroke-width="1" opacity="0.4"/>
      <line x1="16" y1="24" x2="26" y2="24" stroke="currentColor" stroke-width="1" opacity="0.4"/>
      <line x1="16" y1="28" x2="24" y2="28" stroke="currentColor" stroke-width="1" opacity="0.4"/>
      <path d="M30 12 L36 8 L36 34 L30 38 Z" fill="currentColor" opacity="0.2"/>
      <path d="M32 10 L32 36" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>`
  },
  {
    key: 'alchemist',
    label: 'Alchemist',
    category: 'classic',
    defaultColor: '#F59E0B',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <path d="M20 12 L20 22 L12 36 L36 36 L28 22 L28 12 Z" fill="currentColor" opacity="0.3"/>
      <rect x="18" y="10" width="12" height="4" rx="1" fill="currentColor" opacity="0.4"/>
      <ellipse cx="24" cy="32" rx="8" ry="4" fill="currentColor" opacity="0.25"/>
      <circle cx="20" cy="30" r="2" fill="currentColor" opacity="0.5"/>
      <circle cx="26" cy="32" r="1.5" fill="currentColor" opacity="0.4"/>
      <circle cx="24" cy="28" r="1" fill="currentColor" opacity="0.6"/>`
  }
]

/** Map of avatar key → definition for O(1) lookup */
export const AVATAR_MAP: Record<string, AvatarDefinition> = Object.fromEntries(
  AVATAR_LIBRARY.map((a) => [a.key, a])
)

/** All available avatar keys */
export const AVATAR_KEYS = AVATAR_LIBRARY.map((a) => a.key)
