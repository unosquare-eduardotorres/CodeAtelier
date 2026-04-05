/**
 * Manages seat assignment, pathfinding to seats, and seat-related operations.
 * Extracted from OfficeState to reduce complexity.
 */
import {
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC
} from '../../constants'
import { findPath, isWalkable } from '../../layout/tileMap'
import type { Character, Seat, TileType as TileTypeVal } from '../types'
import { CharacterState, TILE_SIZE } from '../types'

export class SeatManager {
  /** Find a free (unassigned) seat, or null if none available */
  findFreeSeat(seats: Map<string, Seat>): string | null {
    for (const [uid, seat] of seats) {
      if (!seat.assigned) return uid
    }
    return null
  }

  /** Find seat uid at a given tile position, or null */
  getSeatAtTile(seats: Map<string, Seat>, col: number, row: number): string | null {
    for (const [uid, seat] of seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid
    }
    return null
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  ownSeatKey(ch: Character, seats: Map<string, Seat>): string | null {
    if (!ch.seatId) return null
    const seat = seats.get(ch.seatId)
    if (!seat) return null
    return `${seat.seatCol},${seat.seatRow}`
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  withOwnSeatUnblocked<T>(
    ch: Character,
    seats: Map<string, Seat>,
    blockedTiles: Set<string>,
    fn: () => T
  ): T {
    const key = this.ownSeatKey(ch, seats)
    if (key) blockedTiles.delete(key)
    const result = fn()
    if (key) blockedTiles.add(key)
    return result
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(
    ch: Character,
    seatId: string,
    seats: Map<string, Seat>,
    tileMap: TileTypeVal[][],
    blockedTiles: Set<string>
  ): void {
    // Unassign old seat
    if (ch.seatId) {
      const old = seats.get(ch.seatId)
      if (old) old.assigned = false
    }
    // Assign new seat
    const seat = seats.get(seatId)
    if (!seat || seat.assigned) return
    seat.assigned = true
    ch.seatId = seatId
    // Pathfind to new seat
    const path = this.withOwnSeatUnblocked(ch, seats, blockedTiles, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
    )
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
    } else {
      ch.state = CharacterState.TYPE
      ch.dir = seat.facingDir
      ch.frame = 0
      ch.frameTimer = 0
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC
      }
    }
  }

  /** Send an agent back to their currently assigned seat */
  sendToSeat(
    ch: Character,
    seats: Map<string, Seat>,
    tileMap: TileTypeVal[][],
    blockedTiles: Set<string>
  ): void {
    if (!ch.seatId) return
    const seat = seats.get(ch.seatId)
    if (!seat) return
    const path = this.withOwnSeatUnblocked(ch, seats, blockedTiles, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, tileMap, blockedTiles)
    )
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
    } else {
      ch.state = CharacterState.TYPE
      ch.dir = seat.facingDir
      ch.frame = 0
      ch.frameTimer = 0
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC
      }
    }
  }

  /** Walk an agent to an arbitrary walkable tile (right-click command) */
  walkToTile(
    ch: Character,
    col: number,
    row: number,
    seats: Map<string, Seat>,
    tileMap: TileTypeVal[][],
    blockedTiles: Set<string>
  ): boolean {
    if (ch.isSubagent) return false
    if (!isWalkable(col, row, tileMap, blockedTiles)) {
      const key = this.ownSeatKey(ch, seats)
      if (!key || key !== `${col},${row}`) return false
    }
    const path = this.withOwnSeatUnblocked(ch, seats, blockedTiles, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, tileMap, blockedTiles)
    )
    if (path.length === 0) return false
    ch.path = path
    ch.moveProgress = 0
    ch.state = CharacterState.WALK
    ch.frame = 0
    ch.frameTimer = 0
    return true
  }
}
