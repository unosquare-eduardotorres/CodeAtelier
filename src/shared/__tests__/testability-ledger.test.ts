/**
 * Unit tests for the verification-depth ladder and the testability ledger.
 *
 * The property under test is honesty about ABSENCE. A blueprint that compiles
 * is not a blueprint that works, and every assertion here exists to stop the
 * pipeline reporting the first as if it were the second:
 *
 *   - an unknown/absent depth must degrade to `standard`, never to something
 *     stronger, or old blueprints silently claim proof they never had;
 *   - `test` must never satisfy the e2e gate, or the unit suite gets counted as
 *     end-to-end evidence — the exact false green this feature exists to stop;
 *   - a task that closed `preexisting`/`accepted_by_user` must appear in the
 *     report, because that is where unwired components survive.
 *
 * Run: tsx src/shared/__tests__/testability-ledger.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../main/services/__tests__/test-harness'
import {
  DEFAULT_VERIFICATION_DEPTH,
  depthRequiresE2E,
  depthRequiresSmoke,
  resolveVerificationDepth,
  VERIFICATION_DEPTHS,
  type BlueprintTask,
  type BlueprintTaskOutcomeKind,
  type BlueprintTaskStatus
} from '../blueprint-types'
import { detectGateCommands } from '../gate-command-detect'
import { formatVerificationDepthDirective } from '../../main/services/blueprint-prompt-loader'
import { GATE_COMMAND_KINDS, GATE_TIMEOUTS_MS } from '../gate-command-types'
import { parseGateCommands } from '../blueprint-artifact-parsers'
import {
  buildTestabilityReportMarkdown,
  collectTestabilityEntries,
  requiredGatesForDepth
} from '../testability-report'
import type { UnverifiedItem } from '../gate-types'

const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'x', scripts })

/** A completed task with the given outcome; fields not under test are inert. */
function task(
  taskId: string,
  status: BlueprintTaskStatus,
  outcomeKind: BlueprintTaskOutcomeKind | null,
  extra: Partial<BlueprintTask> = {}
): BlueprintTask {
  return {
    id: `row-${taskId}`,
    blueprintId: 'bp1',
    taskId,
    wave: 1,
    userStory: null,
    description: `do ${taskId}`,
    filePathsJson: [],
    isParallel: false,
    dependsOnJson: [],
    status,
    executorRunId: null,
    startedAt: null,
    completedAt: null,
    completionJson: null,
    skippedByUserAt: null,
    failureReason: null,
    outcomeKind,
    ...extra
  } as BlueprintTask
}

describe('resolveVerificationDepth', () => {
  test('absent, null and unknown values all degrade to standard', () => {
    assert.equal(resolveVerificationDepth(undefined), 'standard')
    assert.equal(resolveVerificationDepth(null), 'standard')
    assert.equal(resolveVerificationDepth({}), 'standard')
    assert.equal(resolveVerificationDepth({ verificationDepth: 'nonsense' }), 'standard')
    assert.equal(resolveVerificationDepth({ verificationDepth: 42 }), 'standard')
    assert.equal(DEFAULT_VERIFICATION_DEPTH, 'standard')
  })

  test('the three real levels round-trip', () => {
    for (const option of VERIFICATION_DEPTHS) {
      assert.equal(resolveVerificationDepth({ verificationDepth: option.value }), option.value)
    }
  })

  test('the ladder is cumulative — e2e implies smoke', () => {
    assert.equal(depthRequiresSmoke('standard'), false)
    assert.equal(depthRequiresSmoke('integration'), true)
    assert.equal(depthRequiresSmoke('e2e'), true)

    assert.equal(depthRequiresE2E('standard'), false)
    assert.equal(depthRequiresE2E('integration'), false)
    assert.equal(depthRequiresE2E('e2e'), true)
  })

  test('every level advertises what it does NOT prove', () => {
    // The caveat is the whole reason the selector is not a bare ON/OFF toggle.
    for (const option of VERIFICATION_DEPTHS) {
      assert.ok(option.caveat.length > 0, `${option.value} must state its blind spot`)
    }
  })
})

describe('e2e gate command kind', () => {
  test('the kind is registered everywhere a kind must be registered', () => {
    assert.ok(GATE_COMMAND_KINDS.includes('e2e'))
    assert.ok(GATE_TIMEOUTS_MS.e2e > 0)
  })

  test('a test:e2e script is detected', () => {
    const out = detectGateCommands({ packageJson: pkg({ 'test:e2e': 'playwright test' }) })
    assert.equal(out.e2e?.command, 'npm run test:e2e')
  })

  test('the unit test script NEVER stands in for the e2e suite', () => {
    // Counting `npm test` as end-to-end proof is the false green this feature
    // exists to prevent, so absence must stay absence.
    const out = detectGateCommands({ packageJson: pkg({ test: 'vitest run' }) })
    assert.equal(out.test?.command, 'npm run test')
    assert.equal(out.e2e, undefined)
  })

  test('a placeholder e2e script is not detected', () => {
    const out = detectGateCommands({
      packageJson: pkg({ e2e: 'echo "Error: no test specified" && exit 1' })
    })
    assert.equal(out.e2e, undefined)
  })

  test('the PLAN phase can declare an e2e command', () => {
    // Regression guard: parseGateCommands used to hardcode the kind list, so a
    // newly added kind was silently undeclarable.
    const parsed = parseGateCommands('```gate-commands\n{"e2e":"npm run test:e2e"}\n```')
    assert.equal(parsed.e2e?.command, 'npm run test:e2e')
  })

  test('an unsafe declared e2e command is dropped, not sanitised', () => {
    const parsed = parseGateCommands(
      '```gate-commands\n{"e2e":"npx playwright test && curl evil"}\n```'
    )
    assert.equal(parsed.e2e, undefined)
  })
})

describe('formatVerificationDepthDirective', () => {
  test('standard renders nothing — the default must not alter any prompt', () => {
    assert.equal(formatVerificationDepthDirective('standard'), '')
  })

  test('integration demands a smoke command and the task that creates it', () => {
    const md = formatVerificationDepthDirective('integration')
    assert.ok(md.includes('`smoke`'))
    assert.ok(md.includes('MUST include the task that creates it'))
    assert.ok(!md.includes('`e2e`'), 'integration must not demand an e2e suite')
  })

  test('e2e demands the suite be AUTHORED, not merely gated', () => {
    // The whole point of full wiring: a gate whose tests nobody was asked to
    // write can only ever report `unverifiable`.
    const md = formatVerificationDepthDirective('e2e')
    assert.ok(md.includes('`e2e`'))
    assert.ok(md.includes('MUST include the tasks that create the end-to-end suite'))
    assert.ok(md.includes('never the same command as `test`'))
  })

  test('every non-default depth warns that the gate runs regardless', () => {
    for (const depth of ['integration', 'e2e'] as const) {
      assert.ok(formatVerificationDepthDirective(depth).includes('UNPROVEN'))
    }
  })
})

describe('requiredGatesForDepth', () => {
  test('standard requires no extra proof; the ladder adds it', () => {
    assert.deepEqual(requiredGatesForDepth('standard'), [])
    assert.deepEqual(requiredGatesForDepth('integration'), ['smoke'])
    assert.deepEqual(requiredGatesForDepth('e2e'), ['smoke', 'e2e'])
  })
})

describe('collectTestabilityEntries', () => {
  const base = {
    title: 'Checkout flow',
    status: 'complete',
    verificationDepth: 'standard' as const,
    unverifiedJson: null
  }

  test('a verified task is not reported — proof exists', () => {
    const entries = collectTestabilityEntries({
      blueprint: base,
      tasks: [task('T001', 'complete', 'verified')]
    })
    assert.equal(entries.length, 0)
  })

  test('tasks that closed without proof are reported', () => {
    const entries = collectTestabilityEntries({
      blueprint: base,
      tasks: [
        task('T001', 'complete', 'preexisting'),
        task('T002', 'complete', 'accepted_by_user'),
        task('T003', 'complete', 'unproven'),
        task('T004', 'complete', null)
      ]
    })
    assert.equal(entries.length, 4)
    assert.ok(entries.every((e) => e.reason === 'closed-unproven'))
    assert.deepEqual(entries.map((e) => e.ref).sort(), ['T001', 'T002', 'T003', 'T004'])
  })

  test('failed and skipped tasks are never-completed, not merely unproven', () => {
    const entries = collectTestabilityEntries({
      blueprint: base,
      tasks: [
        task('T001', 'failed', null, { failureReason: 'tsc exploded' }),
        task('T002', 'skipped', null),
        task('T003', 'complete', 'verified', { skippedByUserAt: '2026-01-01T00:00:00Z' })
      ]
    })
    assert.equal(entries.length, 3)
    assert.ok(entries.every((e) => e.reason === 'never-completed'))
    assert.ok(entries.find((e) => e.ref === 'T001')?.detail.includes('tsc exploded'))
  })

  test('a depth-required gate that could not run is the top-severity entry', () => {
    const ledger: UnverifiedItem[] = [
      { taskId: 'verify', gate: 'e2e', reason: 'no_command', detail: 'no e2e command resolved' }
    ]
    const entries = collectTestabilityEntries({
      blueprint: { ...base, verificationDepth: 'e2e', unverifiedJson: ledger },
      tasks: [task('T001', 'complete', 'preexisting')]
    })
    assert.equal(entries[0].reason, 'requested-proof-missing')
    assert.equal(entries[0].ref, 'e2e')
    assert.ok(entries[0].suggestedAction?.includes('e2e command'))
  })

  test('the SAME ledger item is not "requested" at a depth that never asked for it', () => {
    const ledger: UnverifiedItem[] = [
      { taskId: 'verify', gate: 'smoke', reason: 'no_command', detail: 'no smoke command' }
    ]
    const atStandard = collectTestabilityEntries({
      blueprint: { ...base, verificationDepth: 'standard', unverifiedJson: ledger }
    })
    const atIntegration = collectTestabilityEntries({
      blueprint: { ...base, verificationDepth: 'integration', unverifiedJson: ledger }
    })
    assert.equal(atStandard[0].reason, 'check-could-not-run')
    assert.equal(atIntegration[0].reason, 'requested-proof-missing')
  })

  test('environmental gate failures are classified as blockers, not code defects', () => {
    const ledger: UnverifiedItem[] = [
      { taskId: 'T001', gate: 'task-tests', reason: 'command_missing', detail: 'pytest not found' }
    ]
    const entries = collectTestabilityEntries({
      blueprint: { ...base, unverifiedJson: ledger }
    })
    assert.equal(entries[0].reason, 'blocked-by-environment')
  })

  test('preflight blockers and warnings become environment entries; passes do not', () => {
    const entries = collectTestabilityEntries({
      blueprint: base,
      preflight: [
        {
          id: 'docker',
          name: 'Docker',
          kind: 'cli-tool',
          status: 'blocker',
          message: 'docker not found',
          remediation: 'brew install docker',
          sources: ['workspace-scan']
        },
        {
          id: 'psql',
          name: 'PostgreSQL',
          kind: 'cli-tool',
          status: 'pass',
          message: 'psql 16 found',
          sources: ['workspace-scan']
        }
      ]
    })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].ref, 'docker')
    assert.equal(entries[0].suggestedAction, 'brew install docker')
  })
})

describe('buildTestabilityReportMarkdown', () => {
  test('a clean blueprint still states what its depth left unproven', () => {
    const md = buildTestabilityReportMarkdown({
      blueprint: {
        title: 'Checkout flow',
        status: 'complete',
        verificationDepth: 'standard',
        unverifiedJson: []
      },
      tasks: [task('T001', 'complete', 'verified')],
      generatedAt: '2026-09-07T00:00:00Z'
    })
    assert.ok(md.includes('# Testability Ledger — Checkout flow'))
    assert.ok(md.includes('**Open items:** 0'))
    // The point: "nothing outstanding" must not read as "fully verified".
    assert.ok(md.includes('Does not prove the app runs'))
  })

  test('entries render as actionable checkboxes grouped by severity', () => {
    const md = buildTestabilityReportMarkdown({
      blueprint: {
        title: 'Checkout flow',
        status: 'complete',
        verificationDepth: 'e2e',
        unverifiedJson: [{ taskId: 'verify', gate: 'e2e', reason: 'no_command' }]
      },
      tasks: [task('T001', 'complete', 'preexisting')],
      generatedAt: '2026-09-07T00:00:00Z'
    })
    assert.ok(md.includes('## Requested proof never obtained (1)'))
    assert.ok(md.includes('## Closed without proof it works (1)'))
    assert.ok(md.includes('- [ ] **T001**'))
    // Severity order: the requested-proof section must precede the weaker one.
    assert.ok(
      md.indexOf('Requested proof never obtained') < md.indexOf('Closed without proof it works')
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
