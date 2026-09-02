/**
 * blueprint-prompt-dedupe.test.ts — E7: stop injecting the same text twice, and
 * cap the last uncapped block in the prefix.
 *
 * TWO FIXES PINNED HERE
 *
 * 1. SETTINGS PROJECTION. `{{BLUEPRINT_CONTEXT_JSON}}` serialised
 *    `blueprint.settings` whole. That bag had accumulated two LEDGERS —
 *    `grillDecisions` and `revisionRequests` — each of which already has a
 *    purpose-built formatter ({{GRILL_DECISIONS}}, {{REVISION_FEEDBACK}}).
 *    So every phase carried the same content twice, the second time as raw
 *    pretty-printed JSON, in the task-invariant prefix that BUILD re-sends on
 *    ~31 calls per attempt. It also carried operational junk the agent cannot
 *    act on: modelSnapshot, buildBaselineCommit, round counters.
 *
 *    The projection is a WHITELIST, not a denylist, precisely because
 *    settingsJson is a free-form bag: an unrecognised future setting must stay
 *    out of the prefix by default.
 *
 * 2. CONSTITUTION CAP. The constitution is injected into every phase, is fully
 *    task-invariant, and was the only remaining uncapped block. Caps are
 *    tier-scaled and generous — a constitution the agent must obey is the worst
 *    thing to truncate, so this is a ceiling, not compression.
 *
 * Run: tsx src/main/services/__tests__/blueprint-prompt-dedupe.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import {
  projectBlueprintForPrompt,
  capConstitution,
  CONSTITUTION_CAPS_BY_TIER,
  buildPhaseSystemPrompt
} from '../blueprint-prompt-loader'
import type { PhaseContext } from '../../../shared/blueprint-types'

function makeContext(overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    blueprint: {
      id: 'bp-1',
      title: 'Add auth',
      shortName: 'add-auth',
      description: 'Add authentication',
      priority: 'medium' as PhaseContext['blueprint']['priority'],
      currentPhase: 'build',
      settings: {}
    },
    constitution: null,
    previousArtifacts: [],
    specFilePath: 'blueprints/add-auth/spec.md',
    blueprintDir: 'blueprints/add-auth',
    ...overrides
  } as PhaseContext
}

// ═══════════════════════════════════════════════════════════════════════
// Settings projection
// ═══════════════════════════════════════════════════════════════════════

describe('projectBlueprintForPrompt', () => {
  test('THE FIX: the grill and revision LEDGERS are dropped', () => {
    const ctx = makeContext({
      blueprint: {
        ...makeContext().blueprint,
        settings: {
          grillDecisions: [{ header: 'Auth', selectedOption: 'OAuth2', reason: 'standard' }],
          revisionRequests: [{ round: 1, at: 'now', phase: 'plan', feedback: 'use sessions' }]
        }
      }
    })

    const projected = projectBlueprintForPrompt(ctx.blueprint)
    assert.deepEqual(projected.settings, {}, 'both ledgers are gone')
  })

  test('operational junk the agent cannot act on is dropped', () => {
    const projected = projectBlueprintForPrompt({
      ...makeContext().blueprint,
      settings: {
        modelSnapshot: { build: { model: 'claude-opus-4-7' } },
        buildBaselineCommit: 'abc123',
        leadReviewRound: 1,
        codeReviewFixRound: 2,
        remediationRound: 3,
        referenceDocuments: [{ type: 'file', path: 'a.pdf' }]
      }
    })
    assert.deepEqual(projected.settings, {})
  })

  test('settings the agent DOES reason about survive', () => {
    const projected = projectBlueprintForPrompt({
      ...makeContext().blueprint,
      settings: { branchName: 'feat/auth', jiraIssueKey: 'MUL-2336', modelSnapshot: {} }
    })
    assert.deepEqual(projected.settings, { branchName: 'feat/auth', jiraIssueKey: 'MUL-2336' })
  })

  test('the blueprint header itself is untouched', () => {
    const header = { ...makeContext().blueprint, settings: { branchName: 'x', junk: 1 } }
    const projected = projectBlueprintForPrompt(header)
    assert.equal(projected.id, header.id)
    assert.equal(projected.title, header.title)
    assert.equal(projected.currentPhase, header.currentPhase)
    assert.notEqual(projected, header, 'projection does not mutate the caller’s object')
    assert.deepEqual(header.settings, { branchName: 'x', junk: 1 }, 'original bag is intact')
  })

  test('an empty or absent settings bag is survivable', () => {
    assert.deepEqual(projectBlueprintForPrompt(makeContext().blueprint).settings, {})
    const noSettings = { ...makeContext().blueprint, settings: undefined }
    assert.equal(
      projectBlueprintForPrompt(noSettings as unknown as PhaseContext['blueprint']).settings,
      undefined
    )
  })

  test('END TO END: a rendered BUILD prompt no longer leaks the ledgers', () => {
    const ctx = makeContext({
      blueprint: {
        ...makeContext().blueprint,
        settings: {
          grillDecisions: [
            { header: 'Auth', selectedOption: 'OAuth2', reason: 'LEDGER-CANARY-TEXT' }
          ]
        }
      }
    })
    const prompt = buildPhaseSystemPrompt('build', ctx)
    assert.ok(
      !prompt.includes('LEDGER-CANARY-TEXT'),
      'the raw settings dump no longer reaches the build prefix'
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Constitution cap
// ═══════════════════════════════════════════════════════════════════════

describe('capConstitution', () => {
  test('a normal constitution passes through byte-identical', () => {
    const text = '# Constitution\n- Services return null on a miss.'
    assert.equal(capConstitution(text, 'large'), text)
    assert.equal(capConstitution(text, 'small'), text)
  })

  test('an oversized constitution is cut and says so', () => {
    const text = 'x'.repeat(50_000)
    const capped = capConstitution(text, 'medium')
    assert.ok(capped.length <= CONSTITUTION_CAPS_BY_TIER.medium + 200)
    assert.ok(capped.includes('constitution truncated'))
    assert.ok(capped.includes('use Read'), 'the agent is told where the rest lives')
  })

  test('tiers scale: small cuts hardest, large is roomiest', () => {
    const text = 'y'.repeat(100_000)
    const small = capConstitution(text, 'small').length
    const medium = capConstitution(text, 'medium').length
    const large = capConstitution(text, 'large').length
    assert.ok(small < medium && medium < large)
  })

  test('no tier → medium, which is the historical-equivalent default', () => {
    const text = 'z'.repeat(100_000)
    assert.equal(capConstitution(text).length, capConstitution(text, 'medium').length)
  })

  test('the cap table is exhaustive over tiers', () => {
    assert.deepEqual(Object.keys(CONSTITUTION_CAPS_BY_TIER).sort(), ['large', 'medium', 'small'])
  })

  test('END TO END: the cap applies through buildPhaseSystemPrompt', () => {
    const uncapped = buildPhaseSystemPrompt(
      'build',
      makeContext({ constitution: 'q'.repeat(100_000), contextTier: 'small' })
    )
    assert.ok(
      uncapped.length < 100_000,
      'a 100K constitution can no longer put 100K chars in every prefix'
    )
    assert.ok(uncapped.includes('constitution truncated'))
  })

  test('a phase assembled without model info still renders its constitution', () => {
    const prompt = buildPhaseSystemPrompt('build', makeContext({ constitution: '# Rules\nbe kind' }))
    assert.ok(prompt.includes('be kind'))
  })
})

// summaryAsync() calls process.exit() — only run it as the entry point.
if (require.main === module) {
  void summaryAsync()
}
