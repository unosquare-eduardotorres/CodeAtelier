/**
 * G1 — the REVIEW-phase assertion that makes verification depth `e2e`
 * mechanically enforced instead of aspirational.
 *
 * The failure this exists to stop: a blueprint is created at depth "End-to-end",
 * nothing ever declares an e2e command, and the fact only surfaces at VERIFY —
 * after every code phase has already run, when the only remedy is to redo the
 * whole tail. Command resolution consults every source it will ever consult
 * (workspace override → the PLAN artifact's gate-commands block → detection),
 * and none of them can gain an entry between REVIEW and VERIFY, so the gap is
 * FULLY KNOWN at the approval gate. This suite pins that it is recorded there.
 *
 * What is deliberately NOT asserted: that TASKS "authored e2e work". That would
 * mean keyword-scanning a model's prose and would manufacture exactly the false
 * confidence the depth ladder exists to prevent.
 *
 * Run: tsx src/main/services/__tests__/blueprint-review-e2e-depth.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { trySetupTestDb } from '../../db/repositories/__tests__/db-test-helper'
import type { PreflightResult } from '../../../shared/preflight-types'

const env = trySetupTestDb()

if (!env) {
  describe('REVIEW e2e-depth enforcement (skipped — native module unavailable)', () => {
    test('depth_enforcement', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db } = env
  const {
    blueprintRepository,
    blueprintPhaseRepository
  } = require('../../db/repositories/blueprint.repository')
  const { BlueprintReviewService } = require('../blueprint-review.service')

  /** An empty scan root: nothing on disk can supply a detected e2e command. */
  const scanRoot = mkdtempSync(join(tmpdir(), 'review-depth-'))

  // repo_path is UNIQUE, so each workspace needs its own (unused) path. The scan
  // root passed to the check is `scanRoot` regardless.
  const seedWs = (id: string): string => {
    db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)`).run(
      id,
      'Depth Test',
      join(scanRoot, id)
    )
    return id
  }

  /** A blueprint at the given depth, with an optional PLAN gate-commands block. */
  const seedBlueprint = (
    wsSuffix: string,
    depth: string,
    declaredJson?: Record<string, string>
  ): string => {
    const workspaceId = seedWs(`ws-depth-${wsSuffix}`)
    const bp = blueprintRepository.create({
      workspaceId,
      title: `Depth ${wsSuffix}`,
      settingsJson: { verificationDepth: depth }
    })
    const planPhase = blueprintPhaseRepository.create({ blueprintId: bp.id, phase: 'plan' })
    if (declaredJson) {
      blueprintPhaseRepository.appendArtifact(planPhase.id, {
        type: 'plan',
        contentMd: '```gate-commands\n' + JSON.stringify(declaredJson) + '\n```'
      })
    }
    return bp.id
  }

  const emptyPreflight = (): PreflightResult =>
    ({
      checks: [],
      hasBlockers: false,
      hasWarnings: false,
      ranAt: new Date().toISOString()
    }) as unknown as PreflightResult

  /** Invoke the private method the way the rest of this codebase tests privates. */
  const runDepthCheck = (blueprintId: string, result = emptyPreflight()): PreflightResult => {
    const svc = new BlueprintReviewService()
    // Silence the phaseProgress emit — no renderer is attached in a unit test.
    svc.safeEmit = (): void => {}
    return (
      BlueprintReviewService.prototype as unknown as {
        withVerificationDepthCheck: (
          id: string,
          wsId: string,
          path: string,
          r: PreflightResult
        ) => PreflightResult
      }
    ).withVerificationDepthCheck.call(svc, blueprintId, 'ws-x', scanRoot, result)
  }

  const ledgerOf = (blueprintId: string): Array<{ gate: string; reason: string; taskId: string }> =>
    (blueprintRepository.findById(blueprintId)?.unverifiedJson ?? []) as Array<{
      gate: string
      reason: string
      taskId: string
    }>

  describe('REVIEW enforcement of verification depth e2e', () => {
    test('missing_e2e_command_is_ledgered_at_review_not_at_verify', () => {
      const bpId = seedBlueprint('no-cmd', 'e2e')
      runDepthCheck(bpId)

      const items = ledgerOf(bpId)
      const e2e = items.find((i) => i.gate === 'e2e')
      assert.ok(e2e, 'the gap must be recorded before BUILD burns, not after')
      assert.equal(e2e.reason, 'no_command')
      assert.equal(e2e.taskId, 'E2E', 'must share the single e2e ledger task id')
    })

    test('missing_e2e_command_raises_a_blocker_in_the_preflight_result', () => {
      const bpId = seedBlueprint('blocker', 'e2e')
      const result = runDepthCheck(bpId)

      const check = result.checks.find((c) => c.id === 'verification-depth-e2e')
      assert.ok(check, 'the approval gate must see it')
      assert.equal(check.status, 'blocker')
      assert.equal(result.hasBlockers, true, 'the gate header must go red')
      assert.equal(result.checks[0].id, 'verification-depth-e2e', 'blockers sort to the front')
    })

    test('a_declared_e2e_command_satisfies_the_depth', () => {
      const bpId = seedBlueprint('declared', 'e2e', { e2e: 'npm run test:e2e', smoke: 'npm start' })
      const result = runDepthCheck(bpId)

      assert.equal(ledgerOf(bpId).length, 0, 'a declared command is not an unproven gap')
      assert.equal(
        result.checks.find((c) => c.id?.startsWith('verification-depth')),
        undefined
      )
      assert.equal(result.hasBlockers, false)
    })

    test('running_twice_does_not_double_count_the_same_gap', () => {
      // The BUILD backstop and VERIFY both ledger under the same task id; a
      // re-run of REVIEW must not make one missing command look like two.
      const bpId = seedBlueprint('dedupe', 'e2e')
      runDepthCheck(bpId)
      runDepthCheck(bpId)

      assert.equal(ledgerOf(bpId).filter((i) => i.gate === 'e2e').length, 1)
    })

    test('standard_depth_ledgers_nothing', () => {
      const bpId = seedBlueprint('standard', 'standard')
      const result = runDepthCheck(bpId)

      assert.equal(ledgerOf(bpId).length, 0, 'standard never asked for e2e proof')
      assert.equal(result.hasBlockers, false)
    })

    test('integration_depth_warns_about_smoke_without_ledgering_e2e', () => {
      const bpId = seedBlueprint('integration', 'integration')
      const result = runDepthCheck(bpId)

      assert.equal(ledgerOf(bpId).length, 0, 'integration never asked for e2e proof')
      const check = result.checks.find((c) => c.id === 'verification-depth-smoke')
      assert.equal(check?.status, 'warn')
      assert.equal(result.hasBlockers, false, 'a missing smoke command is not a blocker')
      assert.equal(result.hasWarnings, true)
    })

    test('an_unknown_blueprint_degrades_to_standard_and_changes_nothing', () => {
      // Preflight must never block the approval gate (premortem #4): a blueprint
      // whose settings cannot be read falls back to `standard`, which asks for
      // no proof, rather than inventing a depth it was never given.
      const original = emptyPreflight()
      const result = runDepthCheck('does-not-exist', original)
      assert.deepEqual(result, original)
    })
  })

  process.on('exit', () => rmSync(scanRoot, { recursive: true, force: true }))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
