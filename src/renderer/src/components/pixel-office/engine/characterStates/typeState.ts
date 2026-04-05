/**
 * TYPE state handler for character FSM.
 * Character is sitting at desk, typing/reading. Transitions to IDLE when deactivated.
 */
import {
  TYPE_FRAME_DURATION_SEC,
  WANDER_MOVES_BEFORE_REST_MAX,
  WANDER_MOVES_BEFORE_REST_MIN,
  WANDER_PAUSE_MAX_SEC,
  WANDER_PAUSE_MIN_SEC
} from '../../constants'
import type { Character } from '../types'
import { CharacterState } from '../types'
import { randomInt, randomRange } from '../utils'

export function handleTypeState(ch: Character, dt: number): void {
  if (ch.frameTimer >= TYPE_FRAME_DURATION_SEC) {
    ch.frameTimer -= TYPE_FRAME_DURATION_SEC
    ch.frame = (ch.frame + 1) % 2
  }
  // If no longer active, stand up and start wandering (after seatTimer expires)
  if (!ch.isActive) {
    if (ch.seatTimer > 0) {
      ch.seatTimer -= dt
      return
    }
    ch.seatTimer = 0 // clear sentinel
    ch.state = CharacterState.IDLE
    ch.frame = 0
    ch.frameTimer = 0
    ch.wanderTimer = randomRange(WANDER_PAUSE_MIN_SEC, WANDER_PAUSE_MAX_SEC)
    ch.wanderCount = 0
    ch.wanderLimit = randomInt(WANDER_MOVES_BEFORE_REST_MIN, WANDER_MOVES_BEFORE_REST_MAX)
  }
}
