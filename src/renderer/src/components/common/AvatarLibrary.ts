/**
 * AvatarLibrary — Renaissance Portrait Collection
 *
 * 16 hand-crafted SVG portrait avatars in the Code Atelier dark Renaissance style.
 * Each avatar is a miniature portrait: jewel-tone background, period clothing,
 * distinguished features. Palette variables are injected via CSS custom properties
 * so Avatar.tsx can tint them without changes.
 *
 * CSS variables consumed by SVG content:
 *   --av-bg        background circle
 *   --av-skin      skin tone
 *   --av-hair      hair / headwear
 *   --av-clothing  primary garment
 *   --av-accessory accessories (collar, brooch, etc.)
 *   --av-eyes      eye color
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
  category: 'renaissance' | 'character'
  defaultColor: string
  bgColor: string
  palette: AvatarPalette
  svgContent: string
}

// ─── Deep jewel backgrounds ───────────────────────────────────────────────────

const BG = {
  violet: '#1A0E2A',
  nearBlack: '#1A0A0A',
  forest: '#0A1A14',
  navy: '#0A0E1A',
  amber: '#1A1208',
  plum: '#1A0814',
  teal: '#0A1212',
  rust: '#140A0A',
  slate: '#0E1518',
  green: '#0A1610',
  sienna: '#1A0E08',
  sepia: '#0E0A06',
  midnight: '#080810',
  charcoal: '#0A0F14',
  warmSepia: '#16100A',
  hunter: '#0A1410'
}

// ─── 16 Renaissance Portraits ────────────────────────────────────────────────

const RENAISSANCE_SCHOLAR: AvatarDefinition = {
  key: 'renaissance-scholar',
  label: 'The Scholar',
  category: 'renaissance',
  defaultColor: '#9B7FD4',
  bgColor: BG.violet,
  palette: { skin: '#C9997A', hair: '#2A1A0E', clothing: '#2D1F4A', accessory: '#C8B89A', eyes: '#5A3A8A' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#1A0E2A)"/>
    <circle cx="24" cy="18" r="14" fill="rgba(155,127,212,0.08)"/>
    <path d="M10 48 Q10 36 24 33 Q38 36 38 48Z" fill="var(--av-clothing,#2D1F4A)"/>
    <path d="M16 34 Q24 38 32 34 Q30 37 24 38 Q18 37 16 34Z" fill="var(--av-accessory,#C8B89A)" opacity="0.85"/>
    <rect x="21" y="27" width="6" height="7" rx="2" fill="var(--av-skin,#C9997A)"/>
    <ellipse cx="24" cy="22" rx="9" ry="10" fill="var(--av-skin,#C9997A)"/>
    <ellipse cx="24" cy="13" rx="9" ry="5" fill="var(--av-hair,#2A1A0E)"/>
    <path d="M15 18 Q13 14 15 12 Q18 10 24 10 Q30 10 33 12 Q35 14 33 18" fill="var(--av-hair,#2A1A0E)"/>
    <ellipse cx="20.5" cy="22" rx="1.8" ry="1.4" fill="#0A0806"/>
    <ellipse cx="27.5" cy="22" rx="1.8" ry="1.4" fill="#0A0806"/>
    <circle cx="21" cy="21.6" r="0.6" fill="rgba(255,255,255,0.7)"/>
    <circle cx="28" cy="21.6" r="0.6" fill="rgba(255,255,255,0.7)"/>
    <circle cx="20.5" cy="22" r="2.8" fill="none" stroke="var(--av-accessory,#C8B89A)" stroke-width="0.7" opacity="0.7"/>
    <circle cx="27.5" cy="22" r="2.8" fill="none" stroke="var(--av-accessory,#C8B89A)" stroke-width="0.7" opacity="0.7"/>
    <line x1="23.3" y1="22" x2="24.7" y2="22" stroke="var(--av-accessory,#C8B89A)" stroke-width="0.6" opacity="0.7"/>
    <path d="M23 24 Q24 25.5 25 24" fill="none" stroke="var(--av-skin,#C9997A)" stroke-width="0.8" opacity="0.5"/>
    <path d="M21.5 26.5 Q24 27.5 26.5 26.5" fill="none" stroke="#8A5A4A" stroke-width="0.9"/>
    <line x1="33" y1="14" x2="36" y2="10" stroke="var(--av-accessory,#C8B89A)" stroke-width="0.8" opacity="0.6"/>
    <path d="M36 10 Q37.5 8 36.5 9.5 Q38 9 37 10.5" fill="var(--av-accessory,#C8B89A)" opacity="0.5"/>
  `
}

const RENAISSANCE_MERCHANT: AvatarDefinition = {
  key: 'renaissance-merchant',
  label: 'The Merchant',
  category: 'renaissance',
  defaultColor: '#B8976A',
  bgColor: BG.nearBlack,
  palette: { skin: '#BC8A6A', hair: '#1A0E08', clothing: '#5A1A1A', accessory: '#B8976A', eyes: '#3A2010' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#1A0A0A)"/>
    <path d="M9 48 Q9 35 24 32 Q39 35 39 48Z" fill="var(--av-clothing,#5A1A1A)"/>
    <path d="M17 34 L24 32 L31 34" fill="none" stroke="var(--av-accessory,#B8976A)" stroke-width="1.2" opacity="0.8"/>
    <path d="M17 33 Q24 36 31 33 Q30 30 24 31 Q18 30 17 33Z" fill="rgba(184,151,106,0.2)" stroke="var(--av-accessory,#B8976A)" stroke-width="0.5" opacity="0.7"/>
    <rect x="21" y="27" width="6" height="7" rx="2" fill="var(--av-skin,#BC8A6A)"/>
    <ellipse cx="24" cy="21" rx="9.5" ry="10" fill="var(--av-skin,#BC8A6A)"/>
    <ellipse cx="24" cy="12" rx="9.5" ry="5" fill="var(--av-hair,#1A0E08)"/>
    <path d="M14.5 17 Q13 13 14 11 Q18 9 24 9 Q30 9 34 11 Q35 13 33.5 17" fill="var(--av-hair,#1A0E08)"/>
    <ellipse cx="20.5" cy="21" rx="1.6" ry="1.3" fill="#0A0604"/>
    <ellipse cx="27.5" cy="21" rx="1.6" ry="1.3" fill="#0A0604"/>
    <circle cx="21" cy="20.6" r="0.5" fill="rgba(255,255,255,0.6)"/>
    <circle cx="28" cy="20.6" r="0.5" fill="rgba(255,255,255,0.6)"/>
    <path d="M23 23 Q24 24.5 25 23" fill="none" stroke="var(--av-skin,#BC8A6A)" stroke-width="0.7" opacity="0.5"/>
    <path d="M21 25.5 Q23 26 25.5 25.5 Q24 26.5 21 25.5Z" fill="#7A3A2A" opacity="0.8"/>
    <circle cx="37" cy="40" r="2" fill="var(--av-accessory,#B8976A)" opacity="0.4"/>
    <ellipse cx="24" cy="27" rx="5" ry="2" fill="var(--av-hair,#1A0E08)" opacity="0.25"/>
  `
}

const RENAISSANCE_PAINTER: AvatarDefinition = {
  key: 'renaissance-painter',
  label: 'The Painter',
  category: 'renaissance',
  defaultColor: '#5DB88A',
  bgColor: BG.forest,
  palette: { skin: '#C4A07A', hair: '#3A2010', clothing: '#1A3A28', accessory: '#B8976A', eyes: '#2A4A38' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#0A1A14)"/>
    <path d="M8 48 Q8 34 24 31 Q40 34 40 48Z" fill="var(--av-clothing,#1A3A28)"/>
    <rect x="8" y="40" width="6" height="5" rx="1" fill="var(--av-clothing,#1A3A28)"/>
    <rect x="34" y="40" width="6" height="5" rx="1" fill="var(--av-clothing,#1A3A28)"/>
    <circle cx="10" cy="41" r="1" fill="#C4714A" opacity="0.5"/>
    <circle cx="36" cy="42" r="0.8" fill="#B8976A" opacity="0.5"/>
    <circle cx="38" cy="40" r="0.6" fill="#7ABFDB" opacity="0.4"/>
    <path d="M19 32 Q24 34 29 32 Q27 35 24 36 Q21 35 19 32Z" fill="var(--av-accessory,#B8976A)" opacity="0.5"/>
    <rect x="21" y="26" width="6" height="7" rx="2" fill="var(--av-skin,#C4A07A)"/>
    <ellipse cx="24" cy="21" rx="9" ry="10" fill="var(--av-skin,#C4A07A)"/>
    <ellipse cx="24" cy="12" rx="10" ry="5.5" fill="var(--av-hair,#3A2010)"/>
    <circle cx="15" cy="16" r="3" fill="var(--av-hair,#3A2010)"/>
    <circle cx="33" cy="16" r="3" fill="var(--av-hair,#3A2010)"/>
    <circle cx="17" cy="13" r="2.5" fill="var(--av-hair,#3A2010)"/>
    <circle cx="31" cy="13" r="2.5" fill="var(--av-hair,#3A2010)"/>
    <ellipse cx="20.5" cy="21" rx="1.8" ry="1.5" fill="#0A0A08"/>
    <ellipse cx="27.5" cy="21" rx="1.8" ry="1.5" fill="#0A0A08"/>
    <circle cx="21.1" cy="20.5" r="0.6" fill="rgba(255,255,255,0.75)"/>
    <circle cx="28.1" cy="20.5" r="0.6" fill="rgba(255,255,255,0.75)"/>
    <ellipse cx="28" cy="24" rx="2" ry="0.8" fill="#C4714A" opacity="0.2"/>
    <path d="M23 23 Q24 24.5 25 23" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="0.8"/>
    <path d="M21 26 Q24 27.5 27 26" fill="none" stroke="#8A5A3A" stroke-width="1"/>
  `
}

const RENAISSANCE_NAVIGATOR: AvatarDefinition = {
  key: 'renaissance-navigator',
  label: 'The Navigator',
  category: 'renaissance',
  defaultColor: '#6B9EC4',
  bgColor: BG.navy,
  palette: { skin: '#A07850', hair: '#1A1008', clothing: '#1A2A4A', accessory: '#B8976A', eyes: '#2A3A5A' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#0A0E1A)"/>
    <path d="M8 48 Q8 34 24 31 Q40 34 40 48Z" fill="var(--av-clothing,#1A2A4A)"/>
    <path d="M8 36 Q11 34 14 36 Q12 38 8 38Z" fill="var(--av-accessory,#B8976A)" opacity="0.7"/>
    <circle cx="22" cy="34" r="1.2" fill="var(--av-accessory,#B8976A)" opacity="0.7"/>
    <circle cx="24" cy="36" r="1.2" fill="var(--av-accessory,#B8976A)" opacity="0.7"/>
    <circle cx="26" cy="38" r="1.2" fill="var(--av-accessory,#B8976A)" opacity="0.7"/>
    <rect x="21" y="27" width="6" height="6" rx="2" fill="var(--av-skin,#A07850)"/>
    <ellipse cx="24" cy="21" rx="9" ry="10" fill="var(--av-skin,#A07850)"/>
    <ellipse cx="24" cy="12.5" rx="9" ry="4.5" fill="var(--av-hair,#1A1008)"/>
    <path d="M15 17 Q14 13 15.5 11 Q19 9.5 24 9.5 Q29 9.5 32.5 11 Q34 13 33 17" fill="var(--av-hair,#1A1008)"/>
    <path d="M17 18 Q20 17 22 18" fill="none" stroke="var(--av-hair,#1A1008)" stroke-width="1.4"/>
    <path d="M26 18 Q28 17 31 18" fill="none" stroke="var(--av-hair,#1A1008)" stroke-width="1.4"/>
    <ellipse cx="20.5" cy="21" rx="1.7" ry="1.3" fill="#0A0804"/>
    <ellipse cx="27.5" cy="21" rx="1.7" ry="1.3" fill="#0A0804"/>
    <circle cx="21" cy="20.6" r="0.5" fill="rgba(255,255,255,0.65)"/>
    <circle cx="28" cy="20.6" r="0.5" fill="rgba(255,255,255,0.65)"/>
    <path d="M15 20 Q16 21 15.5 22" fill="none" stroke="var(--av-skin,#A07850)" stroke-width="0.6" opacity="0.3"/>
    <path d="M23 23 Q24 24.5 25 23" fill="none" stroke="rgba(0,0,0,0.25)" stroke-width="0.8"/>
    <path d="M21 26 Q24 26.8 27 26" fill="none" stroke="#7A5030" stroke-width="1"/>
    <circle cx="24" cy="40" r="2.5" fill="none" stroke="var(--av-accessory,#B8976A)" stroke-width="0.8" opacity="0.6"/>
    <line x1="24" y1="37.5" x2="24" y2="42.5" stroke="var(--av-accessory,#B8976A)" stroke-width="0.6" opacity="0.6"/>
    <line x1="21.5" y1="40" x2="26.5" y2="40" stroke="var(--av-accessory,#B8976A)" stroke-width="0.6" opacity="0.6"/>
  `
}

const RENAISSANCE_ALCHEMIST: AvatarDefinition = {
  key: 'renaissance-alchemist',
  label: 'The Alchemist',
  category: 'renaissance',
  defaultColor: '#D4A843',
  bgColor: BG.amber,
  palette: { skin: '#B8906A', hair: '#0A0604', clothing: '#3A2A08', accessory: '#D4A843', eyes: '#4A3A08' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#1A1208)"/>
    <circle cx="24" cy="20" r="12" fill="rgba(212,168,67,0.06)"/>
    <path d="M7 48 Q7 33 24 30 Q41 33 41 48Z" fill="var(--av-clothing,#3A2A08)"/>
    <path d="M14 20 Q12 15 14 12 Q18 8 24 8 Q30 8 34 12 Q36 15 34 20" fill="var(--av-hair,#0A0604)"/>
    <circle cx="28" cy="21" r="3" fill="none" stroke="var(--av-accessory,#D4A843)" stroke-width="0.8" opacity="0.7"/>
    <circle cx="28" cy="21" r="1.5" fill="rgba(212,168,67,0.12)"/>
    <path d="M31 21 Q33 20 34 21" fill="none" stroke="var(--av-accessory,#D4A843)" stroke-width="0.5" opacity="0.5"/>
    <rect x="21" y="27" width="6" height="5" rx="2" fill="var(--av-skin,#B8906A)"/>
    <ellipse cx="24" cy="22" rx="8.5" ry="9.5" fill="var(--av-skin,#B8906A)"/>
    <path d="M15.5 18 Q14 14 15 11 Q18 9 24 9 Q30 9 33 11 Q34 14 32.5 18" fill="var(--av-hair,#0A0604)"/>
    <ellipse cx="20" cy="22" rx="1.8" ry="1.4" fill="#0A0602"/>
    <circle cx="20.5" cy="21.5" r="0.5" fill="rgba(255,255,255,0.65)"/>
    <ellipse cx="28" cy="21" rx="1.4" ry="1.2" fill="#0A0602"/>
    <path d="M23 24 L23.5 26 L25 24" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="0.7"/>
    <path d="M21 27.5 Q24 28.2 26.5 27.5" fill="none" stroke="#6A3A1A" stroke-width="0.8"/>
    <ellipse cx="11" cy="41" rx="2.5" ry="3.5" fill="rgba(212,168,67,0.2)" stroke="var(--av-accessory,#D4A843)" stroke-width="0.6"/>
    <ellipse cx="11" cy="37.5" rx="1.2" ry="1" fill="rgba(212,168,67,0.3)" stroke="var(--av-accessory,#D4A843)" stroke-width="0.5"/>
  `
}

const RENAISSANCE_NOBLEWOMAN: AvatarDefinition = {
  key: 'renaissance-noblewoman',
  label: 'The Noblewoman',
  category: 'renaissance',
  defaultColor: '#C87A9B',
  bgColor: BG.plum,
  palette: { skin: '#D4A882', hair: '#1A0808', clothing: '#4A1A38', accessory: '#D4C8B0', eyes: '#3A1A2A' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#1A0814)"/>
    <path d="M6 48 Q6 33 24 30 Q42 33 42 48Z" fill="var(--av-clothing,#4A1A38)"/>
    <path d="M13 31 Q24 36 35 31 Q33 35 24 36 Q15 35 13 31Z" fill="var(--av-accessory,#D4C8B0)" opacity="0.7"/>
    <circle cx="18" cy="33" r="1" fill="var(--av-accessory,#D4C8B0)" opacity="0.8"/>
    <circle cx="20.5" cy="34" r="1" fill="var(--av-accessory,#D4C8B0)" opacity="0.8"/>
    <circle cx="23.5" cy="34.5" r="1" fill="var(--av-accessory,#D4C8B0)" opacity="0.8"/>
    <circle cx="26.5" cy="34" r="1" fill="var(--av-accessory,#D4C8B0)" opacity="0.8"/>
    <circle cx="29" cy="33" r="1" fill="var(--av-accessory,#D4C8B0)" opacity="0.8"/>
    <rect x="21" y="27" width="6" height="5" rx="2" fill="var(--av-skin,#D4A882)"/>
    <ellipse cx="24" cy="21" rx="9" ry="10" fill="var(--av-skin,#D4A882)"/>
    <ellipse cx="24" cy="12" rx="9.5" ry="5" fill="var(--av-hair,#1A0808)"/>
    <path d="M15 17 Q14 13 15.5 11 Q19 9 24 9 Q29 9 32.5 11 Q34 13 33 17" fill="var(--av-hair,#1A0808)"/>
    <circle cx="24" cy="10" r="2.5" fill="none" stroke="var(--av-accessory,#D4C8B0)" stroke-width="0.8" opacity="0.7"/>
    <circle cx="24" cy="10" r="1" fill="var(--av-accessory,#D4C8B0)" opacity="0.7"/>
    <path d="M18 18.5 Q20.5 17.5 22 18.5" fill="none" stroke="var(--av-hair,#1A0808)" stroke-width="0.9" opacity="0.7"/>
    <path d="M26 18.5 Q27.5 17.5 30 18.5" fill="none" stroke="var(--av-hair,#1A0808)" stroke-width="0.9" opacity="0.7"/>
    <ellipse cx="20.5" cy="21" rx="1.8" ry="1.3" fill="#0A0404"/>
    <ellipse cx="27.5" cy="21" rx="1.8" ry="1.3" fill="#0A0404"/>
    <circle cx="21.1" cy="20.5" r="0.55" fill="rgba(255,255,255,0.7)"/>
    <circle cx="28.1" cy="20.5" r="0.55" fill="rgba(255,255,255,0.7)"/>
    <ellipse cx="18" cy="23.5" rx="2.5" ry="1.2" fill="#D4A882" opacity="0.2"/>
    <ellipse cx="30" cy="23.5" rx="2.5" ry="1.2" fill="#D4A882" opacity="0.2"/>
    <path d="M23.2 23 Q24 24.3 24.8 23" fill="none" stroke="rgba(0,0,0,0.15)" stroke-width="0.7"/>
    <path d="M21.5 26 Q24 27 26.5 26" fill="none" stroke="#8A5A4A" stroke-width="0.9"/>
  `
}

const RENAISSANCE_KNIGHT: AvatarDefinition = {
  key: 'renaissance-knight',
  label: 'The Knight',
  category: 'renaissance',
  defaultColor: '#6B9EC4',
  bgColor: BG.teal,
  palette: { skin: '#A87850', hair: '#0E0A06', clothing: '#2A3A3A', accessory: '#8A9A9E', eyes: '#1A2A2A' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#0A1212)"/>
    <path d="M8 48 Q8 34 24 31 Q40 34 40 48Z" fill="var(--av-clothing,#2A3A3A)"/>
    <path d="M15 33 Q24 36 33 33" fill="none" stroke="var(--av-accessory,#8A9A9E)" stroke-width="0.5" stroke-dasharray="1.5 1" opacity="0.6"/>
    <path d="M15 34.5 Q24 37.5 33 34.5" fill="none" stroke="var(--av-accessory,#8A9A9E)" stroke-width="0.4" stroke-dasharray="1.5 1" opacity="0.4"/>
    <path d="M22 34 L24 32 L26 34 L25 36 L23 36Z" fill="var(--av-accessory,#8A9A9E)" opacity="0.6"/>
    <rect x="21" y="27" width="6" height="6" rx="2" fill="var(--av-skin,#A87850)"/>
    <ellipse cx="24" cy="21" rx="9.5" ry="10" fill="var(--av-skin,#A87850)"/>
    <ellipse cx="24" cy="12.5" rx="9.5" ry="4.5" fill="var(--av-hair,#0E0A06)"/>
    <rect x="14.5" y="12" width="19" height="5" rx="2" fill="var(--av-hair,#0E0A06)"/>
    <path d="M17 18.5 Q20 17 22.5 18.5" fill="none" stroke="var(--av-hair,#0E0A06)" stroke-width="1.5"/>
    <path d="M25.5 18.5 Q28 17 31 18.5" fill="none" stroke="var(--av-hair,#0E0A06)" stroke-width="1.5"/>
    <ellipse cx="20.5" cy="21" rx="1.8" ry="1.3" fill="#060404"/>
    <ellipse cx="27.5" cy="21" rx="1.8" ry="1.3" fill="#060404"/>
    <circle cx="21" cy="20.6" r="0.5" fill="rgba(255,255,255,0.6)"/>
    <circle cx="28" cy="20.6" r="0.5" fill="rgba(255,255,255,0.6)"/>
    <path d="M15 24 Q15.5 28 24 30 Q32.5 28 33 24" fill="none" stroke="var(--av-skin,#A87850)" stroke-width="0.5" opacity="0.3"/>
    <line x1="24" y1="23" x2="24" y2="25.5" stroke="rgba(0,0,0,0.15)" stroke-width="0.7"/>
    <path d="M21 26.5 Q24 27 27 26.5" fill="none" stroke="#7A4A2A" stroke-width="1"/>
    <line x1="30" y1="21" x2="31.5" y2="24" stroke="rgba(0,0,0,0.2)" stroke-width="0.6"/>
  `
}

const RENAISSANCE_SCRIBE: AvatarDefinition = {
  key: 'renaissance-scribe',
  label: 'The Scribe',
  category: 'renaissance',
  defaultColor: '#C87A9B',
  bgColor: BG.rust,
  palette: { skin: '#C9A07A', hair: '#2A1A0E', clothing: '#3A1A10', accessory: '#B8976A', eyes: '#2A1A10' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#140A0A)"/>
    <path d="M9 48 Q9 35 24 32 Q39 35 39 48Z" fill="var(--av-clothing,#3A1A10)"/>
    <path d="M12 38 Q24 40 36 38" fill="none" stroke="var(--av-accessory,#B8976A)" stroke-width="1" opacity="0.4"/>
    <ellipse cx="37" cy="43" rx="2" ry="1.5" fill="#0A0808" opacity="0.4"/>
    <rect x="21" y="27" width="6" height="7" rx="2" fill="var(--av-skin,#C9A07A)"/>
    <ellipse cx="24" cy="21" rx="8.5" ry="9.5" fill="var(--av-skin,#C9A07A)"/>
    <ellipse cx="24" cy="12" rx="8.5" ry="5" fill="var(--av-hair,#2A1A0E)"/>
    <path d="M15.5 16.5 Q14 13 15.5 11 Q19 9.5 24 9.5 Q29 9.5 32.5 11 Q34 13 32.5 16.5" fill="var(--av-hair,#2A1A0E)"/>
    <path d="M24 11 Q26 14 27 17" fill="none" stroke="var(--av-hair,#2A1A0E)" stroke-width="1.5"/>
    <ellipse cx="20.5" cy="21" rx="1.8" ry="1.5" fill="#0A0604"/>
    <ellipse cx="27.5" cy="21" rx="1.8" ry="1.5" fill="#0A0604"/>
    <circle cx="21.1" cy="20.5" r="0.6" fill="rgba(255,255,255,0.75)"/>
    <circle cx="28.1" cy="20.5" r="0.6" fill="rgba(255,255,255,0.75)"/>
    <ellipse cx="17" cy="23" rx="1.5" ry="0.7" fill="#0A0808" opacity="0.2"/>
    <path d="M23 23 Q24 24.5 25 23" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="0.8"/>
    <path d="M21.5 26 Q24 26.8 26.5 26" fill="none" stroke="#7A4A2A" stroke-width="0.9"/>
    <rect x="8" y="38" width="5" height="7" rx="1" fill="var(--av-accessory,#B8976A)" opacity="0.3"/>
    <line x1="8" y1="40" x2="13" y2="40" stroke="var(--av-accessory,#B8976A)" stroke-width="0.5" opacity="0.5"/>
    <line x1="8" y1="42" x2="13" y2="42" stroke="var(--av-accessory,#B8976A)" stroke-width="0.5" opacity="0.5"/>
  `
}

const RENAISSANCE_ARCHITECT: AvatarDefinition = {
  key: 'renaissance-architect',
  label: 'The Architect',
  category: 'renaissance',
  defaultColor: '#7ABFDB',
  bgColor: BG.slate,
  palette: { skin: '#B8906A', hair: '#1A1408', clothing: '#1A2A38', accessory: '#B8976A', eyes: '#1A2838' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#0E1518)"/>
    <path d="M8 48 Q8 34 24 31 Q40 34 40 48Z" fill="var(--av-clothing,#1A2A38)"/>
    <line x1="13" y1="39" x2="18" y2="39" stroke="var(--av-accessory,#B8976A)" stroke-width="0.8" opacity="0.5"/>
    <rect x="21" y="27" width="6" height="6" rx="2" fill="var(--av-skin,#B8906A)"/>
    <ellipse cx="24" cy="21" rx="9" ry="10" fill="var(--av-skin,#B8906A)"/>
    <ellipse cx="24" cy="12.5" rx="9" ry="4.5" fill="var(--av-hair,#1A1408)"/>
    <path d="M15 17 Q14 13 15 11 Q19 9.5 24 9.5 Q29 9.5 33 11 Q34 13 33 17" fill="var(--av-hair,#1A1408)"/>
    <line x1="24" y1="10" x2="22" y2="14" stroke="var(--av-skin,#B8906A)" stroke-width="0.6" opacity="0.4"/>
    <ellipse cx="20.5" cy="21" rx="1.7" ry="1.3" fill="#0A0806"/>
    <ellipse cx="27.5" cy="21" rx="1.7" ry="1.3" fill="#0A0806"/>
    <circle cx="21" cy="20.6" r="0.55" fill="rgba(255,255,255,0.65)"/>
    <circle cx="28" cy="20.6" r="0.55" fill="rgba(255,255,255,0.65)"/>
    <path d="M23 23 Q24 24.5 25 23" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="0.8"/>
    <path d="M21.5 26.5 Q24 27.2 26.5 26.5" fill="none" stroke="#7A4A28" stroke-width="0.9"/>
    <line x1="34" y1="30" x2="34" y2="42" stroke="var(--av-accessory,#B8976A)" stroke-width="1" opacity="0.4"/>
    <line x1="31" y1="30" x2="37" y2="30" stroke="var(--av-accessory,#B8976A)" stroke-width="1" opacity="0.4"/>
  `
}

const RENAISSANCE_HERBALIST: AvatarDefinition = {
  key: 'renaissance-herbalist',
  label: 'The Herbalist',
  category: 'renaissance',
  defaultColor: '#5DB88A',
  bgColor: BG.green,
  palette: { skin: '#C8A07A', hair: '#2A1A10', clothing: '#1A3020', accessory: '#5DB88A', eyes: '#1A3018' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#0A1610)"/>
    <path d="M8 48 Q8 34 24 31 Q40 34 40 48Z" fill="var(--av-clothing,#1A3020)"/>
    <circle cx="24" cy="33" r="2.5" fill="none" stroke="var(--av-accessory,#5DB88A)" stroke-width="0.8" opacity="0.7"/>
    <circle cx="24" cy="33" r="1" fill="var(--av-accessory,#5DB88A)" opacity="0.6"/>
    <path d="M16 32 Q15 30 17 29" fill="none" stroke="var(--av-accessory,#5DB88A)" stroke-width="0.8" opacity="0.5"/>
    <circle cx="16.5" cy="29" r="1.2" fill="var(--av-accessory,#5DB88A)" opacity="0.4"/>
    <rect x="21" y="27" width="6" height="6" rx="2" fill="var(--av-skin,#C8A07A)"/>
    <ellipse cx="24" cy="21" rx="9" ry="10" fill="var(--av-skin,#C8A07A)"/>
    <ellipse cx="24" cy="12" rx="9" ry="5" fill="var(--av-hair,#2A1A10)"/>
    <path d="M15 17 Q14 13 15.5 11 Q19 9.5 24 9.5 Q29 9.5 32.5 11 Q34 13 33 17" fill="var(--av-hair,#2A1A10)"/>
    <path d="M14.5 20 Q13.5 17 15.5 16" fill="none" stroke="var(--av-hair,#2A1A10)" stroke-width="2"/>
    <path d="M33.5 20 Q34.5 17 32.5 16" fill="none" stroke="var(--av-hair,#2A1A10)" stroke-width="2"/>
    <ellipse cx="20.5" cy="21" rx="1.8" ry="1.4" fill="#0A0604"/>
    <ellipse cx="27.5" cy="21" rx="1.8" ry="1.4" fill="#0A0604"/>
    <circle cx="21.1" cy="20.5" r="0.55" fill="rgba(255,255,255,0.7)"/>
    <circle cx="28.1" cy="20.5" r="0.55" fill="rgba(255,255,255,0.7)"/>
    <path d="M29 23.5 Q30 24 29.5 24.5" fill="none" stroke="var(--av-skin,#C8A07A)" stroke-width="0.5" opacity="0.4"/>
    <path d="M23 23 Q24 24.5 25 23" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="0.8"/>
    <path d="M21 26 Q24 27.8 27 26" fill="none" stroke="#7A4A28" stroke-width="1.1"/>
  `
}

const RENAISSANCE_JESTER: AvatarDefinition = {
  key: 'renaissance-jester',
  label: 'The Jester',
  category: 'character',
  defaultColor: '#D49353',
  bgColor: BG.sienna,
  palette: { skin: '#D4A07A', hair: '#1A0E06', clothing: '#4A2A08', accessory: '#D49353', eyes: '#3A1A08' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#1A0E08)"/>
    <path d="M10 48 Q10 35 24 32 Q38 35 38 48Z" fill="var(--av-clothing,#4A2A08)"/>
    <path d="M14 35 Q16 32 20 34 Q18 37 14 35Z" fill="#C4714A" opacity="0.7"/>
    <path d="M20 34 Q24 31.5 28 34 Q26 37 22 36.5 Q20 36 20 34Z" fill="var(--av-accessory,#D49353)" opacity="0.7"/>
    <path d="M28 34 Q32 32 34 35 Q31 37 28 34Z" fill="#5DB88A" opacity="0.6"/>
    <circle cx="15" cy="36" r="1.5" fill="var(--av-accessory,#D49353)" opacity="0.7"/>
    <circle cx="24" cy="37" r="1.5" fill="var(--av-accessory,#D49353)" opacity="0.7"/>
    <circle cx="33" cy="36" r="1.5" fill="var(--av-accessory,#D49353)" opacity="0.7"/>
    <rect x="21" y="27" width="6" height="6" rx="2" fill="var(--av-skin,#D4A07A)"/>
    <ellipse cx="24" cy="21" rx="9" ry="10" fill="var(--av-skin,#D4A07A)"/>
    <path d="M24 12 Q17 6 14 10 Q20 12 20 16" fill="var(--av-clothing,#4A2A08)"/>
    <path d="M24 12 Q31 6 34 10 Q28 12 28 16" fill="var(--av-accessory,#D49353)"/>
    <circle cx="14" cy="10" r="2" fill="var(--av-accessory,#D49353)" opacity="0.8"/>
    <circle cx="34" cy="10" r="2" fill="var(--av-clothing,#4A2A08)" opacity="0.8"/>
    <path d="M17.5 18 Q20 16.5 22.5 18" fill="none" stroke="var(--av-hair,#1A0E06)" stroke-width="1.2"/>
    <path d="M25.5 18 Q28 16.5 30.5 18" fill="none" stroke="var(--av-hair,#1A0E06)" stroke-width="1.2"/>
    <ellipse cx="20.5" cy="21" rx="1.8" ry="1.6" fill="#0A0604"/>
    <ellipse cx="27.5" cy="21" rx="1.8" ry="1.6" fill="#0A0604"/>
    <circle cx="21.2" cy="20.4" r="0.65" fill="rgba(255,255,255,0.8)"/>
    <circle cx="28.2" cy="20.4" r="0.65" fill="rgba(255,255,255,0.8)"/>
    <circle cx="24" cy="24" r="1.8" fill="#C4714A" opacity="0.6"/>
    <path d="M19.5 27 Q24 29.5 28.5 27 Q27 30 24 30.5 Q21 30 19.5 27Z" fill="#7A2A1A" opacity="0.8"/>
    <path d="M21 27.5 Q24 29 27 27.5" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="0.6"/>
  `
}

const RENAISSANCE_BLACKSMITH: AvatarDefinition = {
  key: 'renaissance-blacksmith',
  label: 'The Blacksmith',
  category: 'character',
  defaultColor: '#D49353',
  bgColor: BG.sepia,
  palette: { skin: '#A06840', hair: '#0A0604', clothing: '#2A1A0A', accessory: '#8A6A3A', eyes: '#2A1808' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#0E0A06)"/>
    <circle cx="24" cy="40" r="10" fill="rgba(196,113,74,0.08)"/>
    <path d="M8 48 Q8 33 24 30 Q40 33 40 48Z" fill="var(--av-clothing,#2A1A0A)"/>
    <line x1="24" y1="30" x2="20" y2="36" stroke="var(--av-accessory,#8A6A3A)" stroke-width="1.5" opacity="0.6"/>
    <line x1="24" y1="30" x2="28" y2="36" stroke="var(--av-accessory,#8A6A3A)" stroke-width="1.5" opacity="0.6"/>
    <ellipse cx="18" cy="40" rx="2" ry="1.5" fill="#0A0604" opacity="0.4"/>
    <ellipse cx="30" cy="42" rx="1.5" ry="1" fill="#0A0604" opacity="0.3"/>
    <rect x="21" y="26" width="6" height="6" rx="2" fill="var(--av-skin,#A06840)"/>
    <ellipse cx="24" cy="21" rx="10" ry="10.5" fill="var(--av-skin,#A06840)"/>
    <ellipse cx="24" cy="12" rx="10" ry="4.5" fill="var(--av-hair,#0A0604)"/>
    <path d="M14 17 Q13 13 14.5 11 Q18 9 24 9 Q30 9 33.5 11 Q35 13 34 17" fill="var(--av-hair,#0A0604)"/>
    <path d="M15 24 Q14 28 17 31 Q20.5 33 24 33 Q27.5 33 31 31 Q34 28 33 24" fill="var(--av-hair,#0A0604)" opacity="0.8"/>
    <ellipse cx="20" cy="21" rx="1.8" ry="1.4" fill="#060402"/>
    <ellipse cx="28" cy="21" rx="1.8" ry="1.4" fill="#060402"/>
    <circle cx="20.5" cy="20.5" r="0.5" fill="rgba(255,255,255,0.55)"/>
    <circle cx="28.5" cy="20.5" r="0.5" fill="rgba(255,255,255,0.55)"/>
    <path d="M17 18 Q20 16.5 22 18" fill="none" stroke="var(--av-hair,#0A0604)" stroke-width="1.8"/>
    <path d="M26 18 Q28 16.5 31 18" fill="none" stroke="var(--av-hair,#0A0604)" stroke-width="1.8"/>
    <path d="M22.5 23 Q24 25 25.5 23" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="1"/>
    <path d="M21 26 Q24 27 27 26" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="0.8"/>
  `
}

const RENAISSANCE_ASTRONOMER: AvatarDefinition = {
  key: 'renaissance-astronomer',
  label: 'The Astronomer',
  category: 'character',
  defaultColor: '#6B9EC4',
  bgColor: BG.midnight,
  palette: { skin: '#C4A07A', hair: '#1A1A2A', clothing: '#0E1428', accessory: '#B8976A', eyes: '#1A1A3A' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#080810)"/>
    <circle cx="8" cy="10" r="0.8" fill="var(--av-accessory,#B8976A)" opacity="0.5"/>
    <circle cx="38" cy="8" r="0.6" fill="var(--av-accessory,#B8976A)" opacity="0.4"/>
    <circle cx="42" cy="20" r="0.7" fill="var(--av-accessory,#B8976A)" opacity="0.35"/>
    <circle cx="6" cy="30" r="0.5" fill="var(--av-accessory,#B8976A)" opacity="0.3"/>
    <circle cx="40" cy="35" r="0.8" fill="var(--av-accessory,#B8976A)" opacity="0.3"/>
    <path d="M7 48 Q7 33 24 30 Q41 33 41 48Z" fill="var(--av-clothing,#0E1428)"/>
    <circle cx="24" cy="36" r="3" fill="none" stroke="var(--av-accessory,#B8976A)" stroke-width="0.8" opacity="0.6"/>
    <circle cx="24" cy="36" r="1.2" fill="var(--av-accessory,#B8976A)" opacity="0.4"/>
    <line x1="24" y1="33" x2="24" y2="39" stroke="var(--av-accessory,#B8976A)" stroke-width="0.6" opacity="0.5"/>
    <line x1="21" y1="36" x2="27" y2="36" stroke="var(--av-accessory,#B8976A)" stroke-width="0.6" opacity="0.5"/>
    <rect x="21" y="27" width="6" height="6" rx="2" fill="var(--av-skin,#C4A07A)"/>
    <ellipse cx="24" cy="21" rx="9" ry="10" fill="var(--av-skin,#C4A07A)"/>
    <ellipse cx="24" cy="12" rx="9" ry="5" fill="var(--av-hair,#1A1A2A)"/>
    <path d="M15 17 Q14 13 15.5 11 Q19 9.5 24 9.5 Q29 9.5 32.5 11 Q34 13 33 17" fill="var(--av-hair,#1A1A2A)"/>
    <line x1="26" y1="10" x2="25" y2="16" stroke="rgba(200,184,154,0.5)" stroke-width="1.2"/>
    <ellipse cx="20.5" cy="21" rx="1.8" ry="1.5" fill="#080608"/>
    <ellipse cx="27.5" cy="21" rx="1.8" ry="1.5" fill="#080608"/>
    <circle cx="21.3" cy="20.3" r="0.65" fill="rgba(255,255,255,0.75)"/>
    <circle cx="28.3" cy="20.3" r="0.65" fill="rgba(255,255,255,0.75)"/>
    <path d="M23 23 Q24 24.5 25 23" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="0.8"/>
    <path d="M21.5 26 Q24 27 26.5 26" fill="none" stroke="#7A4A28" stroke-width="0.9"/>
    <ellipse cx="24" cy="26.8" rx="1.5" ry="0.7" fill="#5A2A18" opacity="0.4"/>
  `
}

const RENAISSANCE_DIPLOMAT: AvatarDefinition = {
  key: 'renaissance-diplomat',
  label: 'The Diplomat',
  category: 'renaissance',
  defaultColor: '#8A9A9E',
  bgColor: BG.charcoal,
  palette: { skin: '#BF9070', hair: '#1A1810', clothing: '#1A2228', accessory: '#B8976A', eyes: '#1A1A1A' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#0A0F14)"/>
    <path d="M8 48 Q8 34 24 31 Q40 34 40 48Z" fill="var(--av-clothing,#1A2228)"/>
    <path d="M16 32 L20 30 L24 31 L28 30 L32 32 Q30 36 24 37 Q18 36 16 32Z" fill="var(--av-clothing,#1A2228)" stroke="var(--av-accessory,#B8976A)" stroke-width="0.7" opacity="0.7"/>
    <circle cx="24" cy="34" r="2.5" fill="var(--av-accessory,#B8976A)" opacity="0.5"/>
    <path d="M22 34 L24 32 L26 34 L24 36Z" fill="var(--av-accessory,#B8976A)" opacity="0.8"/>
    <rect x="21" y="27" width="6" height="6" rx="2" fill="var(--av-skin,#BF9070)"/>
    <ellipse cx="24" cy="21" rx="9" ry="10" fill="var(--av-skin,#BF9070)"/>
    <ellipse cx="24" cy="12.5" rx="9" ry="4" fill="var(--av-hair,#1A1810)"/>
    <path d="M15 17 Q14 13 16 11 Q20 9.5 24 9.5 Q28 9.5 32 11 Q34 13 33 17" fill="var(--av-hair,#1A1810)"/>
    <ellipse cx="17" cy="17" rx="3" ry="4" fill="var(--av-skin,#BF9070)" opacity="0.4"/>
    <ellipse cx="31" cy="17" rx="3" ry="4" fill="var(--av-skin,#BF9070)" opacity="0.4"/>
    <ellipse cx="20.5" cy="21" rx="1.7" ry="1.3" fill="#0A0806"/>
    <ellipse cx="27.5" cy="21" rx="1.7" ry="1.3" fill="#0A0806"/>
    <circle cx="21" cy="20.6" r="0.5" fill="rgba(255,255,255,0.6)"/>
    <circle cx="28" cy="20.6" r="0.5" fill="rgba(255,255,255,0.6)"/>
    <path d="M20.5 25.5 Q22.5 26.5 24 26 Q25.5 26.5 27.5 25.5" fill="var(--av-hair,#1A1810)" opacity="0.7"/>
    <line x1="24" y1="23" x2="24" y2="25" stroke="rgba(0,0,0,0.15)" stroke-width="0.8"/>
    <path d="M21.5 27 Q24 27.5 26.5 27" fill="none" stroke="#6A3A1A" stroke-width="0.9"/>
  `
}

const RENAISSANCE_POET: AvatarDefinition = {
  key: 'renaissance-poet',
  label: 'The Poet',
  category: 'renaissance',
  defaultColor: '#D49353',
  bgColor: BG.warmSepia,
  palette: { skin: '#C8A07A', hair: '#2A1A0A', clothing: '#3A2010', accessory: '#B8976A', eyes: '#2A1A0A' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#16100A)"/>
    <path d="M8 48 Q8 34 24 31 Q40 34 40 48Z" fill="var(--av-clothing,#3A2010)"/>
    <path d="M19 32 Q24 34 29 32 Q27 30 24 30 Q21 30 19 32Z" fill="rgba(184,151,106,0.15)" stroke="var(--av-accessory,#B8976A)" stroke-width="0.5" opacity="0.5"/>
    <line x1="35" y1="30" x2="38" y2="26" stroke="var(--av-accessory,#B8976A)" stroke-width="0.8" opacity="0.5"/>
    <path d="M38 26 Q39.5 24 38.5 25.5 Q40 25 39 26.5" fill="var(--av-accessory,#B8976A)" opacity="0.4"/>
    <rect x="21" y="27" width="6" height="6" rx="2" fill="var(--av-skin,#C8A07A)"/>
    <ellipse cx="23.5" cy="21" rx="9" ry="10" fill="var(--av-skin,#C8A07A)"/>
    <ellipse cx="23.5" cy="12" rx="9.5" ry="5.5" fill="var(--av-hair,#2A1A0A)"/>
    <path d="M14 17 Q12 13 14 11 Q18 9 23.5 9 Q29 9 32.5 11 Q34 13 33 17" fill="var(--av-hair,#2A1A0A)"/>
    <path d="M13.5 20 Q12.5 17 14 16" fill="none" stroke="var(--av-hair,#2A1A0A)" stroke-width="2.5"/>
    <path d="M14 23 Q13 21 14 19" fill="none" stroke="var(--av-hair,#2A1A0A)" stroke-width="2"/>
    <ellipse cx="20" cy="21" rx="1.8" ry="1.5" fill="#0A0604"/>
    <ellipse cx="27" cy="21" rx="1.8" ry="1.5" fill="#0A0604"/>
    <circle cx="20.7" cy="20.4" r="0.65" fill="rgba(255,255,255,0.72)"/>
    <circle cx="27.7" cy="20.4" r="0.65" fill="rgba(255,255,255,0.72)"/>
    <path d="M22.5 23 Q23.5 24.5 24.5 23" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="0.8"/>
    <path d="M21 26.5 Q23.5 27.5 26 26.5" fill="none" stroke="#8A4A2A" stroke-width="1"/>
    <ellipse cx="23.5" cy="27.2" rx="1.5" ry="0.6" fill="#6A2A18" opacity="0.35"/>
  `
}

const RENAISSANCE_EXPLORER: AvatarDefinition = {
  key: 'renaissance-explorer',
  label: 'The Explorer',
  category: 'renaissance',
  defaultColor: '#5BB8A8',
  bgColor: BG.hunter,
  palette: { skin: '#A87040', hair: '#1A0E06', clothing: '#1A3020', accessory: '#B8976A', eyes: '#1A2A18' },
  svgContent: `
    <rect width="48" height="48" rx="24" fill="var(--av-bg,#0A1410)"/>
    <path d="M8 48 Q8 34 24 31 Q40 34 40 48Z" fill="var(--av-clothing,#1A3020)"/>
    <line x1="14" y1="31" x2="20" y2="42" stroke="var(--av-accessory,#B8976A)" stroke-width="1.2" opacity="0.5"/>
    <rect x="10" y="40" width="8" height="6" rx="1.5" fill="var(--av-clothing,#1A3020)" stroke="var(--av-accessory,#B8976A)" stroke-width="0.6" opacity="0.5"/>
    <line x1="10" y1="43" x2="18" y2="43" stroke="var(--av-accessory,#B8976A)" stroke-width="0.5" opacity="0.4"/>
    <path d="M16 40 Q18 38 18 40" fill="rgba(184,151,106,0.3)"/>
    <rect x="21" y="27" width="6" height="6" rx="2" fill="var(--av-skin,#A87040)"/>
    <ellipse cx="24" cy="21" rx="9.5" ry="10" fill="var(--av-skin,#A87040)"/>
    <ellipse cx="24" cy="12" rx="9.5" ry="5" fill="var(--av-hair,#1A0E06)"/>
    <path d="M14.5 17 Q13 13 14.5 11 Q18.5 9 24 9 Q29.5 9 33.5 11 Q35 13 33.5 17" fill="var(--av-hair,#1A0E06)"/>
    <path d="M32 14 Q36 11 37 13" fill="none" stroke="var(--av-hair,#1A0E06)" stroke-width="1.8"/>
    <ellipse cx="20.5" cy="21" rx="1.8" ry="1.2" fill="#0A0604"/>
    <ellipse cx="27.5" cy="21" rx="1.8" ry="1.2" fill="#0A0604"/>
    <circle cx="21" cy="20.6" r="0.55" fill="rgba(255,255,255,0.65)"/>
    <circle cx="28" cy="20.6" r="0.55" fill="rgba(255,255,255,0.65)"/>
    <path d="M15 20 Q16 21 15.5 22.5" fill="none" stroke="var(--av-skin,#A87040)" stroke-width="0.6" opacity="0.35"/>
    <path d="M33 20 Q32 21 32.5 22.5" fill="none" stroke="var(--av-skin,#A87040)" stroke-width="0.6" opacity="0.35"/>
    <path d="M22.5 23 Q24 25 25.5 23" fill="none" stroke="rgba(0,0,0,0.2)" stroke-width="0.9"/>
    <path d="M20.5 26.5 Q24 28.5 27.5 26.5" fill="none" stroke="#7A3A18" stroke-width="1.1"/>
  `
}

// ─── Library exports ──────────────────────────────────────────────────────────

export const AVATAR_LIBRARY: AvatarDefinition[] = [
  RENAISSANCE_SCHOLAR,
  RENAISSANCE_MERCHANT,
  RENAISSANCE_PAINTER,
  RENAISSANCE_NAVIGATOR,
  RENAISSANCE_ALCHEMIST,
  RENAISSANCE_NOBLEWOMAN,
  RENAISSANCE_KNIGHT,
  RENAISSANCE_SCRIBE,
  RENAISSANCE_ARCHITECT,
  RENAISSANCE_HERBALIST,
  RENAISSANCE_JESTER,
  RENAISSANCE_BLACKSMITH,
  RENAISSANCE_ASTRONOMER,
  RENAISSANCE_DIPLOMAT,
  RENAISSANCE_POET,
  RENAISSANCE_EXPLORER
]

export const AVATAR_MAP: Record<string, AvatarDefinition> = Object.fromEntries(
  AVATAR_LIBRARY.map((a) => [a.key, a])
)

/** Default avatar key used when no explicit choice has been made */
export const DEFAULT_AVATAR_KEY = 'renaissance-scholar'
