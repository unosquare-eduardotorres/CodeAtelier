/**
 * PromptVariants — type-safe full/lean prompt selection.
 *
 * Pattern 4 centralization: every prompt file has a full/lean branch using
 * `resolvePromptVerbosity(model) === 'lean'`. This module makes the mechanism
 * explicit and type-safe:
 *
 *   - Define prompt content as a `PromptVariants` object.
 *   - Call `selectVariant(variants, model)` instead of manual if/else.
 *   - Adding a third verbosity level (e.g., 'minimal') becomes a one-file change.
 */

import { resolvePromptVerbosity } from '../../shared/constants'

/** A prompt block with full and lean variants. */
export interface PromptVariants {
  full: string
  lean: string
}

/**
 * Select the appropriate prompt variant for the given model.
 * Returns the lean variant when `resolvePromptVerbosity(model)` is 'lean',
 * otherwise returns the full variant.
 */
export function selectVariant(variants: PromptVariants, model?: string): string {
  return resolvePromptVerbosity(model ?? '') === 'lean' ? variants.lean : variants.full
}

/**
 * Check if the current model should use lean prompts.
 * Convenience wrapper for `resolvePromptVerbosity`.
 */
export function isLeanModel(model?: string): boolean {
  return resolvePromptVerbosity(model ?? '') === 'lean'
}
