/**
 * Built-in avatar library: 16 SVG avatar definitions rendered as inline SVG paths.
 * Each avatar has a unique key, label, category, and a default accent color.
 *
 * The SVG strings are designed as 48x48 viewBox with a consistent circular style.
 * All avatars are human/person-themed with distinguishing features.
 */

export interface AvatarDefinition {
  key: string
  label: string
  category: 'professional' | 'casual' | 'characters'
  defaultColor: string
  /** Inline SVG markup (without the outer <svg> tag — just the inner paths/groups) */
  svgContent: string
}

/**
 * All built-in avatars. The SVG content uses a 48x48 viewBox.
 * Each avatar is a stylized person/character that works well at 24-48px.
 */
export const AVATAR_LIBRARY: AvatarDefinition[] = [
  // ── Characters ──
  {
    key: 'da-vinci',
    label: 'Da Vinci',
    category: 'characters',
    defaultColor: '#D97706',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="17" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M17 14 Q14 10 16 7 Q18 9 19 12" fill="currentColor" opacity="0.4"/>
      <path d="M31 14 Q34 10 32 7 Q30 9 29 12" fill="currentColor" opacity="0.4"/>
      <ellipse cx="24" cy="10" rx="8" ry="3" fill="currentColor" opacity="0.45"/>
      <path d="M16 10 Q14 8 16 6 Q20 8 28 8 Q32 8 32 6 Q34 8 32 10" fill="currentColor" opacity="0.5"/>
      <path d="M14 15 Q12 20 14 24 Q15 22 17 20" fill="currentColor" opacity="0.3"/>
      <path d="M34 15 Q36 20 34 24 Q33 22 31 20" fill="currentColor" opacity="0.3"/>
      <path d="M21 22 Q24 26 27 22" fill="currentColor" opacity="0.4"/>
      <circle cx="21" cy="17" r="1.2" fill="currentColor" opacity="0.7"/>
      <circle cx="27" cy="17" r="1.2" fill="currentColor" opacity="0.7"/>
      <path d="M14 30 C14 26 18 24 24 24 C30 24 34 26 34 30 L34 38 C34 40 30 42 24 42 C18 42 14 40 14 38Z" fill="currentColor" opacity="0.3"/>
      <path d="M20 30 L20 26 M28 30 L28 26" stroke="currentColor" stroke-width="1" opacity="0.3"/>`
  },
  {
    key: 'stravinsky',
    label: 'Stravinsky',
    category: 'characters',
    defaultColor: '#8B5CF6',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="17" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M16 14 Q16 10 20 10 L28 10 Q32 10 32 14" fill="currentColor" opacity="0.45"/>
      <circle cx="20" cy="17" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
      <circle cx="28" cy="17" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.7"/>
      <circle cx="20" cy="17" r="1.2" fill="currentColor" opacity="0.6"/>
      <circle cx="28" cy="17" r="1.2" fill="currentColor" opacity="0.6"/>
      <path d="M16.5 17 L13 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/>
      <path d="M31.5 17 L35 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/>
      <path d="M22 22 Q24 23.5 26 22" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M14 30 C14 26 18 24 24 24 C30 24 34 26 34 30 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.3"/>
      <path d="M20 28 L18 32 L24 30 L30 32 L28 28" fill="currentColor" opacity="0.5"/>
      <path d="M24 30 L24 34" stroke="currentColor" stroke-width="1" opacity="0.4"/>`
  },
  // ── Professional ──
  {
    key: 'business-man',
    label: 'Business Man',
    category: 'professional',
    defaultColor: '#6366F1',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="16" r="7" fill="currentColor" opacity="0.35"/>
      <circle cx="21.5" cy="15.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <circle cx="26.5" cy="15.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <path d="M22 20 Q24 22 26 20" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.35"/>
      <path d="M20 24 L24 34 L28 24" fill="currentColor" opacity="0.5"/>
      <path d="M24 28 L24 34" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
      <rect x="22.5" y="24" width="3" height="2" rx="0.5" fill="currentColor" opacity="0.6"/>`
  },
  {
    key: 'business-woman',
    label: 'Business Woman',
    category: 'professional',
    defaultColor: '#EC4899',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="16" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M17 14 Q17 8 24 8 Q31 8 31 14" fill="currentColor" opacity="0.4"/>
      <ellipse cx="24" cy="8" rx="5" ry="2" fill="currentColor" opacity="0.35"/>
      <circle cx="21.5" cy="15.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <circle cx="26.5" cy="15.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <path d="M22 20 Q24 22 26 20" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.35"/>
      <path d="M18 26 L18 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.4"/>
      <path d="M30 26 L30 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.4"/>`
  },
  {
    key: 'glasses-guy',
    label: 'Glasses Guy',
    category: 'professional',
    defaultColor: '#10B981',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="16" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M17 12 Q17 9 24 9 Q31 9 31 12" fill="currentColor" opacity="0.3"/>
      <rect x="17" y="13" width="6" height="5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
      <rect x="25" y="13" width="6" height="5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.6"/>
      <path d="M23 15.5 L25 15.5" stroke="currentColor" stroke-width="1" opacity="0.5"/>
      <circle cx="20" cy="15.5" r="1" fill="currentColor" opacity="0.7"/>
      <circle cx="28" cy="15.5" r="1" fill="currentColor" opacity="0.7"/>
      <path d="M22 20 Q24 22 26 20" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.3"/>`
  },
  {
    key: 'hoodie-dev',
    label: 'Hoodie Dev',
    category: 'professional',
    defaultColor: '#22C55E',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="16" r="7" fill="currentColor" opacity="0.35"/>
      <circle cx="21.5" cy="15.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <circle cx="26.5" cy="15.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <path d="M22 20 Q24 21.5 26 20" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M12 32 C12 26 16 23 24 23 C32 23 36 26 36 32 L36 42 C36 42 30 42 24 42 C18 42 12 42 12 42Z" fill="currentColor" opacity="0.35"/>
      <path d="M18 23 Q16 20 18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.3"/>
      <path d="M30 23 Q32 20 30 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.3"/>
      <path d="M20 28 L24 32 L28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.4"/>
      <path d="M24 28 L24 36" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>`
  },
  // ── Casual ──
  {
    key: 'woman-curly',
    label: 'Curly Hair',
    category: 'casual',
    defaultColor: '#F97316',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="17" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M15 16 Q13 10 16 7 Q18 10 17 14" fill="currentColor" opacity="0.4"/>
      <path d="M33 16 Q35 10 32 7 Q30 10 31 14" fill="currentColor" opacity="0.4"/>
      <path d="M16 12 Q14 8 18 6 Q20 9 22 8 Q24 6 26 8 Q28 9 30 6 Q34 8 32 12" fill="currentColor" opacity="0.45"/>
      <path d="M15 14 Q13 18 15 22" fill="currentColor" opacity="0.35"/>
      <path d="M33 14 Q35 18 33 22" fill="currentColor" opacity="0.35"/>
      <circle cx="21.5" cy="16.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <circle cx="26.5" cy="16.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <path d="M22 21 Q24 23 26 21" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.3"/>`
  },
  {
    key: 'bearded-man',
    label: 'Bearded Man',
    category: 'casual',
    defaultColor: '#CA8A04',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="16" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M17 12 Q17 8 24 8 Q31 8 31 12" fill="currentColor" opacity="0.35"/>
      <circle cx="21.5" cy="15" r="1.2" fill="currentColor" opacity="0.7"/>
      <circle cx="26.5" cy="15" r="1.2" fill="currentColor" opacity="0.7"/>
      <path d="M18 20 Q20 24 24 25 Q28 24 30 20" fill="currentColor" opacity="0.35"/>
      <path d="M19 20 Q24 22 29 20" fill="none" stroke="currentColor" stroke-width="1" opacity="0.4"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.3"/>`
  },
  {
    key: 'ponytail-girl',
    label: 'Ponytail Girl',
    category: 'casual',
    defaultColor: '#F43F5E',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="17" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M17 15 Q17 9 24 9 Q31 9 31 15" fill="currentColor" opacity="0.4"/>
      <path d="M31 12 Q34 10 36 6 Q38 10 36 14 Q34 12 32 14" fill="currentColor" opacity="0.45"/>
      <path d="M31 12 L34 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.35"/>
      <circle cx="21.5" cy="16.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <circle cx="26.5" cy="16.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <path d="M22 21 Q24 23 26 21" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.3"/>`
  },
  {
    key: 'cap-guy',
    label: 'Cap Guy',
    category: 'casual',
    defaultColor: '#06B6D4',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="18" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M15 14 L33 14 L35 12 L33 10 Q24 8 15 10 L13 12 Z" fill="currentColor" opacity="0.5"/>
      <path d="M33 12 L38 11" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.4"/>
      <circle cx="21.5" cy="17.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <circle cx="26.5" cy="17.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <path d="M22 22 Q24 23.5 26 22" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M14 34 C14 29 18 26 24 26 C30 26 34 29 34 34 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.3"/>`
  },
  // ── Characters (continued) ──
  {
    key: 'robot',
    label: 'Robot',
    category: 'characters',
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
    key: 'ninja',
    label: 'Ninja',
    category: 'characters',
    defaultColor: '#EF4444',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="17" r="7" fill="currentColor" opacity="0.35"/>
      <rect x="15" y="14" width="18" height="5" rx="2" fill="currentColor" opacity="0.45"/>
      <circle cx="20.5" cy="16" r="1.5" fill="currentColor" opacity="0.8"/>
      <circle cx="27.5" cy="16" r="1.5" fill="currentColor" opacity="0.8"/>
      <path d="M33 15 L40 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.4"/>
      <path d="M33 17 L39 16" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.3"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.3"/>
      <path d="M20 30 L16 26" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.35"/>
      <path d="M28 30 L32 26" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.35"/>`
  },
  {
    key: 'superhero',
    label: 'Superhero',
    category: 'characters',
    defaultColor: '#6366F1',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="16" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M17 14 L20 12 L24 14 L28 12 L31 14" fill="currentColor" opacity="0.5"/>
      <rect x="18" y="14" width="12" height="4" rx="2" fill="currentColor" opacity="0.45"/>
      <circle cx="21" cy="16" r="1.5" fill="currentColor" opacity="0.8"/>
      <circle cx="27" cy="16" r="1.5" fill="currentColor" opacity="0.8"/>
      <path d="M22 21 Q24 22.5 26 21" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.35"/>
      <path d="M10 30 L14 28 L14 36 Z" fill="currentColor" opacity="0.3"/>
      <path d="M38 30 L34 28 L34 36 Z" fill="currentColor" opacity="0.3"/>
      <path d="M22 28 L24 32 L26 28" fill="currentColor" opacity="0.5"/>`
  },
  {
    key: 'pirate',
    label: 'Pirate',
    category: 'characters',
    defaultColor: '#64748B',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="17" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M14 12 L34 12 Q36 12 35 10 Q30 6 24 6 Q18 6 13 10 Q12 12 14 12Z" fill="currentColor" opacity="0.45"/>
      <path d="M14 12 L12 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.3"/>
      <path d="M34 12 L36 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.3"/>
      <circle cx="21" cy="16.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <ellipse cx="27.5" cy="16.5" rx="3" ry="3" fill="currentColor" opacity="0.4"/>
      <path d="M25 14 L30 19" stroke="currentColor" stroke-width="1" opacity="0.5"/>
      <path d="M30 14 L25 19" stroke="currentColor" stroke-width="1" opacity="0.5"/>
      <path d="M21 22 Q24 24 27 22" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.3"/>`
  },
  {
    key: 'scientist',
    label: 'Scientist',
    category: 'characters',
    defaultColor: '#16A34A',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="17" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M17 12 Q17 8 24 8 Q31 8 31 12" fill="currentColor" opacity="0.3"/>
      <circle cx="20" cy="15" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
      <circle cx="28" cy="15" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.5"/>
      <circle cx="20" cy="15" r="1" fill="currentColor" opacity="0.7"/>
      <circle cx="28" cy="15" r="1" fill="currentColor" opacity="0.7"/>
      <path d="M16.5 15 L13 14.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.4"/>
      <path d="M31.5 15 L35 14.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" opacity="0.4"/>
      <path d="M22 21 Q24 22.5 26 21" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M12 30 C12 26 16 23 24 23 C32 23 36 26 36 30 L36 42 C36 42 30 42 24 42 C18 42 12 42 12 42Z" fill="currentColor" opacity="0.3"/>
      <path d="M18 26 L18 42 M30 26 L30 42" stroke="currentColor" stroke-width="1" opacity="0.2"/>`
  },
  {
    key: 'chef',
    label: 'Chef',
    category: 'characters',
    defaultColor: '#F59E0B',
    svgContent: `<circle cx="24" cy="24" r="22" fill="currentColor" opacity="0.15"/>
      <circle cx="24" cy="18" r="7" fill="currentColor" opacity="0.35"/>
      <path d="M16 12 Q14 4 20 4 Q22 4 23 6 Q24 3 26 4 Q28 4 29 6 Q30 4 34 4 Q34 12 32 12 Z" fill="currentColor" opacity="0.45"/>
      <rect x="16" y="11" width="16" height="2" rx="1" fill="currentColor" opacity="0.35"/>
      <circle cx="21.5" cy="17.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <circle cx="26.5" cy="17.5" r="1.2" fill="currentColor" opacity="0.7"/>
      <path d="M22 22 Q24 24 26 22" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      <path d="M14 34 C14 29 18 26 24 26 C30 26 34 29 34 34 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="currentColor" opacity="0.35"/>
      <circle cx="24" cy="30" r="1.5" fill="currentColor" opacity="0.45"/>
      <circle cx="24" cy="35" r="1.5" fill="currentColor" opacity="0.45"/>`
  }
]

/** Map of avatar key -> definition for O(1) lookup */
export const AVATAR_MAP: Record<string, AvatarDefinition> = Object.fromEntries(
  AVATAR_LIBRARY.map((a) => [a.key, a])
)

/** All available avatar keys */
export const AVATAR_KEYS = AVATAR_LIBRARY.map((a) => a.key)
