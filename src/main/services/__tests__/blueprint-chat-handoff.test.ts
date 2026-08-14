/**
 * Blueprint → Chat handoff — intent table, seed message, adapter intent.
 *
 * Pure logic only: no DB, no Electron. The IPC orchestration around these
 * (conversation creation, branch takeover, handoff accept/reject) is exercised
 * by the conversation-crud and handoff service suites.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  BLUEPRINT_HANDOFF_INTENTS,
  resolveHandoffIntent,
  isBlueprintHandoffIntent
} from '../../../shared/blueprint-handoff'
import { composeHandoffMessage } from '../blueprint-handoff-message'
import { blueprintAdapter } from '../handoff-adapters/blueprint.adapter'
import type { BlueprintAdapterInput } from '../handoff-adapters/blueprint.adapter'
import type { BlueprintWithDetails } from '../../../shared/blueprint-types'

// ── Fixtures ─────────────────────────────────────────────────────────

function makeBlueprint(overrides: Partial<BlueprintWithDetails> = {}): BlueprintWithDetails {
  return {
    id: 'bp-1',
    workspaceId: 'ws-1',
    title: 'Checkout rewrite',
    shortName: 'checkout',
    description: 'Rebuild the checkout flow end to end',
    status: 'complete',
    currentPhase: 'verify',
    priority: 'P1',
    sourceIdeaId: null,
    constitutionSnapshot: null,
    settingsJson: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T01:00:00.000Z',
    completedAt: '2026-01-01T01:00:00.000Z',
    phases: [],
    tasks: [],
    ...overrides
  } as BlueprintWithDetails
}

// ── Intent table ─────────────────────────────────────────────────────

describe('blueprint handoff intents', () => {
  test('exposes the four documented intents', () => {
    const ids = BLUEPRINT_HANDOFF_INTENTS.map((s) => s.id).sort()
    assert.deepEqual(ids, ['continue', 'review', 'run', 'ship'])
  })

  test('every intent is usable — label, description, instruction, valid mode', () => {
    for (const spec of BLUEPRINT_HANDOFF_INTENTS) {
      assert.ok(spec.label.length > 0, `${spec.id} has no label`)
      assert.ok(spec.description.length > 0, `${spec.id} has no description`)
      assert.ok(spec.instruction.length > 40, `${spec.id} instruction is too thin`)
      assert.ok(spec.titlePrefix.length > 0, `${spec.id} has no title prefix`)
      assert.ok(
        spec.mode === 'plan' || spec.mode === 'build',
        `${spec.id} has an invalid mode: ${spec.mode}`
      )
    }
  })

  test('read-only intents open in plan mode, writing intents in build mode', () => {
    // A review opened in build mode invites the agent to start editing code the
    // user only asked it to look at.
    assert.equal(resolveHandoffIntent('review').mode, 'plan')
    assert.equal(resolveHandoffIntent('continue').mode, 'plan')
    assert.equal(resolveHandoffIntent('run').mode, 'build')
    assert.equal(resolveHandoffIntent('ship').mode, 'build')
  })

  test('unknown and missing intents fall back to continue', () => {
    assert.equal(resolveHandoffIntent(undefined).id, 'continue')
    assert.equal(resolveHandoffIntent('').id, 'continue')
    assert.equal(resolveHandoffIntent('deploy-to-prod').id, 'continue')
  })

  test('isBlueprintHandoffIntent guards the IPC boundary', () => {
    assert.equal(isBlueprintHandoffIntent('ship'), true)
    assert.equal(isBlueprintHandoffIntent('nope'), false)
    assert.equal(isBlueprintHandoffIntent(undefined), false)
    assert.equal(isBlueprintHandoffIntent(7), false)
  })
})

// ── Seed message ─────────────────────────────────────────────────────

describe('composeHandoffMessage', () => {
  const spec = resolveHandoffIntent('ship')

  test('keeps the envelope context and ends with the chosen instruction', () => {
    const msg = composeHandoffMessage({
      contextMarkdown: '## Blueprint Summary\n**Status:** complete',
      spec,
      branchName: 'blueprint/checkout-rewrite-abc12345',
      inheritedTrack: true
    })

    assert.ok(msg.includes('## Blueprint Summary'))
    assert.ok(msg.includes('**Status:** complete'))
    // The instruction is the freshest thing the agent reads.
    assert.ok(msg.trimEnd().endsWith(spec.instruction))
  })

  test('inherited worktree says the files are already here', () => {
    const msg = composeHandoffMessage({
      contextMarkdown: 'ctx',
      spec,
      branchName: 'blueprint/x-1',
      inheritedTrack: true
    })
    assert.ok(msg.includes('blueprint/x-1'))
    assert.ok(msg.includes('uncommitted changes included'))
    assert.ok(!msg.includes('workspace checkout rather than a branch'))
  })

  test('branch without inheritance does not promise the uncommitted files', () => {
    const msg = composeHandoffMessage({
      contextMarkdown: 'ctx',
      spec,
      branchName: 'blueprint/x-1',
      inheritedTrack: false
    })
    assert.ok(msg.includes('blueprint/x-1'))
    assert.ok(
      !msg.includes('uncommitted changes included'),
      'must not claim uncommitted work travelled when the tree was not inherited'
    )
  })

  test('no branch tells the agent it is in the workspace checkout', () => {
    const msg = composeHandoffMessage({
      contextMarkdown: 'ctx',
      spec,
      branchName: null,
      inheritedTrack: false
    })
    assert.ok(msg.includes('workspace checkout'))
    assert.ok(!msg.includes('took over'))
  })

  test('a declined branch is named, not silently reported as "no branch"', () => {
    // The user chose to leave the branch with the chat holding it. Saying the
    // output is "already in the working tree you are in" would be false.
    const msg = composeHandoffMessage({
      contextMarkdown: 'ctx',
      spec,
      branchName: null,
      inheritedTrack: false,
      unclaimedBranch: 'blueprint/x-1'
    })
    assert.ok(msg.includes('blueprint/x-1'))
    assert.ok(msg.includes('not'), 'must state the output is not in this working tree')
    assert.ok(
      !msg.includes('output is already in the working tree you are in'),
      'must not claim the output is present'
    )
  })

  test('inheritedTrack without a branch degrades to the checkout wording', () => {
    // Defensive: the two are derived separately in the IPC layer.
    const msg = composeHandoffMessage({
      contextMarkdown: 'ctx',
      spec,
      branchName: null,
      inheritedTrack: true
    })
    assert.ok(msg.includes('workspace checkout'))
  })
})

// ── Adapter intent ───────────────────────────────────────────────────

describe('blueprintAdapter intent', () => {
  const base = { workspaceId: 'ws-1', target: 'chat' as const }

  test('uses the picked intent when one is supplied', () => {
    const input: BlueprintAdapterInput = {
      blueprint: makeBlueprint(),
      intentSpec: resolveHandoffIntent('review')
    }
    const envelope = blueprintAdapter.toEnvelope(input, base)
    assert.equal(envelope.intent, 'Review: Checkout rewrite')
  })

  test('falls back to blueprint status when no intent is supplied', () => {
    const envelope = blueprintAdapter.toEnvelope({ blueprint: makeBlueprint() }, base)
    assert.ok(envelope.intent.startsWith('Blueprint complete:'))
  })

  test('an in-flight blueprint without an intent reads as continue', () => {
    const envelope = blueprintAdapter.toEnvelope(
      { blueprint: makeBlueprint({ status: 'building' }) },
      base
    )
    assert.ok(envelope.intent.startsWith('Continue blueprint:'))
  })

  test('the envelope targets chat and carries the blueprint id', () => {
    const envelope = blueprintAdapter.toEnvelope(
      { blueprint: makeBlueprint(), intentSpec: resolveHandoffIntent('ship') },
      { ...base, sourceSessionId: 'bp-1', createdBy: 'user' }
    )
    assert.equal(envelope.target, 'chat')
    assert.equal(envelope.source, 'blueprint')
    assert.equal(envelope.sourceSessionId, 'bp-1')
    assert.equal(envelope.createdBy, 'user')
    assert.equal((envelope.extensions as Record<string, unknown>).blueprintId, 'bp-1')
  })
})

// Only print a summary (and exit) when run directly — summaryAsync exits the
// process, which would truncate the rest of the suite under run-tests.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
