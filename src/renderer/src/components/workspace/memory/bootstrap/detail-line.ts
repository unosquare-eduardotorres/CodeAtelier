/**
 * The two derivations behind the progress panel's main line and the line under
 * it, kept out of the component so they can be tested without a DOM.
 *
 * The second rule is the one with teeth: while an item is in flight the chunk
 * counter owns the main line, so the extractor's own status ("Rate limited —
 * retrying in 4s…") has nowhere to go and a long backoff looks like a freeze.
 * It goes underneath — unless it would just repeat the line above it.
 */
import type { BootstrapProgress } from '../../../../../../shared/types'

/** The main line: the item in flight, with a chunk counter when it has one. */
export function itemLabel(progress: BootstrapProgress): string | null {
  const item = progress.currentItem
  if (!item) return null
  return item.chunkTotal > 1
    ? `${item.sourceRef} — chunk ${item.chunkDone}/${item.chunkTotal}`
    : item.sourceRef
}

/** The line underneath, or null when it would echo the main line. */
export function detailLine(progress: BootstrapProgress): string | null {
  const label = itemLabel(progress)
  if (!label || !progress.message) return null
  if (progress.message === label) return null
  if (progress.message === progress.currentItem?.sourceRef) return null
  return progress.message
}
