/**
 * Shared plan-block detection.
 *
 * Used by MessageList (latest-plan detection scan), ChatExecutionPanel (plan
 * history) and useMessageContent (plan content extraction). Centralised here to
 * prevent divergence.
 *
 * The lazy regexes these helpers replaced stopped at the first backtick run
 * after the opening fence, so a structured plan carrying a fenced code sample
 * inside a JSON string value was truncated. See src/shared/fenced-block.ts.
 */

import { findFencedBlock, hasFencedBlock, type FencedBlock } from '../../../../shared/fenced-block'

/** Locate the ```plan block in a message, or null when there is none. */
export function findPlanBlock(content: string): FencedBlock | null {
  return findFencedBlock(content, 'plan')
}

/** Whether a message contains a ```plan block. */
export function hasPlanBlock(content: string): boolean {
  return hasFencedBlock(content, 'plan')
}

/** Whether a message contains a ```build-summary block. MessageCardRenderer
 *  prioritizes build-summary, so a message with both never renders a plan card. */
export function hasBuildSummaryBlock(content: string): boolean {
  return hasFencedBlock(content, 'build-summary')
}
