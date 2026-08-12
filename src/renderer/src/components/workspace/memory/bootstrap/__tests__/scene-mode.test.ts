/**
 * scene-mode — which of the three renders BrainIngestScene picks.
 *
 * The case that regressed in production is `(webgl ok, reduced motion)`: it
 * used to resolve to the CSS fallback, so a machine with Windows' "Adjust for
 * best performance" turned on showed a near-invisible 10%-opacity rectangle
 * and looked broken. It must resolve to 'static' — the scene, drawn once.
 *
 * Run: tsx src/renderer/src/components/workspace/memory/bootstrap/__tests__/scene-mode.test.ts
 */
import assert from 'node:assert/strict'
import {
  test,
  describe,
  summaryAsync
} from '../../../../../../../main/services/__tests__/test-harness'
import { resolveSceneMode } from '../scene-mode'

describe('resolveSceneMode', () => {
  test('WebGL and no motion preference animates', () => {
    assert.equal(resolveSceneMode(true, false), 'animated')
  })

  test('reduced motion still draws the scene, statically — not the CSS fallback', () => {
    assert.equal(resolveSceneMode(true, true), 'static')
  })

  test('no WebGL falls back to CSS', () => {
    assert.equal(resolveSceneMode(false, false), 'fallback')
  })

  test('no WebGL wins over the motion preference — there is nothing to draw with', () => {
    assert.equal(resolveSceneMode(false, true), 'fallback')
  })
})

// ── Standalone runner ─────────────────────────────────────────────
// summaryAsync calls process.exit — unguarded it kills the whole suite when
// this file is imported by a runner, taking every later test file with it.
if (process.argv[1]?.includes('scene-mode')) {
  void summaryAsync()
}
