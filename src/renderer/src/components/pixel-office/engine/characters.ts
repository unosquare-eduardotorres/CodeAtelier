// Adapted from pixel-agents: webview-ui/src/office/engine/characters.ts
// Animation FSM (IDLE/TYPE/WALK), character creation, sprite selection.

import {
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN
} from '../constants'
import type { CharacterSprites } from '../sprites/spriteData'
import type { Character, Seat, SpriteData, TileType as TileTypeVal } from './types'
import { CharacterState, Direction, TILE_SIZE } from './types'
import { handleTypeState } from './characterStates/typeState'
import { handleIdleState } from './characterStates/idleState'
import { handleWalkState } from './characterStates/walkState'

/** Tools that show reading animation instead of typing */
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])

export function isReadingTool(tool: string | null): boolean {
  if (!tool) return false
  return READING_TOOLS.has(tool)
}

/** Pixel center of a tile */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2
  }
}

export function createCharacter(
  id: number,
  palette: number,
  seatId: string | null,
  seat: Seat | null,
  hueShift = 0
): Character {
  const col = seat ? seat.seatCol : 1
  const row = seat ? seat.seatRow : 1
  const center = tileCenter(col, row)
  return {
    id,
    state: CharacterState.TYPE,
    dir: seat ? seat.facingDir : Direction.DOWN,
    x: center.x,
    y: center.y,
    tileCol: col,
    tileRow: row,
    path: [],
    moveProgress: 0,
    currentTool: null,
    palette,
    hueShift,
    frame: 0,
    frameTimer: 0,
    wanderTimer: 0,
    wanderCount: 0,
    wanderLimit: randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX),
    isActive: true,
    seatId,
    bubbleType: null,
    bubbleTimer: 0,
    seatTimer: 0,
    isSubagent: false,
    parentAgentId: null,
    matrixEffect: null,
    matrixEffectTimer: 0,
    matrixEffectSeeds: [],
    currentThought: null
  }
}

/**
 * Update character state machine — thin dispatcher to per-state handlers.
 * Each state (TYPE, IDLE, WALK) is implemented in characterStates/*.ts for maintainability.
 */
export function updateCharacter(
  ch: Character,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  idleZoneTiles?: Array<{ col: number; row: number }>
): void {
  ch.frameTimer += dt

  switch (ch.state) {
    case CharacterState.TYPE:
      handleTypeState(ch, dt)
      break
    case CharacterState.IDLE:
      handleIdleState(ch, dt, walkableTiles, seats, tileMap, blockedTiles, idleZoneTiles)
      break
    case CharacterState.WALK:
      handleWalkState(ch, dt, seats, tileMap, blockedTiles)
      break
  }
}

/** Get the correct sprite frame for a character's current state and direction */
export function getCharacterSprite(ch: Character, sprites: CharacterSprites): SpriteData {
  switch (ch.state) {
    case CharacterState.TYPE:
      if (isReadingTool(ch.currentTool)) {
        return sprites.reading[ch.dir][ch.frame % 2]
      }
      return sprites.typing[ch.dir][ch.frame % 2]
    case CharacterState.WALK:
      return sprites.walk[ch.dir][ch.frame % 4]
    case CharacterState.IDLE:
      return sprites.walk[ch.dir][1]
    default:
      return sprites.walk[ch.dir][1]
  }
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}
