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
    for (const t of [
      'Agent',
      'Task',
      'local_agent',
      'local_bash',
      'ToolSearch',
      'ExitPlanMode',
      'AskUserQuestion'
    ])
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
    // local_bash duplicates the process-manager MCP server and is invisible
    // to our background-task registry — blocked in every mode.
    assert.ok(p.disallowed.includes('local_bash'))
  })

  test('unknown mode falls through to plan defaults', () => {
    const p = buildModePermissions('weird' as unknown as 'plan')
    assert.deepEqual(p.baseAllowed, ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'])
  })

  // ── Documentation: Claude overlay contract ──
  // buildModePermissions returns the *pre-permission-gate* base lists.
  // The Claude builder (buildClaudeProviderMcpConfig) overlays Write/Edit
  // exposure because Claude Code gates plan-mode writes at runtime via
  // --permission-mode plan, not via spawn-time allow/disallow lists.
  // The local-LLM builder uses these lists as-is.
  test('plan mode base lists are the pre-gate values (Claude overlays Write/Edit separately)', () => {
    const p = buildModePermissions('plan')
    // Write/Edit are in the disallowed list here — the Claude path removes them.
    assert.ok(p.disallowed.includes('Write'), 'base disallowed includes Write (Claude strips it)')
    assert.ok(p.disallowed.includes('Edit'), 'base disallowed includes Edit (Claude strips it)')
    // Write/Edit are NOT in the allowed list here — the Claude path adds them.
    assert.ok(!p.baseAllowed!.includes('Write'), 'base allowed excludes Write (Claude adds it)')
    assert.ok(!p.baseAllowed!.includes('Edit'), 'base allowed excludes Edit (Claude adds it)')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
