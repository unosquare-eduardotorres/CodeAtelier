/**
 * Unit tests for mode-permissions.ts — mode-driven allow/disallow tool lists.
 * Pure logic.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { buildModePermissions } from '../mode-permissions'

describe('buildModePermissions', () => {
  test('build mode has no allow-list and disallows sub-agent tools', () => {
    const p = buildModePermissions('build')
    assert.equal(p.baseAllowed, undefined)
    for (const t of ['Agent', 'Task', 'local_agent', 'ToolSearch', 'ExitPlanMode', 'AskUserQuestion'])
      assert.ok(p.disallowed.includes(t), `expected disallowed to include ${t}`)
    assert.ok(!p.disallowed.includes('Write'), 'build allows Write')
  })

  test('danger mode mirrors build permissions', () => {
    const danger = buildModePermissions('danger')
    const build = buildModePermissions('build')
    assert.deepEqual(danger.baseAllowed, build.baseAllowed)
    assert.deepEqual(danger.disallowed.sort(), build.disallowed.sort())
  })

  test('plan mode ships an explicit read-only allow-list', () => {
    const p = buildModePermissions('plan')
    assert.deepEqual(p.baseAllowed, ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'])
    // Write/Edit must be blocked in plan mode.
    assert.ok(p.disallowed.includes('Write'))
    assert.ok(p.disallowed.includes('Edit'))
  })

  test('unknown mode falls through to plan defaults', () => {
    const p = buildModePermissions('weird' as unknown as 'plan')
    assert.deepEqual(p.baseAllowed, ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
