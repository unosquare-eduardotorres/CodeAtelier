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

  describe('A9 — the tasks artifact reaches REVIEW, not BUILD', () => {
    test('assemblePhaseContext: review gets tasks, build does not', async () => {
      const id = seedBlueprint()
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'plan')
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      blueprintPhaseRepository.appendArtifact(planPhase.id, {
        type: 'plan',
        contentMd: bigBody(2_000, 'PLAN-TAIL')
      })
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
        type: 'tasks',
        contentMd: bigBody(2_000, 'TASKS-TAIL')
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-cap-a9-'))
      const types = async (phase: string): Promise<string[]> => {
        const ctx = await blueprintService.assemblePhaseContext(id, phase, wsPath, 200_000)
        return ctx.previousArtifacts.map((a: any) => a.type)
      }

      const review = await types('review')
      assert.ok(review.includes('tasks'), 'REVIEW performs the cross-artifact coverage analysis')

      const build = await types('build')
      assert.ok(
        !build.includes('tasks'),
        'BUILD reads its task from `## Current Task` (blueprint_tasks rows)'
      )
      assert.ok(build.includes('plan'), 'BUILD still receives the plan')
    })

    test('REGRESSION: tasks.md is mirrored during BUILD even though tasks is not in context', async () => {
      // The disk mirror used to run on the relevance-filtered artifact list, so
      // dropping `tasks` from BUILD also stopped tasks.md being written. REVIEW
      // was then the only phase that mirrored it — and REVIEW is skippable,
      // while verify-phase.md:32-37 tells VERIFY to load tasks.md and VERIFY
      // deliberately carries no tasks JSON in context. This simulates the skip
      // by assembling BUILD directly, without REVIEW ever having assembled.
      const id = seedBlueprint()
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
        type: 'tasks',
        contentMd: bigBody(3_000, 'TASKS-ON-DISK')
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-cap-mirror-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'build', wsPath, 200_000)

      assert.ok(
        !ctx.previousArtifacts.some((a: any) => a.type === 'tasks'),
        'precondition: BUILD does not carry the tasks artifact in context'
      )

      const bp = blueprintRepository.findById(id)
      const diskPath = resolvePath(wsPath, `blueprints/${bp.shortName || id}/tasks.md`)
      const disk = readFileSync(diskPath, 'utf-8')
      assert.ok(
        disk.endsWith('TASKS-ON-DISK'),
        'tasks.md must reach disk for VERIFY even when no phase carries it in context'
      )
    })

    test('discoveries still reach BUILD', async () => {
      const id = seedBlueprint()
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
        type: 'discoveries',
        contentJson: { entries: ['auth flows through session.ts'] }
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-cap-a9-disc-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'build', wsPath, 200_000)
      assert.ok(ctx.previousArtifacts.some((a: any) => a.type === 'discoveries'))
    })
  })

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

    test('the mirror is written atomically — no temp file survives', async () => {
      // BUILD assembles its context ONCE per phase, so the concurrent readers
      // are the review passes: review-phase.md:21 points its agent at
      // blueprints/<name>/plan.md while those mirrors are being rewritten, so a
      // bare writeFileSync could hand it a truncated file. Write-then-rename
      // closes that window; this pins the observable half — the artifact lands
      // and nothing else is left behind.
      const id = seedBlueprint()
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'plan')
      blueprintPhaseRepository.appendArtifact(planPhase.id, {
        type: 'plan',
        contentMd: bigBody(20_000, 'ATOMIC-TAIL')
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-cap-atomic-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'tasks', wsPath, 200_000)
      const plan = ctx.previousArtifacts.find((a: any) => a.type === 'plan')
      const dir = resolvePath(wsPath, plan.filePath.slice(0, plan.filePath.lastIndexOf('/')))

      const { readdirSync } = require('node:fs')
      const leftovers = readdirSync(dir).filter((f: string) => f.includes('.tmp-'))
      assert.deepEqual(leftovers, [], 'no temp files left in the artifact directory')
      assert.ok(readFileSync(resolvePath(wsPath, plan.filePath), 'utf-8').endsWith('ATOMIC-TAIL'))
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

  describe('A9 — newest artifact per type reaches context', () => {
    test('two plans: only the newest is in context, both are on disk', async () => {
      const id = seedBlueprint()
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'plan')
      blueprintPhaseRepository.appendArtifact(planPhase.id, {
        type: 'plan',
        contentMd: bigBody(30_000, 'OLD-PLAN')
      })
      blueprintPhaseRepository.appendArtifact(planPhase.id, {
        type: 'plan',
        contentMd: bigBody(30_000, 'NEW-PLAN')
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-a9-newest-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'tasks', wsPath, 200_000)

      const plans = ctx.previousArtifacts.filter((a: any) => a.type === 'plan')
      assert.equal(plans.length, 1, 'the superseded plan never reaches context')
      assert.ok(plans[0].contentMd.endsWith('NEW-PLAN'), 'and the survivor is the newest')

      // The disk mirror still carries BOTH — the agent can Read the old one.
      const dir = plans[0].filePath.slice(0, plans[0].filePath.lastIndexOf('/'))
      assert.ok(
        readFileSync(resolvePath(wsPath, `${dir}/plan-1.md`), 'utf-8').endsWith('OLD-PLAN')
      )
      assert.ok(readFileSync(resolvePath(wsPath, `${dir}/plan.md`), 'utf-8').endsWith('NEW-PLAN'))
    })

    test('NOT SUPERSEDABLE: both build reports reach VERIFY', async () => {
      // blueprint-build.service.ts appends ONE build summary per BUILD run, and
      // VERIFY re-triggers BUILD for up to two remediation rounds. The second
      // report covers only the remediation tasks, so deduping to "newest" would
      // hand VERIFY a partial file list on exactly the runs that already went
      // wrong. `build` must accumulate.
      const id = seedBlueprint()
      const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'build')
      blueprintPhaseRepository.appendArtifact(buildPhase.id, {
        type: 'build',
        contentMd: '# Build\nfirst pass: src/a.ts, src/b.ts FIRST-BUILD'
      })
      blueprintPhaseRepository.appendArtifact(buildPhase.id, {
        type: 'build',
        contentMd: '# Build\nremediation: src/c.ts REMEDIATION-BUILD'
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-a9-build-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'verify', wsPath, 200_000)

      const builds = ctx.previousArtifacts.filter((a: any) => a.type === 'build')
      assert.equal(builds.length, 2, 'both build reports survive into VERIFY context')
      assert.ok(
        builds.some((a: any) => a.contentMd.includes('FIRST-BUILD')),
        'the original build report is not evicted by the remediation one'
      )
      assert.ok(builds.some((a: any) => a.contentMd.includes('REMEDIATION-BUILD')))
    })

    test('NOT SUPERSEDABLE: both build reports reach CODE-REVIEW too', async () => {
      const id = seedBlueprint()
      const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'build')
      for (const tail of ['CR-FIRST', 'CR-SECOND']) {
        blueprintPhaseRepository.appendArtifact(buildPhase.id, {
          type: 'build',
          contentMd: `# Build\n${tail}`
        })
      }

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-a9-build-cr-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'code-review', wsPath, 200_000)
      assert.equal(
        ctx.previousArtifacts.filter((a: any) => a.type === 'build').length,
        2,
        'code-review sees every build report, not just the newest'
      )
    })

    test('NOT SUPERSEDABLE: three discovery artifacts all survive — entries are merged', async () => {
      // formatArtifacts consolidates entries ACROSS discovery artifacts, so
      // deduping them would silently drop history rather than duplication.
      // The allow-list keeps 'discoveries' out by construction; asserted here
      // because the INTENT is load-bearing, not the mechanism.
      const id = seedBlueprint()
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      for (const n of ['one', 'two', 'three']) {
        blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
          type: 'discoveries',
          contentJson: { phase: 'tasks', entries: [`discovery-${n}`] }
        })
      }

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-a9-discoveries-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'review', wsPath, 200_000)

      const discoveries = ctx.previousArtifacts.filter((a: any) => a.type === 'discoveries')
      assert.equal(discoveries.length, 3, 'discoveries are not superseded by the newest')

      const loader = require('../blueprint-prompt-loader')
      const rendered = loader.formatArtifacts(ctx.previousArtifacts, ctx.artifactBudgetChars)
      for (const n of ['one', 'two', 'three']) {
        assert.ok(rendered.includes(`discovery-${n}`), `entry ${n} survives the merge`)
      }
    })

    test('NOT SUPERSEDABLE: a *-partial artifact rides along with its parent type', async () => {
      // '<phase>-partial' is the retry payload. It accompanies the parent
      // artifact rather than superseding it, so newest-only must not treat the
      // pair as duplicates of one another. Kept out of the allow-list
      // deliberately — asserted so a future widening of the list trips here.
      const id = seedBlueprint()
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'plan')
      blueprintPhaseRepository.appendArtifact(planPhase.id, {
        type: 'plan',
        contentMd: '# Plan\nthe real thing'
      })
      // The partial lives on the CURRENT phase's record, not a prior one.
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
        type: 'tasks-partial',
        contentMd: 'streamed output from the failed attempt'
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-a9-partial-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'tasks', wsPath, 200_000)

      const types = ctx.previousArtifacts.map((a: any) => a.type)
      assert.ok(types.includes('plan'), 'the parent artifact is present')
      assert.ok(types.includes('tasks-partial'), 'the retry payload is present')
    })

    test('two *-partial artifacts both survive (retry history is not deduped)', async () => {
      const id = seedBlueprint()
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
        type: 'tasks-partial',
        contentMd: 'attempt one'
      })
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
        type: 'tasks-partial',
        contentMd: 'attempt two'
      })

      const wsPath = mkdtempSync(join(tmpdir(), 'bp-a9-partial2-'))
      const ctx = await blueprintService.assemblePhaseContext(id, 'tasks', wsPath, 200_000)
      const partials = ctx.previousArtifacts.filter((a: any) => a.type === 'tasks-partial')
      assert.equal(partials.length, 2)
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
