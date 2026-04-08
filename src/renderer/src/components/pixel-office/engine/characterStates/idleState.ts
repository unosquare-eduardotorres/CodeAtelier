/**
 * IDLE state handler for character FSM.
 * Character is standing/wandering. Transitions to WALK when reactivated or wander timer fires.
 */
import {
  SEAT_REST_MAX_SEC,
  SEAT_REST_MIN_SEC,
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC
} from '../../constants'
import { findPath } from '../../layout/tileMap'
import type { Character, Seat, TileType as TileTypeVal } from '../types'
import { CharacterState } from '../types'
import { randomInt, randomRange } from '../utils'

export function handleIdleState(
  ch: Character,
  dt: number,
  walkableTiles: Array<{ col: number; row: number }>,
  seats: Map<string, Seat>,
  tileMap: TileTypeVal[][],
  blockedTiles: Set<string>,
  idleZoneTiles?: Array<{ col: number; row: number }>
): void {
  // No idle animation -- static pose
  ch.frame = 0
  if (ch.seatTimer < 0) ch.seatTimer = 0 // clear turn-end sentinel

  // If became active, pathfind to seat
  if (ch.isActive) {
    if (!ch.seatId) {
      // No seat assigned -- type in place
      ch.state = CharacterState.TYPE
      ch.frame = 0
      ch.frameTimer = 0
      return
    }
    const seat = seats.get(ch.seatId)
    if (seat) {
      const path = findPath(
        ch.tileCol,
        ch.tileRow,
        seat.seatCol,
        seat.seatRow,
        tileMap,
        blockedTiles
      )
      if (path.length > 0) {
        ch.path = path
        ch.moveProgress = 0
        ch.state = CharacterState.WALK
        ch.frame = 0
        ch.frameTimer = 0
      } else {
        // Already at seat or no path -- sit down
        ch.state = CharacterState.TYPE
        ch.dir = seat.facingDir
        ch.frame = 0
        ch.frameTimer = 0
      }
    }
    return
  }

  // Countdown wander timer
  ch.wanderTimer -= dt
  if (ch.wanderTimer <= 0) {
    // Use idle zone tiles (break room) if available, otherwise all walkable tiles
    const wanderArea = idleZoneTiles && idleZoneTiles.length > 0 ? idleZoneTiles : walkableTiles

    // Check if character is NOT in the idle zone — if so, pathfind there first
    const inIdleZone =
      !idleZoneTiles ||
      idleZoneTiles.length === 0 ||
      idleZoneTiles.some((t) => t.col === ch.tileCol && t.row === ch.tileRow)

    if (!inIdleZone && wanderArea.length > 0) {
      // Walk to a random spot in the idle zone
      const target = wanderArea[Math.floor(Math.random() * wanderArea.length)]
      const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, tileMap, blockedTiles)
      if (path.length > 0) {
        ch.path = path
        ch.moveProgress = 0
        ch.state = CharacterState.WALK
        ch.frame = 0
        ch.frameTimer = 0
        return
      }
    }

    // Already in idle zone — wander within it
    if (ch.wanderCount >= ch.wanderLimit) {
      // Rest in place for a while, then reset wander cycle
      ch.wanderCount = 0
      ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
      ch.wanderTimer = randomRange(SEAT_REST_MIN_SEC, SEAT_REST_MAX_SEC)
      return
    }

    if (wanderArea.length > 0) {
      const target = wanderArea[Math.floor(Math.random() * wanderArea.length)]
      const path = findPath(ch.tileCol, ch.tileRow, target.col, target.row, tileMap, blockedTiles)
      if (path.length > 0) {
        ch.path = path
        ch.moveProgress = 0
        ch.state = CharacterState.WALK
        ch.frame = 0
        ch.frameTimer = 0
        ch.wanderCount++
      }
    }
    ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
  }
}
