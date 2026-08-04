/**
 * Phase 25, Wave 5 — E2E service runners: registry/type-drift guard.
 *
 * REWRITTEN from the original coverage-theatre version, which only asserted
 * "module exports something" / "exports are functions or objects" for each
 * of the 12 runner modules — assertions that execute import-time lines but
 * can never fail when a runner is actually broken.
 *
 * This file instead exercises the one thing worth guarding at this level:
 * service-runners/index.ts's SERVICE_RUNNERS registry, which maps every
 * E2EServiceRunnerKey (declared in src/shared/types.ts) to a concrete runner
 * function. A key added to the shared type without a matching registry entry
 * — or a runner import that silently resolves to `undefined` — currently
 * fails only at runtime deep inside a live E2E run. This test catches it at
 * coverage-run time instead.
 *
 * Real behavioural coverage of what the deterministic runners actually DO
 * (transcript content, DB cleanup, error paths) lives in
 * e2e-runner-deterministic.test.ts — that is where the 2,588 previously-
 * uncovered lines in this directory are actually exercised.
 *
 * Run: tsx src/main/services/__tests__/e2e-service-runners-phase25.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

describe('service-runners/index — SERVICE_RUNNERS registry (Phase 25 rewrite)', () => {
  const mod = require('../e2e-testing/service-runners/index')

  test('registry is non-empty and every key maps to a defined runner function', () => {
    const keys = Object.keys(mod.SERVICE_RUNNERS)
    assert.ok(keys.length > 0, 'SERVICE_RUNNERS should not be empty')
    for (const [key, runner] of Object.entries(mod.SERVICE_RUNNERS)) {
      assert.equal(
        typeof runner,
        'function',
        `SERVICE_RUNNERS['${key}'] resolved to ${typeof runner}, not a function — ` +
          `a runner import likely resolved to undefined`
      )
    }
  })

  test('every runner function takes exactly one argument (ctx: E2EServiceContext)', () => {
    for (const [key, runner] of Object.entries(mod.SERVICE_RUNNERS)) {
      assert.equal(
        (runner as (...args: unknown[]) => unknown).length,
        1,
        `SERVICE_RUNNERS['${key}'] should accept exactly (ctx) per the documented runner contract`
      )
    }
  })

  test('no two registry keys resolve to the same underlying function reference', () => {
    // Catches copy-paste registry mistakes (e.g. two keys wired to the same runner).
    const seen = new Map<unknown, string>()
    for (const [key, runner] of Object.entries(mod.SERVICE_RUNNERS)) {
      const prior = seen.get(runner)
      assert.ok(
        !prior,
        `SERVICE_RUNNERS['${key}'] and SERVICE_RUNNERS['${prior}'] resolve to the same function`
      )
      seen.set(runner, key)
    }
  })

  test('createStreamPromptHelper returns a bindable (text, opts?) => Promise function', () => {
    const helper = mod.createStreamPromptHelper('conv-123', 5_000)
    assert.equal(typeof helper, 'function')
    assert.equal(helper.length, 2, 'helper should accept (text, opts?)')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
