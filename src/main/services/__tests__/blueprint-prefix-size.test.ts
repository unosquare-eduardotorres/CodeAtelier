/**
 * blueprint-prefix-size.test.ts — characterization + ratchet for the BUILD prefix.
 *
 * WHY THIS EXISTS
 *
 * Measured on the packaged-app DB: the build phase carries ~31 API calls per
 * attempt and a 103K-token floor of task-invariant prefix. Token spend
 * factorises as `prefix_size × calls_per_attempt × attempts`, so every 10K
 * tokens shaved off the prefix saves ~310K context tokens per attempt.
 *
 * The problem with prefix work is that it is normally unmeasurable without a
 * live LLM run. This suite makes the prefix a number CI reports: it seeds a
 * blueprint with deterministic artifacts against a synthetic workspace, runs
 * the real `assemblePhaseContext` → `buildPhaseSystemPrompt` path, and prints
 * a per-block breakdown (artifacts / workspace docs / constitution / context
 * JSON / scaffold).
 *
 * THE ASSERTION IS A RATCHET, NOT A PIN. Each scenario asserts
 * `total <= BASELINE`, where BASELINE is the number observed when the step
 * landed. Prefix-reduction work lowers the constant; anything that grows the
 * prefix fails the build and has to justify itself by raising it explicitly.
 *
 * Three scenarios, because they move for different reasons:
 *   - `canonical` — one artifact per type, modest workspace docs. The everyday
 *     BUILD prefix. Moves with T2 (workspace-doc budget) and T3 (dedupe injections).
 *   - `revised`   — a re-run PLAN and TASKS left duplicate artifacts, and the
 *     workspace is doc-heavy. The 1-in-8 blueprint that doubles the prefix.
 *     Moves with T1 (newest-artifact-only) as well.
 *   - `review`    — the REVIEW phase, which is the one phase that actually
 *     consumes the tasks artifact (review-phase.md:121 asks for a task-coverage
 *     matrix). Tracked separately because A9 moved cost ONTO it deliberately:
 *     it is a single session in a creation phase (~1% of pipeline tokens),
 *     which is what pays for taking the stub away from BUILD.
 *
 * Run: tsx src/main/services/__tests__/blueprint-prefix-size.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ═══════════════════════════════════════════════════════════════════════
// Recorded baselines (chars of assembled BUILD system prompt)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Observed totals. Update DOWNWARD as prefix-reduction steps land, and record
 * the step that moved it. Raising one of these needs a stated reason.
 *
 *   2026-09-01  T0 baseline               canonical 38,378 · revised 123,346
 *   2026-09-01  T1 newest-artifact-only    canonical 38,378 · revised 119,841  (−3,505)
 *   2026-09-01  T2 workspace-doc budget    canonical 36,928 · revised  75,371  (−49,425)
 *   2026-09-01  T3 settings projection     canonical 36,928 · revised  75,371  (settings
 *                                          empty in this fixture — the win is on real
 *                                          blueprints carrying grill/revision ledgers)
 *   2026-09-01  P2 package.json majors     canonical 37,798 · revised  75,371  (+870)
 *                                          RAISED DELIBERATELY. summarizePackageJson used
 *                                          to emit dependency NAMES only; it now emits
 *                                          `dep: "^1"` — ~6 chars × 145 deps in this
 *                                          fixture — plus type/engines/packageManager.
 *                                          Bought: the major decides which API generation
 *                                          the builder writes against, and `type` decides
 *                                          ESM vs CJS for every file it creates. One retry
 *                                          costs far more than 220 tokens. The `revised`
 *                                          fixture is unmoved because its package.json is
 *                                          already past the workspace-doc budget.
 *   2026-09-01  A9 tasks projection        canonical 37,574 · revised 75,147 · review 51,400 (new)
 *                                          ASYMMETRIC, and both directions are deliberate.
 *                                          TASKS_PROJECTION_KEYS listed per-task leaf keys only,
 *                                          none of which is a top-level key of what TASKS emits,
 *                                          so the tasks artifact rendered as literal `{}` in every
 *                                          phase that received it. Fixing the allow-list makes it
 *                                          render for real, so `tasks` was dropped from BUILD's
 *                                          relevance set in the same step — BUILD already gets its
 *                                          task from blueprint_tasks rows via `## Current Task`,
 *                                          packet included, and build-phase.md:74 points it at the
 *                                          plan and spec.
 *                                          BUILD −224 chars (the dead `{}` stub, both scenarios).
 *                                          REVIEW is a NEW baseline at 51,400, of which the
 *                                          artifacts block is 20,793 — that is the task list
 *                                          review-phase.md:121 asks for and previously never got.
 *                                          It is affordable because REVIEW is one session in a
 *                                          creation phase (~1% of pipeline tokens) while BUILD is
 *                                          77–82%.
 *
 *   2026-09-03  E7 Tool Priority merge     canonical 38,811 · revised 76,384 · review 51,400
 *                                          RAISED, and the raise is an artefact of fixing the
 *                                          MEASUREMENT, not a prefix regression. Every earlier
 *                                          row measured the LOADER output only, while BUILD
 *                                          shipped `loader + TOOL_PRIORITY_DIRECTIVE_BUILDER`
 *                                          (1,415 chars) via its adapter. The ratchet was blind
 *                                          to that block, so moving text between template and
 *                                          adapter scored as pure win or pure regression purely
 *                                          by which side it landed on. BUILD is now measured
 *                                          through the adapter with an empty task tail.
 *                                          Like for like, the SHIPPED prefix fell:
 *                                            before  37,574 + 1,415 + 18 = 39,007
 *                                            after   38,811                (−196)
 *                                          Modest, and smaller than the −1.0 K the plan
 *                                          projected: of the 1,415 chars removed, ~1,237 came
 *                                          straight back into build-phase.md, because the merge
 *                                          was required to carry the inspection-vs-execution
 *                                          rule (~600), the file_outline / find_references
 *                                          orderings (~300) and the typecheck rung plus its
 *                                          "up to 2 rounds" bound (~330). What is genuinely gone
 *                                          is the DUPLICATE `## Tool Priority` heading and the
 *                                          re-stated code-graph routing lines — which was the
 *                                          defect. The +18 is the empty `## Current Task` header
 *                                          the adapter always appends.
 *
 * Cumulative: canonical −2.1%, revised −39.1% (loader-only basis, rows up to A9).
 */
const BASELINE_CHARS = {
  canonical: 38_811,
  revised: 76_384,
  review: 51_400
} as const

/** Slack for prompt-file wording edits, which are not prefix regressions. */
const TOLERANCE = 0.02

// ═══════════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════════

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let blueprintPhaseRepository: any
let blueprintService: any
let buildPhaseSystemPrompt: any
let formatArtifacts: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  const repos = require('../../db/repositories/blueprint.repository')
  blueprintRepository = repos.blueprintRepository
  blueprintPhaseRepository = repos.blueprintPhaseRepository
  blueprintService = require('../blueprint.service').blueprintService
  const loader = require('../blueprint-prompt-loader')
  buildPhaseSystemPrompt = loader.buildPhaseSystemPrompt
  formatArtifacts = loader.formatArtifacts
} catch (err) {
  console.log(`⚠ prefix-size setup failed — tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env) {
  describe('blueprint prefix size (skipped — no DB)', () => {
    test('BUILD prefix stays under baseline', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { mkdtempSync, writeFileSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const { join } = require('node:path')

  const wsId = env.wsId

  /** Deterministic filler of exactly `n` chars — no randomness, no clock. */
  function filler(n: number, marker: string): string {
    const unit = `${marker} line of representative prose about the change. `
    return unit.repeat(Math.ceil(n / unit.length)).slice(0, n)
  }

  /**
   * A plan artifact in the shape PLAN actually emits (`plan-phase.md:94`):
   * {summary, techStack, items[], risks, existingPatterns, mustHaves}.
   */
  function planArtifact(version: string, mdChars: number): Record<string, unknown> {
    return {
      type: 'plan',
      contentMd: `# Implementation Plan (${version})\n\n${filler(mdChars, version)}`,
      contentJson: {
        summary: `Plan ${version}`,
        techStack: {
          language: 'typescript',
          framework: 'electron',
          database: 'better-sqlite3',
          testing: 'tsx'
        },
        items: Array.from({ length: 24 }, (_, i) => ({
          id: `P${i}`,
          title: `Plan item ${i}`,
          description: filler(600, `d${i}`), // dropped by PLAN_PROJECTION_KEYS
          files: [`src/main/services/module-${i}.ts`],
          scope: 'backend',
          dependsOn: i > 0 ? [`P${i - 1}`] : [],
          includesTests: true,
          userStory: `US${Math.floor(i / 6)}`,
          isParallel: false
        })),
        risks: [filler(300, 'risk')],
        existingPatterns: [filler(400, 'pattern')],
        mustHaves: {
          truths: ['no schema change', 'no new dependency'],
          artifacts: [{ path: 'src/main/services/x.ts', provides: 'the service' }],
          keyLinks: [{ from: 'ipc', to: 'service', via: 'handler' }]
        }
      }
    }
  }

  /**
   * A tasks artifact in the shape TASKS actually emits (`tasks-phase.md:145`):
   * {totalTasks, waves[{wave, name, tasks[]}], userStoryPhases, mvpScope}.
   */
  function tasksArtifact(version: string, mdChars: number): Record<string, unknown> {
    return {
      type: 'tasks',
      contentMd: `# Task Breakdown (${version})\n\n${filler(mdChars, version)}`,
      contentJson: {
        totalTasks: 24,
        waves: Array.from({ length: 4 }, (_, w) => ({
          wave: w + 1,
          name: `Wave ${w + 1}`,
          tasks: Array.from({ length: 6 }, (_, i) => ({
            taskId: `T${w * 6 + i}`,
            description: filler(600, `t${w}${i}`),
            files: [`src/main/services/module-${w * 6 + i}.ts`],
            userStory: `US${w}`,
            isParallel: true,
            dependsOn: [],
            includesTests: true,
            packet: {
              interfaces: [`export function f${i}(): void`],
              acceptanceCriteria: [{ text: 'it works', howVerified: 'npm test' }],
              allowedFiles: [`src/main/services/module-${w * 6 + i}.ts`],
              testFiles: [`src/main/services/__tests__/module-${w * 6 + i}.test.ts`],
              conventions: ['services return null on a miss'],
              testCommand: 'npm test'
            }
          }))
        })),
        userStoryPhases: [{ story: 'US0', title: 'Story 0', priority: 'P1', taskIds: ['T0'] }],
        mvpScope: ['T0', 'T1']
      }
    }
  }

  /** Workspace with CLAUDE.md / README.md / package.json / PLAN.md at given sizes. */
  function seedWorkspace(prefix: string, sizes: Record<string, number>): string {
    const wsPath = mkdtempSync(join(tmpdir(), prefix))
    for (const [name, size] of Object.entries(sizes)) {
      if (size <= 0) continue
      const body =
        name === 'package.json'
          ? JSON.stringify(
              {
                name: 'fixture',
                version: '1.0.0',
                scripts: { build: 'vite build', test: 'tsx run-tests.ts' },
                dependencies: Object.fromEntries(
                  Array.from({ length: 20 }, (_, i) => [`dep-${i}`, '^1.0.0'])
                ),
                devDependencies: Object.fromEntries(
                  Array.from({ length: Math.ceil(size / 40) }, (_, i) => [`devdep-${i}`, '^1.0.0'])
                )
              },
              null,
              2
            )
          : filler(size, name)
      writeFileSync(join(wsPath, name), body, 'utf-8')
    }
    return wsPath
  }

  function seedBlueprint(title: string): string {
    const bp = blueprintRepository.create({ workspaceId: wsId, title })
    blueprintPhaseRepository.createAllPhases(bp.id)
    return bp.id
  }

  interface Breakdown {
    total: number
    artifacts: number
    workspaceDocs: number
    constitution: number
    contextJson: number
    scaffold: number
  }

  /**
   * Assemble the real context for `phase` and decompose the rendered prompt.
   *
   * BUILD is measured through its ADAPTER, not the loader. Until E7 the two
   * disagreed by 1,415 chars: `blueprint-build.adapter.ts` concatenated
   * `TOOL_PRIORITY_DIRECTIVE_BUILDER` onto the loader's output, so the ratchet
   * built to make prefix size a CI number was blind to a block that shipped in
   * every BUILD prompt — and moving text between the two was scored as pure
   * regression or pure win depending only on which side it landed on. The other
   * phases have no such tail and go through the loader directly.
   */
  async function measure(
    blueprintId: string,
    wsPath: string,
    phase: string = 'build'
  ): Promise<Breakdown> {
    const ctx = await blueprintService.assemblePhaseContext(
      blueprintId,
      phase,
      wsPath,
      200_000 // large tier — the Claude path
    )
    const prompt =
      phase === 'build'
        ? assembledBuildPrompt(blueprintId, ctx)
        : buildPhaseSystemPrompt(phase, ctx)

    const artifacts = formatArtifacts(ctx.previousArtifacts, ctx.artifactBudgetChars).length
    const workspaceDocs = ctx.workspaceDocs?.length ?? 0
    const constitution = ctx.constitution?.length ?? 0
    const contextJson = JSON.stringify(ctx.blueprint, null, 2).length
    return {
      total: prompt.length,
      artifacts,
      workspaceDocs,
      constitution,
      contextJson,
      scaffold: prompt.length - artifacts - workspaceDocs - constitution - contextJson
    }
  }

  /**
   * What the BUILD session actually receives, with an empty task tail — i.e.
   * the task-INVARIANT prefix, which is the thing re-sent on every one of the
   * ~31 calls per attempt and the only part prefix work can move.
   */
  function assembledBuildPrompt(blueprintId: string, ctx: unknown): string {
    const {
      BlueprintBuildAdapter
    } = require('../role-adapters/blueprint/blueprint-build.adapter')
    const adapter = new BlueprintBuildAdapter({
      workspaceId: wsId,
      blueprintId,
      phaseContext: ctx,
      taskContext: ''
    })
    return (adapter as any).buildPhaseSystemPrompt()
  }

  function report(scenario: string, b: Breakdown, baseline: number): void {
    const pct = (n: number): string => `${((n / b.total) * 100).toFixed(1)}%`.padStart(6)
    const delta = b.total - baseline
    console.log(
      `\n  [prefix:${scenario}] total ${b.total.toLocaleString()} chars ` +
        `(~${Math.round(b.total / 4).toLocaleString()} tokens) ` +
        `| baseline ${baseline.toLocaleString()} | delta ${delta >= 0 ? '+' : ''}${delta.toLocaleString()}`
    )
    console.log(`    artifacts       ${String(b.artifacts).padStart(8)} ${pct(b.artifacts)}`)
    console.log(`    workspace docs  ${String(b.workspaceDocs).padStart(8)} ${pct(b.workspaceDocs)}`)
    console.log(`    constitution    ${String(b.constitution).padStart(8)} ${pct(b.constitution)}`)
    console.log(`    context JSON    ${String(b.contextJson).padStart(8)} ${pct(b.contextJson)}`)
    console.log(`    prompt scaffold ${String(b.scaffold).padStart(8)} ${pct(b.scaffold)}`)
  }

  describe('BUILD prefix size — canonical blueprint', () => {
    test('total stays at or below the recorded baseline', async () => {
      const id = seedBlueprint('Prefix canonical')
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'plan')
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      blueprintPhaseRepository.appendArtifact(planPhase.id, planArtifact('v1', 20_000))
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, tasksArtifact('v1', 20_000))

      const wsPath = seedWorkspace('bp-prefix-canonical-', {
        'CLAUDE.md': 12_600,
        'README.md': 6_500,
        'package.json': 5_000
      })

      const b = await measure(id, wsPath)
      report('canonical', b, BASELINE_CHARS.canonical)

      const ceiling = Math.round(BASELINE_CHARS.canonical * (1 + TOLERANCE))
      assert.ok(
        b.total <= ceiling,
        `BUILD prefix grew: ${b.total} chars > ceiling ${ceiling} ` +
          `(baseline ${BASELINE_CHARS.canonical}). Lower the prefix or justify raising the baseline.`
      )
    })
  })

  describe('REVIEW prefix size — the phase that consumes the tasks artifact', () => {
    test('total stays at or below the recorded baseline', async () => {
      const id = seedBlueprint('Prefix review')
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'plan')
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      blueprintPhaseRepository.appendArtifact(planPhase.id, planArtifact('v1', 20_000))
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, tasksArtifact('v1', 20_000))

      const wsPath = seedWorkspace('bp-prefix-review-', {
        'CLAUDE.md': 12_600,
        'README.md': 6_500,
        'package.json': 5_000
      })

      const b = await measure(id, wsPath, 'review')
      report('review', b, BASELINE_CHARS.review)

      const ceiling = Math.round(BASELINE_CHARS.review * (1 + TOLERANCE))
      assert.ok(
        b.total <= ceiling,
        `REVIEW prefix grew: ${b.total} chars > ceiling ${ceiling} ` +
          `(baseline ${BASELINE_CHARS.review}). Lower the prefix or justify raising the baseline.`
      )
    })

    test('A9: REVIEW receives a real task list, BUILD receives none', async () => {
      // The bug this scenario exists for: TASKS_PROJECTION_KEYS listed only
      // per-task leaf keys, so projectFields matched no top-level key of the
      // emitted {totalTasks, waves[...]} shape and rendered literal `{}` —
      // REVIEW was asked for a coverage matrix while holding an empty object.
      const id = seedBlueprint('A9 asymmetry')
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'plan')
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      blueprintPhaseRepository.appendArtifact(planPhase.id, planArtifact('v1', 2_000))
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, tasksArtifact('v1', 2_000))
      const wsPath = seedWorkspace('bp-prefix-a9-', { 'CLAUDE.md': 2_000 })

      const reviewCtx = await blueprintService.assemblePhaseContext(id, 'review', wsPath, 200_000)
      const buildCtx = await blueprintService.assemblePhaseContext(id, 'build', wsPath, 200_000)

      const reviewBlock = formatArtifacts(
        reviewCtx.previousArtifacts,
        reviewCtx.artifactBudgetChars
      )
      assert.ok(reviewBlock.includes('"taskId"'), 'REVIEW must receive per-task ids')
      assert.ok(reviewBlock.includes('"totalTasks"'), 'REVIEW must receive the wave container')
      assert.ok(
        !reviewBlock.includes('### Artifact: tasks\n```json\n{}'),
        'the tasks artifact must not render as an empty object'
      )

      assert.ok(
        !buildCtx.previousArtifacts.some((a: { type: string }) => a.type === 'tasks'),
        'BUILD gets its task from `## Current Task`, not the tasks artifact'
      )
      assert.ok(
        buildCtx.previousArtifacts.some((a: { type: string }) => a.type === 'plan'),
        'BUILD still receives the plan'
      )
    })
  })

  describe('BUILD prefix size — revised blueprint (duplicate artifacts, doc-heavy repo)', () => {
    test('total stays at or below the recorded baseline', async () => {
      const id = seedBlueprint('Prefix revised')
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'plan')
      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(id, 'tasks')
      // PLAN and TASKS were both re-run — appendArtifact left the superseded copies behind.
      blueprintPhaseRepository.appendArtifact(planPhase.id, planArtifact('v1', 40_000))
      blueprintPhaseRepository.appendArtifact(planPhase.id, planArtifact('v2', 40_000))
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, tasksArtifact('v1', 35_000))
      blueprintPhaseRepository.appendArtifact(tasksPhase.id, tasksArtifact('v2', 35_000))

      // A doc-heavy workspace: every well-known doc present and over the per-file cap.
      const wsPath = seedWorkspace('bp-prefix-revised-', {
        'CLAUDE.md': 45_000,
        'README.md': 45_000,
        'PLAN.md': 45_000,
        'package.json': 20_000
      })

      const b = await measure(id, wsPath)
      report('revised', b, BASELINE_CHARS.revised)

      const ceiling = Math.round(BASELINE_CHARS.revised * (1 + TOLERANCE))
      assert.ok(
        b.total <= ceiling,
        `BUILD prefix grew: ${b.total} chars > ceiling ${ceiling} ` +
          `(baseline ${BASELINE_CHARS.revised}). Lower the prefix or justify raising the baseline.`
      )
    })

    test('A9: a re-run of PLAN does not inflate the artifacts block', async () => {
      // The artifacts block is the one T1 governs, so the ratio is measured on
      // it rather than on the total (where workspace docs dominate). Before
      // newest-artifact-only this was 2.0× — both plans were injected, the
      // older one first, so a big enough pair pushed the NEWEST plan past the
      // budget and the builder was handed a superseded plan.
      const canonicalId = seedBlueprint('Ratio canonical')
      const cPlan = blueprintPhaseRepository.findByBlueprintAndPhase(canonicalId, 'plan')
      blueprintPhaseRepository.appendArtifact(cPlan.id, planArtifact('v1', 40_000))
      const cWs = seedWorkspace('bp-prefix-ratio-c-', { 'CLAUDE.md': 12_600 })

      const revisedId = seedBlueprint('Ratio revised')
      const rPlan = blueprintPhaseRepository.findByBlueprintAndPhase(revisedId, 'plan')
      blueprintPhaseRepository.appendArtifact(rPlan.id, planArtifact('v1', 40_000))
      blueprintPhaseRepository.appendArtifact(rPlan.id, planArtifact('v2', 40_000))
      const rWs = seedWorkspace('bp-prefix-ratio-r-', { 'CLAUDE.md': 12_600 })

      const canonical = await measure(canonicalId, cWs)
      const revised = await measure(revisedId, rWs)
      const ratio = revised.artifacts / canonical.artifacts
      console.log(
        `\n  [prefix:ratio] artifacts block revised/canonical = ${ratio.toFixed(3)} ` +
        `(${revised.artifacts} vs ${canonical.artifacts} chars)`
      )
      assert.ok(
        ratio <= 1.02,
        `a re-run of PLAN inflated the artifacts block ${ratio.toFixed(2)}× — duplicates are reaching context`
      )
    })
  })
}

// ════════════════════════════════════════════════════════════════════════
// Gate T prediction — keeps §0.1's arithmetic honest
//
// DB-free on purpose: it runs even where the fixtures cannot.
// ════════════════════════════════════════════════════════════════════════

describe('Gate T prediction — the assembled prompt still implies the documented band', () => {
  test('BASELINE_CHARS + MCP schemas land in the 22-35 K token band §0.1 claims', () => {
    // docs/blueprint-execution-improvements.md §0.1 retracts "the next lever is
    // the BUILD prompt scaffold" on the strength of this arithmetic: the whole
    // invariant prefix is ~22-35 K tokens, so it cannot explain a 103 K "floor".
    // If the assembled prompt moves far enough that the band no longer holds,
    // the retraction's premise moved with it and the table needs re-deriving.
    const CHARS_PER_TOKEN = 4
    const MCP_SCHEMA_TOKENS = { min: 12_000, max: 16_000 } // 5 servers, §0.1
    const DOCUMENTED_BAND = { min: 22_000, max: 35_000 }
    const SLACK = 1_500 // the doc states the band to 1 significant figure

    const predictedMin = Math.round(BASELINE_CHARS.canonical / CHARS_PER_TOKEN) + MCP_SCHEMA_TOKENS.min
    const predictedMax = Math.round(BASELINE_CHARS.revised / CHARS_PER_TOKEN) + MCP_SCHEMA_TOKENS.max

    console.log(
      `\n  [prefix:predicted] invariant prefix ≈ ${predictedMin}-${predictedMax} tokens ` +
        `(documented ${DOCUMENTED_BAND.min}-${DOCUMENTED_BAND.max})`
    )

    assert.ok(
      Math.abs(predictedMin - DOCUMENTED_BAND.min) <= SLACK,
      `predicted prefix floor ${predictedMin} tokens no longer matches the documented ` +
        `${DOCUMENTED_BAND.min} — re-derive the §0.1 composition table before quoting it`
    )
    assert.ok(
      Math.abs(predictedMax - DOCUMENTED_BAND.max) <= SLACK,
      `predicted prefix ceiling ${predictedMax} tokens no longer matches the documented ` +
        `${DOCUMENTED_BAND.max} — re-derive the §0.1 composition table before quoting it`
    )

    // The falsifier itself: once a run populates turn_usage.prefix_tokens,
    // MIN() should land in this band. If it comes back near 100 K the fixtures
    // understate the real prefix and §0.1 is wrong, not the measurement.
    assert.ok(
      predictedMax < 65_000,
      'the predicted prefix exceeds the Gate T target on its own — the target, not the prefix, is the thing to revisit'
    )
  })
})

// ════════════════════════════════════════════════════════════════════════
// BUILD's MCP surface — keeps §0.1's `leanBuildMcp` column honest
//
// DB-free on purpose (the adapter's buildMcpConfig reads app preferences, so
// the tool LIST is asserted from the same constants it composes).
//
// §0.1 used to bill `leanBuildMcp` at the full 12–16 K of MCP schemas, which
// is the cost of ALL FIVE servers. The flag drops two of them. This test is
// the arithmetic, so the next person to quote a number has to move it here
// first.
// ════════════════════════════════════════════════════════════════════════

describe('BUILD MCP surface — the documented per-server split', () => {
  const { MCP_TOOLS } = require('../../../shared/constants')

  /** The servers `blueprint-build.adapter.ts:99–129` puts in `allowedTools`. */
  const BUILD_SERVERS = {
    CODE_GRAPH: 15, // always on — `repomapEnabled && workspaceId`
    SEMANTIC_SEARCH: 3, // dropped by leanBuildMcp
    GIT_CONTEXT: 4, // always on — the commit protocol depends on it
    CODE_ANALYSIS: 7, // dropped by leanBuildMcp
    MEMORY: 3 // always on — phase prompts call memory_search/memory_record
  } as const
  const LEAN_DROPS = ['SEMANTIC_SEARCH', 'CODE_ANALYSIS'] as const

  test('each server still carries the tool count §0.1 bills it for', () => {
    for (const [server, expected] of Object.entries(BUILD_SERVERS)) {
      assert.equal(
        MCP_TOOLS[server]._ALL_NAMES.length,
        expected,
        `${server} now exposes ${MCP_TOOLS[server]._ALL_NAMES.length} tools, not ${expected} — ` +
          're-derive the §0.1 MCP row before quoting it'
      )
    }
  })

  test('leanBuildMcp removes 10 of BUILD’s 32 tools — a third of the block, not all of it', () => {
    const total = Object.values(BUILD_SERVERS).reduce((a, b) => a + b, 0)
    const dropped = LEAN_DROPS.reduce((a, s) => a + BUILD_SERVERS[s], 0)

    console.log(
      `\n  [prefix:mcp] BUILD sends ${total} tools across ${Object.keys(BUILD_SERVERS).length} servers ` +
        `| leanBuildMcp drops ${dropped} (${((dropped / total) * 100).toFixed(0)} %) ` +
        `| code-graph alone is ${BUILD_SERVERS.CODE_GRAPH} (${((BUILD_SERVERS.CODE_GRAPH / total) * 100).toFixed(0)} %)`
    )

    assert.equal(total, 32, 'BUILD’s allowed-tool count moved — update §0.1')
    assert.equal(dropped, 10, 'the lean flag’s saving moved — update §0.1')

    // The claim the doc now makes, and the reason the flag is NOT the next
    // lever: code-graph on its own outweighs everything lean mode can remove.
    assert.ok(
      BUILD_SERVERS.CODE_GRAPH > dropped,
      'code-graph is supposed to be the larger candidate — if lean mode now removes more, ' +
        're-rank the two in §0.1 and §3 Phase T'
    )
  })
})

// summaryAsync() calls process.exit() — only run it as the entry point.
if (require.main === module) {
  void summaryAsync()
}
