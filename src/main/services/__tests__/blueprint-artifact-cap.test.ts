/**
 * blueprint-artifact-cap.test.ts — disk-mirror truncation + tier-scaled budgets.
 *
 * Two bugs pinned here:
 *
 * 1. DISK-MIRROR TRUNCATION: assemblePhaseContextInner() used to cap artifacts
 *    into `previousArtifacts` and then write THAT capped array to
 *    blueprints/<name>/<type>.md. The truncation marker promised "full text on
 *    disk at tasks.md" — but the disk file carried the same 60K cut. The
 *    fallback was self-defeating. Fix: write raw artifacts to disk first, then
 *    build the context array as capped copies that inherit filePath.
 *
 * 2. STATIC BUDGETS: ARTIFACT_CONTENT_MD_CAPS and ARTIFACT_BUDGET_CHARS were
 *    hardcoded — a 32K local model and a 1M-context Claude got identical
 *    budgets. Fix: artifactBudgetForTier() + tier-scaled cap tables, with
 *    medium = the historical values so callers without model info see zero
 *    behavior change.
 *
 * Also pins the save-time advisory: savePhaseArtifact() warns (never rejects)
 * when contentMd exceeds its type cap.
 *
 * Run: tsx src/main/services/__tests__/blueprint-artifact-cap.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ═══════════════════════════════════════════════════════════════════════
// Pure helpers — no DB
// ═══════════════════════════════════════════════════════════════════════

let artifactBudgetForTier: (tokens: number) => number
let ARTIFACT_BUDGETS_BY_TIER: Record<string, number>
let ARTIFACT_BUDGET_CHARS: number
let helpersLoaded = false
try {
  const loader = require('../blueprint-prompt-loader')
  artifactBudgetForTier = loader.artifactBudgetForTier
  ARTIFACT_BUDGETS_BY_TIER = loader.ARTIFACT_BUDGETS_BY_TIER
  ARTIFACT_BUDGET_CHARS = loader.ARTIFACT_BUDGET_CHARS
  helpersLoaded = true
} catch (err) {
  console.log(`⚠ blueprint-prompt-loader load failed — helper tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (helpersLoaded) {
  describe('artifactBudgetForTier presets', () => {
    test('small tier (32K tokens) gets the tightest budget', () => {
      assert.equal(artifactBudgetForTier(32_768), 25_000)
    })

    test('medium tier (128K tokens) equals the historical static budget', () => {
      assert.equal(artifactBudgetForTier(131_072), ARTIFACT_BUDGET_CHARS)
      assert.equal(artifactBudgetForTier(131_072), 50_000)
    })

    test('large tier (200K+ tokens, incl. Claude/GLM) gets the roomy budget', () => {
      assert.equal(artifactBudgetForTier(200_000), 100_000)
      assert.equal(artifactBudgetForTier(1_000_000), 100_000)
    })

    test('tier boundaries: 64K is small, 65K is medium, 128K+1 is large', () => {
      assert.equal(artifactBudgetForTier(65_536), 25_000)
      assert.equal(artifactBudgetForTier(65_537), 50_000)
      assert.equal(artifactBudgetForTier(131_073), 100_000)
    })

    test('the preset table is exhaustive over tiers', () => {
      assert.deepEqual(Object.keys(ARTIFACT_BUDGETS_BY_TIER).sort(), ['large', 'medium', 'small'])
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════
// DB-backed — disk mirror, tier caps, advisory warning
// ═══════════════════════════════════════════════════════════════════════

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintPhaseRepository: any
let blueprintService: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintPhaseRepository = repos.blueprintPhaseRepository
  blueprintService = require('../blueprint.service').blueprintService
} catch (err) {
  console.log(`⚠ artifact-cap DB setup failed — DB tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env) {
  describe('artifact caps (skipped — no DB)', () => {
    test('disk mirror round trip', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { mkdtempSync, readFileSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const { join, resolve: resolvePath } = require('node:path')

  const wsId = env.wsId

  function seedBlueprint(): string {
    const bp = blueprintRepository.create({ workspaceId: wsId, title: 'Cap test' })
    blueprintPhaseRepository.createAllPhases(bp.id)
    return bp.id
  }

  /** A tasks artifact body of ~n chars with a unique tail marker. */
  function bigBody(n: number, tail: string): string {
    return 'x'.repeat(n - tail.length) + tail
  }

  describe('disk mirror carries full text (THE REGRESSION)', () => {
    test('a >60K tasks artifact: disk file is full, context copy is capped', async () => {
      const id = seedBlueprint()
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      const tail = 'END-OF-FULL-TEXT'
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
        type: 'tasks',
        contentMd: bigBody(80_000, tail)
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-cap-disk-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'review', wsPath)

      const tasks = ctx.previousArtifacts.filter((a: any) => a.type === 'tasks')
      assert.equal(tasks.length, 1)

      // Context copy: capped at 60K + marker, tail NOT present.
      assert.ok(tasks[0].contentMd.length < 80_000, 'context copy must be capped')
      assert.ok(
        tasks[0].contentMd.includes('truncated'),
        'context copy carries the truncation marker'
      )
      assert.ok(!tasks[0].contentMd.includes(tail), 'tail lives past the cap')

      // Disk file: FULL text, no truncation marker, tail present.
      const diskPath = resolvePath(wsPath, tasks[0].filePath)
      const disk = readFileSync(diskPath, 'utf-8')
      assert.equal(disk.length, 80_000, 'disk mirror holds the full artifact')
      assert.ok(disk.endsWith(tail), 'the disk file reaches the end of the text')
      assert.ok(!disk.includes('truncated'), 'no truncation marker on disk')
    })

    test("the capped copy's marker references the real disk path", async () => {
      const id = seedBlueprint()
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'plan')
      blueprintPhaseRepository.appendArtifact(planPhase.id, {
        type: 'plan',
        contentMd: bigBody(50_000, 'PLAN-TAIL')
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-cap-path-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'tasks', wsPath)

      const plan = ctx.previousArtifacts.find((a: any) => a.type === 'plan')
      assert.ok(plan.filePath, 'filePath is set on the capped copy')
      assert.ok(plan.contentMd.includes(plan.filePath), 'the truncation marker names the disk path')
      // And that path really holds the full text.
      const disk = readFileSync(resolvePath(wsPath, plan.filePath), 'utf-8')
      assert.equal(disk.length, 50_000)
      assert.ok(disk.endsWith('PLAN-TAIL'))
    })

    test('small artifacts are untouched: no cap, no marker, disk matches', async () => {
      const id = seedBlueprint()
      const specPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'specify')
      blueprintPhaseRepository.appendArtifact(specPhase.id, {
        type: 'spec',
        contentMd: '# Spec\nsmall body'
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-cap-small-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'plan', wsPath)
      const spec = ctx.previousArtifacts.find((a: any) => a.type === 'spec')
      assert.equal(spec.contentMd, '# Spec\nsmall body')
      assert.equal(readFileSync(resolvePath(wsPath, spec.filePath), 'utf-8'), '# Spec\nsmall body')
    })
  })

  describe('tier-scaled caps via contextWindowTokens', () => {
    test('a 32K window caps tighter than a 200K window', async () => {
      const id = seedBlueprint()
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
        type: 'tasks',
        contentMd: bigBody(80_000, 'TIER-TAIL')
      })

      // Small tier: 30K cap → the 80K artifact is cut hard.
      const wsSmall = mkdtempSync(join(tmpdir(), 'bp-cap-small-tier-'))
      const ctxSmall = await blueprintService.assemblePhaseContext(id, 'review', wsSmall, 32_768)
      const small = ctxSmall.previousArtifacts.find((a: any) => a.type === 'tasks')
      assert.ok(small.contentMd.length <= 30_000 + 200, 'small-tier cap ≈30K')
      assert.ok(small.contentMd.includes('30,000'), 'marker names the small-tier cap')

      // Large tier: 120K cap → the 80K artifact passes through whole.
      const wsLarge = mkdtempSync(join(tmpdir(), 'bp-cap-large-tier-'))
      const ctxLarge = await blueprintService.assemblePhaseContext(id, 'review', wsLarge, 200_000)
      const large = ctxLarge.previousArtifacts.find((a: any) => a.type === 'tasks')
      assert.equal(large.contentMd.length, 80_000, 'large tier passes 80K through uncut')
      assert.ok(large.contentMd.endsWith('TIER-TAIL'))
    })

    test('artifactBudgetChars rides along with the tier', async () => {
      const id = seedBlueprint()
      const wsSmall = mkdtempSync(join(tmpdir(), 'bp-cap-budget-'))
      const ctxSmall = await blueprintService.assemblePhaseContext(id, 'plan', wsSmall, 32_768)
      assert.equal(ctxSmall.artifactBudgetChars, 25_000)

      const ctxLarge = await blueprintService.assemblePhaseContext(id, 'plan', wsSmall, 1_000_000)
      assert.equal(ctxLarge.artifactBudgetChars, 100_000)
    })

    test('REGRESSION GUARD: no contextWindowTokens → byte-identical caps to today', async () => {
      const id = seedBlueprint()
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
        type: 'tasks',
        contentMd: bigBody(80_000, 'GUARD-TAIL')
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-cap-guard-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'review', wsPath)

      // Static defaults: tasks cap 60K, budget absent (loader default 50K).
      const tasks = ctx.previousArtifacts.find((a: any) => a.type === 'tasks')
      assert.ok(tasks.contentMd.length > 60_000 && tasks.contentMd.length <= 60_000 + 200)
      assert.ok(tasks.contentMd.includes('60,000'), 'marker names the static 60K cap')
      assert.equal(ctx.artifactBudgetChars, undefined, 'no budget override without model info')
    })
  })

  describe('savePhaseArtifact advisory warning', () => {
    function captureEvents(): any[] {
      const events: any[] = []
      blueprintService.on('phaseProgress', (p: any) => events.push(p))
      return events
    }

    test('oversized tasks artifact → phaseProgress system message, still saved', () => {
      const id = seedBlueprint()
      const events = captureEvents()
      try {
        blueprintService.savePhaseArtifact(id, 'tasks', {
          type: 'tasks',
          contentMd: bigBody(84_000, 'BIG')
        })
      } finally {
        blueprintService.removeAllListeners('phaseProgress')
      }

      const saved = blueprintPhaseRepository
        .findByBlueprintAndPhase(id, 'tasks')
        .artifactsJson.filter((a: any) => a.type === 'tasks')
      assert.equal(saved.length, 1, 'advisory never rejects — artifact is saved')
      assert.equal(saved[0].contentMd.length, 84_000, 'saved in full, untruncated')

      const warnings = events.filter(
        (e) => e.kind === 'system' && e.text.includes('tasks artifact')
      )
      assert.equal(warnings.length, 1, 'exactly one advisory event')
      assert.ok(warnings[0].text.includes('84K'), 'message names the size')
      assert.ok(warnings[0].text.includes('truncated'), 'message says what happens downstream')
    })

    test('in-bounds artifact → silent, no event', () => {
      const id = seedBlueprint()
      const events = captureEvents()
      try {
        blueprintService.savePhaseArtifact(id, 'plan', {
          type: 'plan',
          contentMd: '# Plan\nsmall'
        })
      } finally {
        blueprintService.removeAllListeners('phaseProgress')
      }
      assert.equal(events.length, 0, 'no advisory for an in-bounds artifact')
    })

    test('boundary: exactly at cap → silent (cap is inclusive)', () => {
      const id = seedBlueprint()
      const events = captureEvents()
      try {
        blueprintService.savePhaseArtifact(id, 'specify', {
          type: 'spec',
          contentMd: 'y'.repeat(40_000)
        })
      } finally {
        blueprintService.removeAllListeners('phaseProgress')
      }
      assert.equal(events.length, 0)
    })
  })
}

// summaryAsync() calls process.exit() — only run it as the entry point.
if (require.main === module) {
  void summaryAsync()
}
