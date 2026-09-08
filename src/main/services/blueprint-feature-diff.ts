/**
 * E3 — the whole-feature diff, resolved once and shared.
 *
 * Three call sites needed `git diff <buildBaselineCommit>..HEAD`:
 * `blueprint-code-review.service`, `blueprint-lead-review.service` (byte-identical
 * implementations, each with its own 120 K cap constant and a comment promising
 * "the same contract as the other one"), and `blueprint-verify.service`, which
 * needs only the baseline for its structural gate. Three copies of a contract is
 * three chances for it to drift, and running `git diff` over a whole feature
 * three times in one pipeline is work done twice for nothing.
 *
 * CACHING, AND WHY THE KEY INCLUDES HEAD
 *
 * The memo key is `(blueprintId, baseline, HEAD)` with **HEAD recomputed on
 * every call**. HEAD moves during VERIFY→BUILD remediation rounds, so a key of
 * `(blueprintId, baseline)` alone would hand a later review the diff of an
 * earlier tree — reviewing code that is no longer there and missing the fixes
 * that replaced it. Recomputing HEAD costs one `git rev-parse`; getting this
 * wrong costs a review round.
 */

import { execFileSync } from 'node:child_process'
import log from 'electron-log'
import { blueprintRepository } from '../db/repositories/blueprint.repository'

const diffLog = log.scope('blueprint-feature-diff')

/**
 * Whole-diff cap. A diff beyond this is truncated, not shipped raw.
 * Was declared separately (and identically) in code-review and lead-review.
 */
export const MAX_FEATURE_DIFF_CHARS = 120_000

function gitSync(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024
    })
  } catch {
    return null
  }
}

interface CacheEntry {
  key: string
  diff: string | null
}

/**
 * One slot, not a map. Phases run sequentially within a pipeline, so the only
 * reuse that matters is "the site that just asked, asking again"; an unbounded
 * map would retain multi-megabyte diffs for blueprints that finished hours ago.
 */
let cached: CacheEntry | null = null

/** Test seam — the cache is process-global and would leak across cases. */
export function _resetFeatureDiffCache(): void {
  cached = null
}

/**
 * The run's starting commit: `settingsJson.buildBaselineCommit`, captured by
 * `startBuildPhase`, with a merge-base against `main` as fallback — the diff
 * since the blueprint's branch diverged.
 *
 * Returns null when neither resolves. Callers must preserve their own meaning
 * for that: verify's structural gate reports `no_git`, the reviews return null.
 */
export function resolveFeatureBaseline(blueprintId: string, workspacePath: string): string | null {
  try {
    const blueprint = blueprintRepository.findById(blueprintId)
    if (!blueprint) return null

    const settings = (blueprint.settingsJson ?? {}) as Record<string, unknown>
    if (typeof settings.buildBaselineCommit === 'string' && settings.buildBaselineCommit) {
      return settings.buildBaselineCommit
    }

    const mb = gitSync(['merge-base', 'HEAD', 'main'], workspacePath)
    return mb?.trim() || null
  } catch {
    return null
  }
}

/**
 * The tree's current HEAD sha, or null when git is unavailable / this is not a
 * repo. Used to decide whether a proof recorded earlier in the pipeline still
 * describes the tree being judged now.
 */
export function resolveHeadSha(workspacePath: string): string | null {
  return gitSync(['rev-parse', 'HEAD'], workspacePath)?.trim() || null
}

/**
 * `git diff <baseline>..HEAD`, capped and memoized.
 *
 * Returns:
 *   - `null` when no baseline resolves, or git itself fails
 *   - `''`   for a clean tree — nothing built, still reviewable as empty
 *   - the diff, truncated at `maxChars` with an explicit marker
 */
export function assembleFeatureDiff(
  blueprintId: string,
  workspacePath: string,
  maxChars: number = MAX_FEATURE_DIFF_CHARS
): string | null {
  const baseline = resolveFeatureBaseline(blueprintId, workspacePath)
  if (!baseline) return null

  // Recomputed per call, deliberately — see the module comment.
  const head = gitSync(['rev-parse', 'HEAD'], workspacePath)?.trim() ?? ''
  // \x1f (unit separator), not a literal NUL: a raw 0x00 byte in the source
  // makes git treat this FILE as binary, so every change to it shows as "Bin
  // 4647 bytes" instead of a reviewable diff. \x1f separates just as safely —
  // it cannot occur in an id, a sha or a number — and matches the %x1f the
  // gate service already uses for the same reason.
  const key = `${blueprintId}\x1f${baseline}\x1f${head}\x1f${maxChars}`

  if (cached?.key === key) return cached.diff

  const raw = gitSync(['diff', '--no-color', `${baseline}..HEAD`, '--'], workspacePath)
  let diff: string | null
  if (raw === null) {
    diff = null
  } else if (raw.trim() === '') {
    diff = ''
  } else if (raw.length > maxChars) {
    diffLog.info(
      `[feature-diff] ${blueprintId}: ${raw.length} chars truncated to ${maxChars}`
    )
    diff = raw.slice(0, maxChars) + '\n… (diff truncated for review)'
  } else {
    diff = raw
  }

  // A null result is NOT cached: it means git failed, which is usually
  // transient (a lock held by a peer task), and pinning the failure for the
  // rest of the phase would turn a blip into a review with no diff.
  if (diff !== null) cached = { key, diff }
  return diff
}
