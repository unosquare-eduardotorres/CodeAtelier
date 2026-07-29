// ── Timing ──
export const TRANSITION_MIN_DURATION = 800   // ms — minimum before early exit allowed
export const TRANSITION_MAX_DURATION = 2000  // ms — hard cap, never exceed
export const GLASS_DURATION = 1200           // ms — glass panels target
export const PARTICLE_DURATION = 1800        // ms — gold particles target (first-open only)

// ── Colors (from Code Atelier theme) ──
export const COLORS = {
  atelierGold:    0xb8976a,
  brightGold:     0xc8b89a,
  mutedGold:      0x8b6f4a,
  jewelCopper:    0xc4714a,
  tealAccent:     0x6dc4b2,
  deepTeal:       0x1f6b5e,
  obsidian:       0x010208,
  surfaceBase:    0x111a1e,
  surfaceRaised:  0x182428,
  surfaceOverlay: 0x1e2c31,
} as const

// ── Easing (matches --ease-out: cubic-bezier(0.16, 1, 0.3, 1)) ──
export function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3) * Math.cos(t * Math.PI * 0.5)
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

// ── Persistence keys ──
export const STORAGE_KEY_PREFIX = 'ca:transition:seen:'

// ── Adaptive quality ──
export const PARTICLE_COUNT_HIGH = 1500
export const PARTICLE_COUNT_LOW = 500
export const FRAME_TIME_THRESHOLD = 32  // ms — if first frame > this, reduce quality
