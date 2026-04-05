/**
 * Manages speech bubble state for characters in the pixel office.
 * Extracted from OfficeState to reduce complexity.
 */
import {
  DISMISS_BUBBLE_FAST_FADE_SEC,
  WAITING_BUBBLE_DURATION_SEC
} from '../../constants'
import type { Character } from '../types'

export class BubbleManager {
  showPermissionBubble(characters: Map<number, Character>, id: number): void {
    const ch = characters.get(id)
    if (ch) {
      ch.bubbleType = 'permission'
      ch.bubbleTimer = 0
    }
  }

  clearPermissionBubble(characters: Map<number, Character>, id: number): void {
    const ch = characters.get(id)
    if (ch && ch.bubbleType === 'permission') {
      ch.bubbleType = null
      ch.bubbleTimer = 0
    }
  }

  showWaitingBubble(characters: Map<number, Character>, id: number): void {
    const ch = characters.get(id)
    if (ch) {
      ch.bubbleType = 'waiting'
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC
    }
  }

  /** Dismiss bubble on click — permission: instant, waiting: quick fade */
  dismissBubble(characters: Map<number, Character>, id: number): void {
    const ch = characters.get(id)
    if (!ch || !ch.bubbleType) return
    if (ch.bubbleType === 'permission') {
      ch.bubbleType = null
      ch.bubbleTimer = 0
    } else if (ch.bubbleType === 'waiting') {
      // Trigger immediate fade (0.3s remaining)
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC)
    }
  }

  /** Tick waiting bubble timers. Called from the update loop. */
  updateBubbles(characters: Map<number, Character>, dt: number): void {
    for (const ch of characters.values()) {
      if (ch.bubbleType === 'waiting') {
        ch.bubbleTimer -= dt
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null
          ch.bubbleTimer = 0
        }
      }
    }
  }
}
