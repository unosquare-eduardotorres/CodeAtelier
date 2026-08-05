/**
 * Run 16: Context usage level/quality resolution.
 *
 * Guards the fix for the "42% real usage shown as 83% / Low / red bar" bug.
 * The level + qualityLevel must be derived from RAW context-window usage with
 * thresholds aligned to the compaction trigger points — NOT a 500K-capped
 * "quality window".
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { resolveContextLevel } from '../../ipc/context-usage-level'

describe('resolveContextLevel — large window (1M)', () => {
  const W = 1_000_000

  test('bands are identical to a 200K window (uniform ratios)', () => {
    assert.deepEqual(resolveContextLevel(60, W), resolveContextLevel(60, 200_000))
    assert.deepEqual(resolveContextLevel(75, W), resolveContextLevel(75, 200_000))
  })

  test('fresh 1M session at 42% is green / excellent (regression: was Low/red)', () => {
    const { level, qualityLevel } = resolveContextLevel(42, W)
    assert.equal(level, 'green')
    assert.equal(qualityLevel, 'excellent')
  })

  test('48% (warning threshold) flips to yellow / good', () => {
    assert.deepEqual(resolveContextLevel(48, W), { level: 'yellow', qualityLevel: 'good' })
  })

  test('just below warning (47%) stays green / excellent', () => {
    assert.deepEqual(resolveContextLevel(47, W), { level: 'green', qualityLevel: 'excellent' })
  })

  test('60% (suggest threshold) is red / moderate', () => {
    assert.deepEqual(resolveContextLevel(60, W), { level: 'red', qualityLevel: 'moderate' })
  })

  test('75% (auto threshold) is critical / low', () => {
    assert.deepEqual(resolveContextLevel(75, W), { level: 'critical', qualityLevel: 'low' })
  })
})

describe('resolveContextLevel — small window (≤200K)', () => {
  const W = 200_000

  test('48% (warning threshold) flips to yellow / good', () => {
    assert.deepEqual(resolveContextLevel(48, W), { level: 'yellow', qualityLevel: 'good' })
  })

  test('42% on a small window stays green / excellent', () => {
    assert.deepEqual(resolveContextLevel(42, W), { level: 'green', qualityLevel: 'excellent' })
  })

  test('60% (suggest) is red, 75% (auto) is critical', () => {
    assert.equal(resolveContextLevel(60, W).level, 'red')
    assert.equal(resolveContextLevel(75, W).level, 'critical')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
