/**
 * Pure-logic functions extracted from conversation-crud.ipc.ts for testability.
 *
 * No Electron, no I/O, no service/repository references.
 */

import { VALID_COMMUNICATION_TONES } from '../../shared/constants'
import type { CommunicationTone, ConversationMode } from '../../shared/types'

// ── Valid Sets ───────────────────────────────────────────────────────────────

export const VALID_MODES: readonly ConversationMode[] = ['plan', 'build', 'danger']

// ── Title Validation ─────────────────────────────────────────────────────────

const MAX_TITLE_LENGTH = 500

export interface TitleValidation {
  valid: boolean
  error?: string
}

/**
 * Validate a conversation title.
 * Returns { valid: true } or { valid: false, error } with a descriptive message.
 */
export function validateTitle(title: string | undefined, channel: string): TitleValidation {
  if (title !== undefined && title.length > MAX_TITLE_LENGTH) {
    return { valid: false, error: `${channel}: title too long (max ${MAX_TITLE_LENGTH} chars)` }
  }
  return { valid: true }
}

/**
 * Validate a rename title (required, non-empty after trim, max length).
 */
export function validateRenameTitle(title: string, channel: string): TitleValidation {
  if (title.length > MAX_TITLE_LENGTH) {
    return { valid: false, error: `${channel}: title too long (max ${MAX_TITLE_LENGTH} chars)` }
  }
  if (title.trim().length === 0) {
    return { valid: false, error: `${channel}: title cannot be empty` }
  }
  return { valid: true }
}

// ── Mode Validation ──────────────────────────────────────────────────────────

export interface ModeValidation {
  valid: boolean
  error?: string
}

/**
 * Validate a conversation mode.
 */
export function validateMode(mode: string | undefined, channel: string): ModeValidation {
  if (mode !== undefined && !(VALID_MODES as readonly string[]).includes(mode)) {
    return { valid: false, error: `${channel}: mode must be 'plan', 'build', or 'danger'` }
  }
  return { valid: true }
}

// ── Tone Validation ──────────────────────────────────────────────────────────

export interface ToneValidation {
  valid: boolean
  error?: string
}

/**
 * Validate a communication tone (accepts null as "use default").
 */
export function validateCommunicationTone(
  tone: CommunicationTone | null | undefined,
  channel: string
): ToneValidation {
  if (
    tone !== undefined &&
    tone !== null &&
    !VALID_COMMUNICATION_TONES.includes(tone as (typeof VALID_COMMUNICATION_TONES)[number])
  ) {
    return { valid: false, error: `${channel}: invalid communication tone` }
  }
  return { valid: true }
}
