/**
 * Helpers for reading the reference documents stored on a blueprint.
 *
 * Kept out of the component file so both the read-only card and the draft
 * editor can import them without tripping fast-refresh's
 * components-only-exports rule.
 */

import type {
  ReferenceDocument,
  BlueprintBranchChoice
} from '../../../../../../shared/blueprint-types'
import { IMAGE_REGEX } from '@renderer/hooks'

// The branch reader is shared with main, which resolves the name this reads.
export { readBlueprintBranchName } from '../../../../../../shared/blueprint-branch-name'

/**
 * Pull the reference documents out of a blueprint's settings blob.
 *
 * `settingsJson` is untyped storage shared with branchChoice / jiraIssueKey and
 * is written by several code paths, so every entry is shape-checked rather than
 * cast — a malformed row must not blank the whole detail view.
 */
export function extractReferenceDocs(settingsJson: Record<string, unknown>): ReferenceDocument[] {
  const raw = settingsJson?.referenceDocuments
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (d): d is ReferenceDocument =>
      !!d && typeof d === 'object' && typeof (d as ReferenceDocument).path === 'string'
  )
}

/**
 * The branch choice stored on a draft.
 *
 * Mirrors `readBranchChoice` in main: anything that is not one of the three
 * explicit modes — including every blueprint created before branch selection
 * existed — reads as `auto`, which is the old behaviour and the right default.
 */
export function readBranchChoice(
  settingsJson: Record<string, unknown> | null | undefined
): BlueprintBranchChoice {
  const raw = settingsJson?.branchChoice as Partial<BlueprintBranchChoice> | undefined
  const mode = raw?.mode
  if (mode !== 'fork' && mode !== 'takeover' && mode !== 'primary') return { mode: 'auto' }
  return {
    mode,
    branch: typeof raw?.branch === 'string' && raw.branch ? raw.branch : undefined,
    name: typeof raw?.name === 'string' && raw.name ? raw.name : undefined
  }
}

/** Split a doc list into previewable images and everything else. */
export function partitionImages(docs: ReferenceDocument[]): {
  images: ReferenceDocument[]
  rest: ReferenceDocument[]
} {
  const images: ReferenceDocument[] = []
  const rest: ReferenceDocument[] = []
  for (const doc of docs) {
    if (doc.type !== 'url' && IMAGE_REGEX.test(doc.path)) images.push(doc)
    else rest.push(doc)
  }
  return { images, rest }
}
