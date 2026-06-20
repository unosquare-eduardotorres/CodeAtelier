/**
 * URL auto-detection utility for blueprint descriptions.
 *
 * Extracts URLs from text and converts them to ReferenceDocument entries.
 * Used by the BlueprintPage input view to auto-detect pasted URLs.
 */

import type { ReferenceDocument } from '../../../../../shared/blueprint-types'

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi

/**
 * Extract URLs from text and convert to ReferenceDocument entries.
 * Deduplicates by URL.
 */
export function extractUrls(text: string): ReferenceDocument[] {
  const matches = text.match(URL_REGEX) || []
  return [...new Set(matches)].map((url) => {
    try {
      const parsed = new URL(url)
      const segments = parsed.pathname.split('/').filter(Boolean)
      let name: string
      if (segments.length === 0) {
        name = parsed.hostname
      } else if (segments.length === 1) {
        name = `${parsed.hostname}/${segments[0]}`
      } else {
        // Show host + …/lastSegment for deep paths
        const last = segments[segments.length - 1]
        name = `${parsed.hostname}/…/${last}`
      }
      return { type: 'url' as const, path: url, name }
    } catch {
      return {
        type: 'url' as const,
        path: url,
        name: url.slice(0, 50)
      }
    }
  })
}

/**
 * Merge newly detected URL refs into an existing list without duplicating.
 * Preserves all non-URL refs and only adds URLs not already present.
 */
export function mergeUrlRefs(
  existing: ReferenceDocument[],
  detected: ReferenceDocument[]
): ReferenceDocument[] {
  const existingUrls = new Set(existing.filter((r) => r.type === 'url').map((r) => r.path))
  const newUrls = detected.filter((r) => !existingUrls.has(r.path))
  return [...existing, ...newUrls]
}
