// ── Timing ──
export const TRANSITION_MIN_DURATION = 800   // ms — minimum before early exit allowed
export const TRANSITION_MAX_DURATION = 2000  // ms — hard cap, never exceed
export const PARTICLE_DURATION = 1800        // ms — gold particles target (first-open only)

// ── Colors ──
export const SCENE_BG = 0x010208  // obsidian — particle scene background

// ── Easing ──
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}


// ── Adaptive quality ──
export const PARTICLE_COUNT_HIGH = 4000
export const PARTICLE_COUNT_LOW = 1500
export const FRAME_TIME_THRESHOLD = 32  // ms — if first frame > this, reduce quality
