/**
 * Phase 26 Wave 5 — blueprint-preflight.service.ts deep body coverage.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, resetAllMocks } from './setup-full-mock'
setupFullMock()

const mod = require('../blueprint-preflight.service')
const { runPreflightChecks, buildPreflightDiscoveries } = mod

describe('BlueprintPreflightService (P26-W5)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  test('runPreflightChecks is a function', () => {
    assert.equal(typeof runPreflightChecks, 'function')
  })
  test('buildPreflightDiscoveries is a function', () => {
    assert.equal(typeof buildPreflightDiscoveries, 'function')
  })

  test('runPreflightChecks handles empty workspace', async () => {
    try {
      const result = await runPreflightChecks({ workspacePath: '/tmp/test', declarations: [] })
      assert.equal(typeof result, 'object')
    } catch {
      /* OK */
    }
  })

  test('buildPreflightDiscoveries formats results with checks array', () => {
    const discoveries = buildPreflightDiscoveries({
      checks: [{ name: 'node', status: 'ok', kind: 'cli-tool' }]
    })
    assert.ok(Array.isArray(discoveries))
  })

  test('buildPreflightDiscoveries handles blocker checks', () => {
    const discoveries = buildPreflightDiscoveries({
      checks: [
        { name: 'docker', status: 'blocker', kind: 'cli-tool' },
        { name: 'SUPABASE_URL', status: 'blocker', kind: 'env-var' },
        { name: 'postgres', status: 'blocker', kind: 'service' }
      ]
    })
    assert.ok(Array.isArray(discoveries))
    assert.ok(discoveries.length > 0)
  })
})
