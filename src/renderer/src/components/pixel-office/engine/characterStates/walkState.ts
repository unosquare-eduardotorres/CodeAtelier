/**
 * WALK state handler for character FSM.
 * Character is moving between tiles. Transitions to TYPE (at seat) or IDLE (wander complete).
 */
import {
  SEAT_REST_MAX_SEC,
  SEAT_REST_MIN_SEC,
  WALK_FRAME_DURATION_SEC,
  WALK_SPEED_PX_PER_SEC,
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC
} from '../../constants'
import { findPath } from '../../layout/tileMap'
import type { Character, Seat, TileType as TileTypeVal } from '../types'
import { CharacterState, Direction, TILE_SIZE } from '../types'
import { randomInt, randomRange } from '../utils'

/** Pixel center of a tile */
function tileCenter(col: number, row: number): { x: number; y: number } {
  return {
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2
  }
}

/** Direction from one tile to an adjacent tile */
function directionBetween(
  fromCol: number,
  fromRow: number,
  toCol: number,
  toRow: number
): Direction {
  const dc = toCol - fromCol
  const dr = toRow - fromRow
  if (dc > 0) return Direction.RIGHT
  if (dc < 0) return Direction.LEFT
  if (dr > 0) return Direction.DOWN
  return Direction.UP
}

export function handleWalkState(
  ch: Character,
  dt: number,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>
): void {
  // Walk animation
  if (ch.frameTimer >= WALK_FRAME_DURATION_SEC) {
    ch.frameTimer -= WALK_FRAME_DURATION_SEC
    ch.frame = (ch.frame + 1) % 4
  }

  if (ch.path.length === 0) {
    // Path complete -- snap to tile center and transition
    const center = tileCenter(ch.tileCol, ch.tileRow)
    ch.x = center.x
    ch.y = center.y

    if (ch.isActive) {
      if (!ch.seatId) {
        // No seat -- type in place
        ch.state = CharacterState.TYPE
      } else {
        const seat = seats.get(ch.seatId)
        if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
          ch.state = CharacterState.TYPE
          ch.dir = seat.facingDir
        } else {
          ch.state = CharacterState.IDLE
        }
      }
    } else {
      // Check if arrived at assigned seat -- sit down for a rest before wandering again
      if (ch.seatId) {
        const seat = seats.get(ch.seatId)
        if (seat && ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
          ch.state = CharacterState.TYPE
          ch.dir = seat.facingDir
          // seatTimer < 0 is a sentinel from setAgentActive(false) meaning
          // "turn just ended" -- skip the long rest so idle transition is immediate
          if (ch.seatTimer < 0) {
            ch.seatTimer = 0
          } else {
            ch.seatTimer = randomRange(SEAT_REST_MIN_SEC, SEAT_REST_MAX_SEC)
          }
          ch.wanderCount = 0
          ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
          ch.frame = 0
          ch.frameTimer = 0
          return
        }
      }
      ch.state = CharacterState.IDLE
      ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
    }
    ch.frame = 0
    ch.frameTimer = 0
    return
  }

  // Move toward next tile in path
  const nextTile = ch.path[0]
  ch.dir = directionBetween(ch.tileCol, ch.tileRow, nextTile.col, nextTile.row)

  ch.moveProgress += (WALK_SPEED_PX_PER_SEC / TILE_SIZE) * dt

  const fromCenter = tileCenter(ch.tileCol, ch.tileRow)
  const toCenter = tileCenter(nextTile.col, nextTile.row)
  const t = Math.min(ch.moveProgress, 1)
  ch.x = fromCenter.x + (toCenter.x - fromCenter.x) * t
  ch.y = fromCenter.y + (toCenter.y - fromCenter.y) * t

  if (ch.moveProgress >= 1) {
    // Arrived at next tile
    ch.tileCol = nextTile.col
    ch.tileRow = nextTile.row
    ch.x = toCenter.x
    ch.y = toCenter.y
    ch.path.shift()
    ch.moveProgress = 0
  }

  // If became active while wandering, repath to seat
  if (ch.isActive && ch.seatId) {
    const seat = seats.get(ch.seatId)
    if (seat) {
      const lastStep = ch.path[ch.path.length - 1]
      if (!lastStep || lastStep.col !== seat.seatCol || lastStep.row !== seat.seatRow) {
        const newPath = findPath(
          ch.tileCol,
          ch.tileRow,
          seat.seatCol,
          seat.seatRow,
          tileMap,
          blockedTiles
        )
        if (newPath.length > 0) {
          ch.path = newPath
          ch.moveProgress = 0
        }
      }
    }
  }
}
