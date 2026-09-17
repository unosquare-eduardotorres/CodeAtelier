/**
 * Module-loading helper for the production-path landing-lock test.
 *
 * Under the shared runner, repositories are mocked at Module._load time; a
 * file that requires landing.service directly would bind the mock into its
 * import closure. This helper is required (not imported) by the test so the
 * resolution happens inside the test's own execution, with the runner's
 * module registry in whatever state the surrounding run established — matching
 * how blueprint-track.test.ts resolves modules through reloadWithRealDeps.
 *
 * In plain standalone tsx runs (no full mock), both modules load normally.
 */
import * as blueprintTrackMod from '../blueprint-track'
import * as landingMod from '../landing.service'

export { blueprintTrackMod, landingMod }
