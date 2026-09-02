/**
 * One sentence for "where will this run fork from, and why?".
 *
 * Three surfaces ask that question — Repository settings, the branch picker and
 * the draft preview — and they must not answer it three different ways. A user
 * who reads "cut from your HEAD" in one place and `integration/main` in another
 * has been given two facts and no way to tell which is true, which is the
 * failure mode this whole feature exists to remove.
 *
 * Pure and string-only: no React, no IPC, so it is unit-testable and usable
 * from both the settings tab and the blueprint components.
 */

import type { ResolvedBlueprintBase, BlueprintBaseSource } from './blueprint-types'

/**
 * Why this branch won, in the user's vocabulary.
 *
 * `blueprint-fork` returns null deliberately: the user picked that branch in
 * the adjacent dropdown seconds ago, so restating it as "(your choice)" is
 * noise rather than provenance.
 */
export function describeBaseSource(source: BlueprintBaseSource): string | null {
  switch (source) {
    case 'blueprint-fork':
      return null
    case 'workspace-setting':
      return 'workspace default'
    case 'checkout':
      return 'your checkout'
    case 'repo-default':
      return "this repository's default branch"
    case 'fallback':
      return 'fallback'
  }
}

/**
 * The full line, integration upgrade included.
 *
 * The upgrade is always named with its ahead-count. A user who pinned `main`
 * and finds work on `integration/main` has been surprised unless the number
 * that justified the substitution is on screen next to it.
 */
export function summariseResolvedBase(base: ResolvedBlueprintBase): string {
  if (!base.commit) {
    return 'No base branch could be resolved — this repository has no commits yet.'
  }

  if (base.upgradedToIntegration) {
    const plural = base.aheadOfResolved === 1 ? 'commit' : 'commits'
    return (
      `Forks from ${base.branch} — ${base.aheadOfResolved} ${plural} ahead of ` +
      `${base.resolvedFrom}, which already carries landed work.`
    )
  }

  const why = describeBaseSource(base.source)
  return why ? `Forks from ${base.branch} (${why}).` : `Forks from ${base.branch}.`
}
