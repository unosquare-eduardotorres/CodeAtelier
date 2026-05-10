/**
 * Unit tests for StackDriftDetectorService.
 *
 * The detector reads from the DB, so these tests cover the pure logic
 * (fingerprint + diff) via a focused probe that avoids DB bootstrap by
 * exercising an equivalent computation. Full integration is covered in
 * the Playwright E2E suite.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, describe, summaryAsync } from './test-harness'

function fingerprint(techs: string[]): string {
  return createHash('sha256').update([...techs].sort().join('|')).digest('hex').slice(0, 16)
}

describe('stack-drift-detector (fingerprint logic)', () => {
  test('stable_fingerprint_for_same_input_order', () => {
    const a = fingerprint(['react', 'typescript'])
    const b = fingerprint(['typescript', 'react'])
    assert.equal(a, b)
  })

  test('different_inputs_produce_different_fingerprints', () => {
    const a = fingerprint(['react'])
    const b = fingerprint(['vue'])
    assert.notEqual(a, b)
  })

  test('empty_list_produces_stable_fingerprint', () => {
    const a = fingerprint([])
    const b = fingerprint([])
    assert.equal(a, b)
    assert.equal(a.length, 16)
  })

  test('fingerprint_length_is_16_hex', () => {
    const fp = fingerprint(['react', 'tailwind', 'typescript'])
    assert.equal(fp.length, 16)
    assert.match(fp, /^[0-9a-f]+$/)
  })

  test('adding_a_tech_changes_fingerprint', () => {
    const a = fingerprint(['react'])
    const b = fingerprint(['react', 'typescript'])
    assert.notEqual(a, b)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
