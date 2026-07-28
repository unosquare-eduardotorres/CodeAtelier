/**
 * Unit tests for usage-tracker.service.ts — featureForAgentRole mapping.
 *
 * The featureForAgentRole function maps AgentRole values to unified feature
 * bucket strings used in the usage_log table. Pure mapping logic, no I/O.
 *
 * Phase 4D — ~8 tests.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { featureForAgentRole } from '../usage-tracker.service'

describe('featureForAgentRole', () => {
  test('specialist → "chat"', () => {
    assert.equal(featureForAgentRole('specialist'), 'chat')
  })

  test('grill → "grill"', () => {
    assert.equal(featureForAgentRole('grill'), 'grill')
  })

  test('audit → "audit"', () => {
    assert.equal(featureForAgentRole('audit'), 'audit')
  })

  test('mpa-planner → "mpa"', () => {
    assert.equal(featureForAgentRole('mpa-planner'), 'mpa')
  })

  test('mpa-builder → "mpa"', () => {
    assert.equal(featureForAgentRole('mpa-builder'), 'mpa')
  })

  test('mpa-verifier → "mpa"', () => {
    assert.equal(featureForAgentRole('mpa-verifier'), 'mpa')
  })

  test('council-member → "council"', () => {
    assert.equal(featureForAgentRole('council-member'), 'council')
  })

  test('council-chairman → "council"', () => {
    assert.equal(featureForAgentRole('council-chairman'), 'council')
  })

  test('unknown role → returns role itself (pass-through)', () => {
    // Blueprint roles and any future roles fall through to default
    assert.equal(featureForAgentRole('blueprint-build'), 'blueprint-build')
    assert.equal(featureForAgentRole('blueprint-review'), 'blueprint-review')
    assert.equal(featureForAgentRole('blueprint-verify'), 'blueprint-verify')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
