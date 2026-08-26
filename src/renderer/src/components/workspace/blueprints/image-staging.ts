/**
 * Draft-scoped image staging for blueprint attachment forms.
 *
 * A dropped image still lives wherever it was dragged from, which is outside
 * every directory the image reader will open — so it cannot be previewed until
 * the blueprint exists and copy-on-attach has moved it. Copying it into a
 * per-draft staging dir under `userData/chat-images/<scope>/` fixes the preview
 * and gives the file a lifecycle: the form clears its whole scope on unmount,
 * whether the draft was created or abandoned.
 */

import { rendererLog } from '@renderer/utils/logger'

let scopeCounter = 0

/**
 * Unique staging scope for one mount of a draft form. Prefixed
 * `blueprint-draft-` so the main process can sweep orphans at boot.
 */
export function newDraftScope(): string {
  return `blueprint-draft-${Date.now()}-${scopeCounter++}`
}

/**
 * Copy dropped images into the draft's staging dir, returning the paths to
 * attach. A failed copy falls back to the original path: the attachment still
 * saves correctly at create time, it just won't render a thumbnail before then.
 */
export async function stageDroppedImages(scope: string, paths: string[]): Promise<string[]> {
  return Promise.all(
    paths.map(async (sourcePath) => {
      try {
        return await window.api.stageImageFile({ scope, sourcePath })
      } catch (err) {
        rendererLog.warn('[image-staging] Failed to stage image, using original path:', err)
        return sourcePath
      }
    })
  )
}

/** Drop a staging scope (best-effort — the boot sweep is the safety net). */
export function clearDraftScope(scope: string): void {
  void window.api.clearStagedImages({ scope }).catch((err) => {
    rendererLog.warn('[image-staging] Failed to clear staging scope:', err)
  })
}
