/**
 * Built-in avatar library: 16 SVG avatar definitions rendered as inline SVG paths.
 * Each avatar has a unique key, label, category, a default accent color,
 * a background color, and a multi-color palette for character parts.
 *
 * The SVG strings are designed as 48x48 viewBox with a consistent circular style.
 * All avatars are human/person-themed with distinguishing features.
 * SVG content uses CSS custom properties (--av-bg, --av-skin, etc.) for coloring.
 */

export interface AvatarPalette {
  skin: string
  hair: string
  clothing: string
  accessory: string
  eyes: string
}

export interface AvatarDefinition {
  key: string
  label: string
  category: 'professional' | 'casual' | 'characters'
  defaultColor: string
  /** Background circle fill color */
  bgColor: string
  /** Multi-color palette for character parts */
  palette: AvatarPalette
  /** Inline SVG markup (without the outer <svg> tag — just the inner paths/groups) */
  svgContent: string
}

/**
 * All built-in avatars. The SVG content uses a 48x48 viewBox.
 * Each avatar is a stylized person/character that works well at 24-48px.
 * Colors are applied via CSS custom properties set on the parent <svg>.
 */
export const AVATAR_LIBRARY: AvatarDefinition[] = [
  // ── Characters ──
  {
    key: 'da-vinci',
    label: 'Da Vinci',
    category: 'characters',
    defaultColor: '#D97706',
    bgColor: '#78350F',
    palette: {
      skin: '#FBBF24',
      hair: '#92400E',
      clothing: '#B45309',
      accessory: '#FDE68A',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="17" r="7" fill="var(--av-skin)"/>
      <path d="M17 14 Q14 10 16 7 Q18 9 19 12" fill="var(--av-hair)"/>
      <path d="M31 14 Q34 10 32 7 Q30 9 29 12" fill="var(--av-hair)"/>
      <ellipse cx="24" cy="10" rx="8" ry="3" fill="var(--av-hair)"/>
      <path d="M16 10 Q14 8 16 6 Q20 8 28 8 Q32 8 32 6 Q34 8 32 10" fill="var(--av-hair)"/>
      <path d="M14 15 Q12 20 14 24 Q15 22 17 20" fill="var(--av-hair)" opacity="0.8"/>
      <path d="M34 15 Q36 20 34 24 Q33 22 31 20" fill="var(--av-hair)" opacity="0.8"/>
      <path d="M21 22 Q24 26 27 22" fill="var(--av-accessory)" opacity="0.6"/>
      <circle cx="21" cy="17" r="1.2" fill="var(--av-eyes)"/>
      <circle cx="27" cy="17" r="1.2" fill="var(--av-eyes)"/>
      <path d="M14 30 C14 26 18 24 24 24 C30 24 34 26 34 30 L34 38 C34 40 30 42 24 42 C18 42 14 40 14 38Z" fill="var(--av-clothing)"/>
      <path d="M20 30 L20 26 M28 30 L28 26" stroke="var(--av-accessory)" stroke-width="1" opacity="0.5"/>`
  },
  {
    key: 'stravinsky',
    label: 'Stravinsky',
    category: 'characters',
    defaultColor: '#8B5CF6',
    bgColor: '#4C1D95',
    palette: {
      skin: '#F9A8D4',
      hair: '#1E1B4B',
      clothing: '#7C3AED',
      accessory: '#C4B5FD',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="17" r="7" fill="var(--av-skin)"/>
      <path d="M16 14 Q16 10 20 10 L28 10 Q32 10 32 14" fill="var(--av-hair)"/>
      <circle cx="20" cy="17" r="3.5" fill="none" stroke="var(--av-accessory)" stroke-width="1.5"/>
      <circle cx="28" cy="17" r="3.5" fill="none" stroke="var(--av-accessory)" stroke-width="1.5"/>
      <circle cx="20" cy="17" r="1.2" fill="var(--av-eyes)"/>
      <circle cx="28" cy="17" r="1.2" fill="var(--av-eyes)"/>
      <path d="M16.5 17 L13 16" stroke="var(--av-accessory)" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M31.5 17 L35 16" stroke="var(--av-accessory)" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M22 22 Q24 23.5 26 22" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M14 30 C14 26 18 24 24 24 C30 24 34 26 34 30 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-clothing)"/>
      <path d="M20 28 L18 32 L24 30 L30 32 L28 28" fill="var(--av-accessory)" opacity="0.6"/>
      <path d="M24 30 L24 34" stroke="var(--av-accessory)" stroke-width="1" opacity="0.4"/>`
  },
  // ── Professional ──
  {
    key: 'business-man',
    label: 'Business Man',
    category: 'professional',
    defaultColor: '#6366F1',
    bgColor: '#312E81',
    palette: {
      skin: '#FCD34D',
      hair: '#1F2937',
      clothing: '#4F46E5',
      accessory: '#818CF8',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="16" r="7" fill="var(--av-skin)"/>
      <path d="M17 12 Q17 8 24 8 Q31 8 31 12" fill="var(--av-hair)"/>
      <circle cx="21.5" cy="15.5" r="1.2" fill="var(--av-eyes)"/>
      <circle cx="26.5" cy="15.5" r="1.2" fill="var(--av-eyes)"/>
      <path d="M22 20 Q24 22 26 20" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-clothing)"/>
      <path d="M20 24 L24 34 L28 24" fill="var(--av-accessory)" opacity="0.6"/>
      <path d="M24 28 L24 34" stroke="var(--av-accessory)" stroke-width="1.5"/>
      <rect x="22.5" y="24" width="3" height="2" rx="0.5" fill="var(--av-accessory)"/>`
  },
  {
    key: 'business-woman',
    label: 'Business Woman',
    category: 'professional',
    defaultColor: '#EC4899',
    bgColor: '#831843',
    palette: {
      skin: '#FCA5A5',
      hair: '#1C1917',
      clothing: '#EC4899',
      accessory: '#F9A8D4',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="16" r="7" fill="var(--av-skin)"/>
      <path d="M17 14 Q17 8 24 8 Q31 8 31 14" fill="var(--av-hair)"/>
      <ellipse cx="24" cy="8" rx="5" ry="2" fill="var(--av-hair)" opacity="0.8"/>
      <circle cx="21.5" cy="15.5" r="1.2" fill="var(--av-eyes)"/>
      <circle cx="26.5" cy="15.5" r="1.2" fill="var(--av-eyes)"/>
      <path d="M22 20 Q24 22 26 20" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-clothing)"/>
      <path d="M18 26 L18 24" stroke="var(--av-accessory)" stroke-width="2" stroke-linecap="round"/>
      <path d="M30 26 L30 24" stroke="var(--av-accessory)" stroke-width="2" stroke-linecap="round"/>`
  },
  {
    key: 'glasses-guy',
    label: 'Glasses Guy',
    category: 'professional',
    defaultColor: '#10B981',
    bgColor: '#064E3B',
    palette: {
      skin: '#A7F3D0',
      hair: '#374151',
      clothing: '#10B981',
      accessory: '#6EE7B7',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="16" r="7" fill="var(--av-skin)"/>
      <path d="M17 12 Q17 9 24 9 Q31 9 31 12" fill="var(--av-hair)"/>
      <rect x="17" y="13" width="6" height="5" rx="2" fill="none" stroke="var(--av-accessory)" stroke-width="1.5"/>
      <rect x="25" y="13" width="6" height="5" rx="2" fill="none" stroke="var(--av-accessory)" stroke-width="1.5"/>
      <path d="M23 15.5 L25 15.5" stroke="var(--av-accessory)" stroke-width="1"/>
      <circle cx="20" cy="15.5" r="1" fill="var(--av-eyes)"/>
      <circle cx="28" cy="15.5" r="1" fill="var(--av-eyes)"/>
      <path d="M22 20 Q24 22 26 20" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-clothing)"/>`
  },
  {
    key: 'hoodie-dev',
    label: 'Hoodie Dev',
    category: 'professional',
    defaultColor: '#22C55E',
    bgColor: '#14532D',
    palette: {
      skin: '#BBF7D0',
      hair: '#1F2937',
      clothing: '#22C55E',
      accessory: '#86EFAC',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="16" r="7" fill="var(--av-skin)"/>
      <path d="M17 12 Q17 9 24 9 Q31 9 31 12" fill="var(--av-hair)"/>
      <circle cx="21.5" cy="15.5" r="1.2" fill="var(--av-eyes)"/>
      <circle cx="26.5" cy="15.5" r="1.2" fill="var(--av-eyes)"/>
      <path d="M22 20 Q24 21.5 26 20" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M12 32 C12 26 16 23 24 23 C32 23 36 26 36 32 L36 42 C36 42 30 42 24 42 C18 42 12 42 12 42Z" fill="var(--av-clothing)"/>
      <path d="M18 23 Q16 20 18 18" stroke="var(--av-accessory)" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
      <path d="M30 23 Q32 20 30 18" stroke="var(--av-accessory)" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
      <path d="M20 28 L24 32 L28 28" fill="none" stroke="var(--av-accessory)" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>
      <path d="M24 28 L24 36" stroke="var(--av-accessory)" stroke-width="1.5" opacity="0.5"/>`
  },
  // ── Casual ──
  {
    key: 'woman-curly',
    label: 'Curly Hair',
    category: 'casual',
    defaultColor: '#F97316',
    bgColor: '#7C2D12',
    palette: {
      skin: '#FDBA74',
      hair: '#9A3412',
      clothing: '#F97316',
      accessory: '#FED7AA',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="17" r="7" fill="var(--av-skin)"/>
      <path d="M15 16 Q13 10 16 7 Q18 10 17 14" fill="var(--av-hair)"/>
      <path d="M33 16 Q35 10 32 7 Q30 10 31 14" fill="var(--av-hair)"/>
      <path d="M16 12 Q14 8 18 6 Q20 9 22 8 Q24 6 26 8 Q28 9 30 6 Q34 8 32 12" fill="var(--av-hair)"/>
      <path d="M15 14 Q13 18 15 22" fill="var(--av-hair)" opacity="0.8"/>
      <path d="M33 14 Q35 18 33 22" fill="var(--av-hair)" opacity="0.8"/>
      <circle cx="21.5" cy="16.5" r="1.2" fill="var(--av-eyes)"/>
      <circle cx="26.5" cy="16.5" r="1.2" fill="var(--av-eyes)"/>
      <path d="M22 21 Q24 23 26 21" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-clothing)"/>`
  },
  {
    key: 'bearded-man',
    label: 'Bearded Man',
    category: 'casual',
    defaultColor: '#CA8A04',
    bgColor: '#713F12',
    palette: {
      skin: '#FDE68A',
      hair: '#78350F',
      clothing: '#CA8A04',
      accessory: '#FEF08A',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="16" r="7" fill="var(--av-skin)"/>
      <path d="M17 12 Q17 8 24 8 Q31 8 31 12" fill="var(--av-hair)"/>
      <circle cx="21.5" cy="15" r="1.2" fill="var(--av-eyes)"/>
      <circle cx="26.5" cy="15" r="1.2" fill="var(--av-eyes)"/>
      <path d="M18 20 Q20 24 24 25 Q28 24 30 20" fill="var(--av-hair)" opacity="0.7"/>
      <path d="M19 20 Q24 22 29 20" fill="none" stroke="var(--av-accessory)" stroke-width="1" opacity="0.6"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-clothing)"/>`
  },
  {
    key: 'ponytail-girl',
    label: 'Ponytail Girl',
    category: 'casual',
    defaultColor: '#F43F5E',
    bgColor: '#881337',
    palette: {
      skin: '#FDA4AF',
      hair: '#1C1917',
      clothing: '#F43F5E',
      accessory: '#FECDD3',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="17" r="7" fill="var(--av-skin)"/>
      <path d="M17 15 Q17 9 24 9 Q31 9 31 15" fill="var(--av-hair)"/>
      <path d="M31 12 Q34 10 36 6 Q38 10 36 14 Q34 12 32 14" fill="var(--av-hair)" opacity="0.9"/>
      <path d="M31 12 L34 8" stroke="var(--av-hair)" stroke-width="2" stroke-linecap="round" opacity="0.7"/>
      <circle cx="21.5" cy="16.5" r="1.2" fill="var(--av-eyes)"/>
      <circle cx="26.5" cy="16.5" r="1.2" fill="var(--av-eyes)"/>
      <path d="M22 21 Q24 23 26 21" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-clothing)"/>`
  },
  {
    key: 'cap-guy',
    label: 'Cap Guy',
    category: 'casual',
    defaultColor: '#06B6D4',
    bgColor: '#164E63',
    palette: {
      skin: '#A5F3FC',
      hair: '#374151',
      clothing: '#06B6D4',
      accessory: '#67E8F9',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="18" r="7" fill="var(--av-skin)"/>
      <path d="M15 14 L33 14 L35 12 L33 10 Q24 8 15 10 L13 12 Z" fill="var(--av-accessory)"/>
      <path d="M33 12 L38 11" stroke="var(--av-accessory)" stroke-width="2" stroke-linecap="round" opacity="0.7"/>
      <circle cx="21.5" cy="17.5" r="1.2" fill="var(--av-eyes)"/>
      <circle cx="26.5" cy="17.5" r="1.2" fill="var(--av-eyes)"/>
      <path d="M22 22 Q24 23.5 26 22" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M14 34 C14 29 18 26 24 26 C30 26 34 29 34 34 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-clothing)"/>`
  },
  // ── Characters (continued) ──
  {
    key: 'robot',
    label: 'Robot',
    category: 'characters',
    defaultColor: '#06B6D4',
    bgColor: '#083344',
    palette: {
      skin: '#94A3B8',
      hair: '#1E293B',
      clothing: '#06B6D4',
      accessory: '#38BDF8',
      eyes: '#38BDF8'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <rect x="14" y="14" width="20" height="16" rx="4" fill="var(--av-skin)"/>
      <rect x="18" y="18" width="4" height="4" rx="1" fill="var(--av-eyes)"/>
      <rect x="26" y="18" width="4" height="4" rx="1" fill="var(--av-eyes)"/>
      <rect x="20" y="26" width="8" height="2" rx="1" fill="var(--av-accessory)"/>
      <rect x="16" y="32" width="16" height="8" rx="3" fill="var(--av-clothing)"/>
      <line x1="24" y1="10" x2="24" y2="14" stroke="var(--av-accessory)" stroke-width="2"/>
      <circle cx="24" cy="9" r="2" fill="var(--av-accessory)"/>`
  },
  {
    key: 'ninja',
    label: 'Ninja',
    category: 'characters',
    defaultColor: '#EF4444',
    bgColor: '#450A0A',
    palette: {
      skin: '#FCA5A5',
      hair: '#1C1917',
      clothing: '#EF4444',
      accessory: '#FCA5A5',
      eyes: '#FEFCE8'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="17" r="7" fill="var(--av-skin)"/>
      <rect x="15" y="14" width="18" height="5" rx="2" fill="var(--av-clothing)"/>
      <circle cx="20.5" cy="16" r="1.5" fill="var(--av-eyes)"/>
      <circle cx="27.5" cy="16" r="1.5" fill="var(--av-eyes)"/>
      <path d="M33 15 L40 12" stroke="var(--av-clothing)" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>
      <path d="M33 17 L39 16" stroke="var(--av-clothing)" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-hair)"/>
      <path d="M20 30 L16 26" stroke="var(--av-accessory)" stroke-width="1.5" stroke-linecap="round" opacity="0.6"/>
      <path d="M28 30 L32 26" stroke="var(--av-accessory)" stroke-width="1.5" stroke-linecap="round" opacity="0.6"/>`
  },
  {
    key: 'superhero',
    label: 'Superhero',
    category: 'characters',
    defaultColor: '#6366F1',
    bgColor: '#312E81',
    palette: {
      skin: '#C7D2FE',
      hair: '#1E1B4B',
      clothing: '#6366F1',
      accessory: '#A5B4FC',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="16" r="7" fill="var(--av-skin)"/>
      <path d="M17 14 L20 12 L24 14 L28 12 L31 14" fill="var(--av-accessory)"/>
      <rect x="18" y="14" width="12" height="4" rx="2" fill="var(--av-accessory)"/>
      <circle cx="21" cy="16" r="1.5" fill="var(--av-eyes)"/>
      <circle cx="27" cy="16" r="1.5" fill="var(--av-eyes)"/>
      <path d="M22 21 Q24 22.5 26 21" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-clothing)"/>
      <path d="M10 30 L14 28 L14 36 Z" fill="var(--av-accessory)" opacity="0.6"/>
      <path d="M38 30 L34 28 L34 36 Z" fill="var(--av-accessory)" opacity="0.6"/>
      <path d="M22 28 L24 32 L26 28" fill="var(--av-accessory)"/>`
  },
  {
    key: 'pirate',
    label: 'Pirate',
    category: 'characters',
    defaultColor: '#64748B',
    bgColor: '#1E293B',
    palette: {
      skin: '#CBD5E1',
      hair: '#0F172A',
      clothing: '#64748B',
      accessory: '#94A3B8',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="17" r="7" fill="var(--av-skin)"/>
      <path d="M14 12 L34 12 Q36 12 35 10 Q30 6 24 6 Q18 6 13 10 Q12 12 14 12Z" fill="var(--av-hair)"/>
      <path d="M14 12 L12 14" stroke="var(--av-accessory)" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M34 12 L36 14" stroke="var(--av-accessory)" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="21" cy="16.5" r="1.2" fill="var(--av-eyes)"/>
      <ellipse cx="27.5" cy="16.5" rx="3" ry="3" fill="var(--av-hair)" opacity="0.7"/>
      <path d="M25 14 L30 19" stroke="var(--av-accessory)" stroke-width="1"/>
      <path d="M30 14 L25 19" stroke="var(--av-accessory)" stroke-width="1"/>
      <path d="M21 22 Q24 24 27 22" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M14 32 C14 27 18 24 24 24 C30 24 34 27 34 32 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-clothing)"/>`
  },
  {
    key: 'scientist',
    label: 'Scientist',
    category: 'characters',
    defaultColor: '#16A34A',
    bgColor: '#052E16',
    palette: {
      skin: '#BBF7D0',
      hair: '#1F2937',
      clothing: '#16A34A',
      accessory: '#86EFAC',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="17" r="7" fill="var(--av-skin)"/>
      <path d="M17 12 Q17 8 24 8 Q31 8 31 12" fill="var(--av-hair)"/>
      <circle cx="20" cy="15" r="3.5" fill="none" stroke="var(--av-accessory)" stroke-width="1.5"/>
      <circle cx="28" cy="15" r="3.5" fill="none" stroke="var(--av-accessory)" stroke-width="1.5"/>
      <circle cx="20" cy="15" r="1" fill="var(--av-eyes)"/>
      <circle cx="28" cy="15" r="1" fill="var(--av-eyes)"/>
      <path d="M16.5 15 L13 14.5" stroke="var(--av-accessory)" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M31.5 15 L35 14.5" stroke="var(--av-accessory)" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M22 21 Q24 22.5 26 21" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M12 30 C12 26 16 23 24 23 C32 23 36 26 36 30 L36 42 C36 42 30 42 24 42 C18 42 12 42 12 42Z" fill="var(--av-clothing)"/>
      <path d="M18 26 L18 42 M30 26 L30 42" stroke="var(--av-accessory)" stroke-width="1" opacity="0.3"/>`
  },
  {
    key: 'chef',
    label: 'Chef',
    category: 'characters',
    defaultColor: '#F59E0B',
    bgColor: '#78350F',
    palette: {
      skin: '#FDE68A',
      hair: '#451A03',
      clothing: '#F59E0B',
      accessory: '#FEF3C7',
      eyes: '#1C1917'
    },
    svgContent: `<circle cx="24" cy="24" r="22" fill="var(--av-bg)"/>
      <circle cx="24" cy="18" r="7" fill="var(--av-skin)"/>
      <path d="M16 12 Q14 4 20 4 Q22 4 23 6 Q24 3 26 4 Q28 4 29 6 Q30 4 34 4 Q34 12 32 12 Z" fill="var(--av-accessory)"/>
      <rect x="16" y="11" width="16" height="2" rx="1" fill="var(--av-accessory)" opacity="0.8"/>
      <circle cx="21.5" cy="17.5" r="1.2" fill="var(--av-eyes)"/>
      <circle cx="26.5" cy="17.5" r="1.2" fill="var(--av-eyes)"/>
      <path d="M22 22 Q24 24 26 22" fill="none" stroke="var(--av-skin)" stroke-width="1" stroke-linecap="round" opacity="0.7"/>
      <path d="M14 34 C14 29 18 26 24 26 C30 26 34 29 34 34 L34 40 C34 42 30 42 24 42 C18 42 14 42 14 40Z" fill="var(--av-clothing)"/>
      <circle cx="24" cy="30" r="1.5" fill="var(--av-accessory)"/>
      <circle cx="24" cy="35" r="1.5" fill="var(--av-accessory)"/>`
  }
]

/** Map of avatar key -> definition for O(1) lookup */
export const AVATAR_MAP: Record<string, AvatarDefinition> = Object.fromEntries(
  AVATAR_LIBRARY.map((a) => [a.key, a])
)

/** All available avatar keys */
export const AVATAR_KEYS = AVATAR_LIBRARY.map((a) => a.key)
