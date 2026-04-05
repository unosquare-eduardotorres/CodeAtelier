/**
 * Maps Agent Studio agents to pixel office character sprites and animations.
 *
 * 14 agents → 6 character sprites, differentiated by hue shifts.
 * Dynamic fallback for DB-backed specialists not in the static map.
 */

// ── Status → Animation mapping ──

/** @deprecated Use agent status directly. Retained for backward compat. */
export const STATUS_TO_ANIMATION: Record<string, string> = {
  idle: 'IDLE',
  thinking: 'READING',
  writing: 'TYPE',
  reviewing: 'READING',
  completed: 'IDLE',
  failed: 'IDLE'
}

/**
 * Statuses that should show a brief speech bubble on transition.
 */
export const STATUS_BUBBLES: Record<string, { text: string; durationMs: number } | undefined> = {
  completed: { text: '✓ Done', durationMs: 3000 },
  failed: { text: '✗ Error', durationMs: 5000 }
}

// ── Agent → Sprite mapping ──

interface SpriteAssignment {
  /** Index of the base character sprite (0-5) — legacy fallback */
  spriteIndex: number
  /** Hue shift in degrees (-180 to 180) for visual differentiation — legacy fallback */
  hueShift: number
  /** Pixel sprite ID from the RPG sprite catalog (preferred over spriteIndex+hueShift) */
  pixelSpriteId?: string
}

/**
 * Static sprite assignments for all 14 known agents.
 * Each agent gets a unique combination of base sprite + hue shift.
 */
export const SPRITE_ASSIGNMENTS: Record<string, SpriteAssignment> = {
  generalist: { spriteIndex: 1, hueShift: 60, pixelSpriteId: 'male-07-1' },
  coordinator: { spriteIndex: 0, hueShift: 0, pixelSpriteId: 'male-06-1' },
  'electron-architect': { spriteIndex: 4, hueShift: 160, pixelSpriteId: 'male-18-1' },
  'react-architect': { spriteIndex: 2, hueShift: 180, pixelSpriteId: 'female-07-1' },
  'dotnet-architect': { spriteIndex: 3, hueShift: 270, pixelSpriteId: 'male-03-2' },
  'ux-ui-specialist': { spriteIndex: 1, hueShift: 300, pixelSpriteId: 'female-15-1' },
  'cloud-infrastructure': { spriteIndex: 1, hueShift: 200, pixelSpriteId: 'male-10-3' },
  'agentic-architect': { spriteIndex: 5, hueShift: 30, pixelSpriteId: 'female-05-2' },
  'db-architect': { spriteIndex: 0, hueShift: 220, pixelSpriteId: 'male-15-1' },
  'git-github-specialist': { spriteIndex: 2, hueShift: 90, pixelSpriteId: 'male-01-3' },
  'requirements-specialist': { spriteIndex: 3, hueShift: 140, pixelSpriteId: 'female-09-2' },
  'code-planner': { spriteIndex: 4, hueShift: 240, pixelSpriteId: 'male-05-4' },
  'execution-planner': { spriteIndex: 5, hueShift: 120, pixelSpriteId: 'female-02-3' },
  'cicd-devops': { spriteIndex: 0, hueShift: 330, pixelSpriteId: 'male-12-1' }
}

/**
 * Default seat assignments — maps agent IDs to desk/seat indices in the default layout.
 * Index corresponds to the seat order in the office layout.
 */
export const DEFAULT_SEAT_ASSIGNMENTS: Record<string, number> = {
  coordinator: 0,
  generalist: 1,
  'react-architect': 2,
  'dotnet-architect': 3,
  'electron-architect': 4,
  'agentic-architect': 5,
  'db-architect': 6,
  'ux-ui-specialist': 7,
  'git-github-specialist': 8,
  'requirements-specialist': 9,
  'code-planner': 10,
  'execution-planner': 11,
  'cicd-devops': 12,
  'cloud-infrastructure': 13
}

// ── Dynamic assignment for unknown agents ──

/**
 * Simple string hash for consistent sprite assignment of dynamic agents.
 */
function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0 // Convert to 32bit integer
  }
  return Math.abs(hash)
}

/**
 * Convert a hex color string to a hue value (0-360).
 */
function hexToHue(hex: string): number {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.substring(0, 2), 16) / 255
  const g = parseInt(clean.substring(2, 4), 16) / 255
  const b = parseInt(clean.substring(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  if (delta === 0) return 0

  let hue: number
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4

  hue = Math.round(hue * 60)
  if (hue < 0) hue += 360

  return hue
}

/**
 * Get sprite assignment for any agent.
 * Uses static map for known agents, falls back to hash-based assignment for dynamic ones.
 */
export function getSpriteAssignment(agentId: string, color?: string): SpriteAssignment {
  // Check static assignments first
  const staticAssignment = SPRITE_ASSIGNMENTS[agentId]
  if (staticAssignment) return staticAssignment

  // Dynamic fallback: hash-based sprite index + color-derived hue
  const spriteIndex = hashString(agentId) % 6
  const hueShift = color ? hexToHue(color) : (hashString(agentId + '_hue') % 360) - 180

  return { spriteIndex, hueShift }
}

/**
 * Get the default seat index for an agent, or assign one dynamically.
 */
export function getDefaultSeatIndex(agentId: string, totalSeats: number): number {
  const staticSeat = DEFAULT_SEAT_ASSIGNMENTS[agentId]
  if (staticSeat !== undefined && staticSeat < totalSeats) return staticSeat

  // Dynamic: hash to available seat
  return hashString(agentId) % totalSeats
}
