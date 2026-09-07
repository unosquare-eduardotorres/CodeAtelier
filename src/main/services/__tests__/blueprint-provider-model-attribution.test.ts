/**
 * A4 follow-up — provider/model attribution agreement for blueprint turns.
 *
 * Every usage row carries a `provider` and a `model`. They are resolved from two
 * DIFFERENT model actions:
 *
 *   provider ← BlueprintBaseAdapter.getLlmProvider()
 *              → blueprintSnapshotAssignment(bp, adapter.getModelAction())
 *   model    ← agent-stream-processor / agent-executor-factory
 *              → resolveModelFromSnapshot(..., resolveModelAction(adapter.role, isBuild))
 *
 * They agree only when `adapter.getModelAction() === resolveModelAction(role)`.
 * These tests pin exactly where that holds and where it does not, so the
 * divergence cannot widen unnoticed.
 *
 * Observed on blueprint 7624e83f (build→glm/glm-5.3, review→claude/claude-opus-5):
 *   - blueprint-code-review rows: provider='glm', model='claude-opus-5'
 *   - escalation rungs (feature blueprint-build): provider='claude', model='glm-5.3'
 *
 * Run via the suite: npm run test:unit
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { providerModelDisagree, resolveModelAction } from '../../../shared/constants'
import { resolveAdapterModelAction } from '../snapshot-model-resolver'
import type { AgentRole, ModelAction } from '../../../shared/types'

// ── providerModelDisagree ──

describe('providerModelDisagree', () => {
  test('claude model on a non-claude provider disagrees', () => {
    assert.equal(providerModelDisagree('glm', 'claude-opus-5'), true)
    assert.equal(providerModelDisagree('local-llm', 'claude-sonnet-4-6'), true)
  })

  test('non-claude model on the claude provider disagrees', () => {
    assert.equal(providerModelDisagree('claude', 'glm-5.3'), true)
    assert.equal(providerModelDisagree('claude', 'qwen2.5-coder'), true)
  })

  test('matching pairs agree', () => {
    assert.equal(providerModelDisagree('claude', 'claude-opus-5'), false)
    assert.equal(providerModelDisagree('glm', 'glm-5.3'), false)
    assert.equal(providerModelDisagree('local-llm', 'qwen2.5-coder'), false)
  })

  test('missing provider or model is not a disagreement', () => {
    assert.equal(providerModelDisagree(null, 'claude-opus-5'), false)
    assert.equal(providerModelDisagree('glm', null), false)
    assert.equal(providerModelDisagree(undefined, undefined), false)
  })
})

// ── Structural agreement: adapter action vs role-derived action ──

/** Constructed lazily so the electron stub is installed before the import. */
function adapterActionOf(instance: unknown): ModelAction {
  return (instance as { getModelAction(): ModelAction }).getModelAction()
}

const phaseContext = {
  workspaceName: 'ws',
  detectedTechs: [],
  specContent: '',
  planContent: '',
  tasksContent: '',
  buildContent: '',
  specFilePath: '',
  blueprintDir: '',
  grillDecisions: [],
  workspaceDocs: ''
}

describe('blueprint adapters: declared action vs role-derived action', () => {
  test('phase adapters with a dedicated role agree — provider and model share one snapshot entry', () => {
    const { BlueprintBuildAdapter } = require('../role-adapters/blueprint/blueprint-build.adapter')
    const {
      BlueprintSpecifyAdapter
    } = require('../role-adapters/blueprint/blueprint-specify.adapter')

    const build = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext,
      taskContext: '',
      taskId: 'T001',
      attempt: 1
    })
    assert.equal(adapterActionOf(build), 'blueprint:build')
    assert.equal(resolveModelAction(build.role as AgentRole, true), 'blueprint:build')

    const specify = new BlueprintSpecifyAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext
    })
    assert.equal(adapterActionOf(specify), 'blueprint:specify')
    assert.equal(resolveModelAction(specify.role as AgentRole, false), 'blueprint:specify')
  })

  test('CHARACTERIZATION: code-review resolves provider and model from different entries', () => {
    const {
      BlueprintCodeReviewAdapter
    } = require('../role-adapters/blueprint/blueprint-code-review.adapter')
    const adapter = new BlueprintCodeReviewAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext
    })
    // Provider comes from this action → snapshot key `codeReview`.
    assert.equal(adapterActionOf(adapter), 'blueprint:code-review')
    // Model comes from this one → snapshot key `review`. Different entry.
    assert.equal(resolveModelAction(adapter.role as AgentRole, false), 'blueprint:review')
    assert.notEqual(
      adapterActionOf(adapter),
      resolveModelAction(adapter.role as AgentRole, false),
      'when these differ, provider and model can contradict each other on mixed routing'
    )
  })

  test('CHARACTERIZATION: the escalation rung runs a BUILD adapter under lead-review', () => {
    const { BlueprintBuildAdapter } = require('../role-adapters/blueprint/blueprint-build.adapter')
    const escalated = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext,
      taskContext: '',
      taskId: 'T011',
      attempt: 3,
      modelAction: 'blueprint:lead-review'
    })
    // Provider is resolved from `blueprint:lead-review`, which has NO entry in
    // ACTION_SNAPSHOT_KEY — so it falls back to the workspace default provider…
    assert.equal(adapterActionOf(escalated), 'blueprint:lead-review')
    // …while the model still resolves from the `build` snapshot entry.
    assert.equal(resolveModelAction(escalated.role as AgentRole, true), 'blueprint:build')
    assert.notEqual(
      adapterActionOf(escalated),
      resolveModelAction(escalated.role as AgentRole, true),
      'escalation attributes provider and model to different actions'
    )
  })

  test('peer-review and lead-review declare actions with no snapshot key', () => {
    const {
      BlueprintPeerReviewAdapter
    } = require('../role-adapters/blueprint/blueprint-peer-review.adapter')
    const {
      BlueprintLeadReviewAdapter
    } = require('../role-adapters/blueprint/blueprint-lead-review.adapter')

    const peer = new BlueprintPeerReviewAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      taskId: 'T001',
      phaseContext,
      diff: '',
      packet: null,
      taskDescription: 'T'
    })
    assert.equal(adapterActionOf(peer), 'blueprint:peer-review')
    assert.equal(resolveModelAction(peer.role as AgentRole, false), 'blueprint:review')

    // Lead-review's constructor shape differs per adapter; only the action matters.
    assert.equal(
      BlueprintLeadReviewAdapter.prototype.getModelAction.call({}),
      'blueprint:lead-review'
    )
  })
})

// ── THE FIX: one action drives both provider and model ──

describe('resolveAdapterModelAction — provider and model share one action', () => {
  test('a blueprint adapter routes on its OWN declared action, not the role-derived one', () => {
    const {
      BlueprintCodeReviewAdapter
    } = require('../role-adapters/blueprint/blueprint-code-review.adapter')
    const adapter = new BlueprintCodeReviewAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext
    })
    // Before the fix this resolved 'blueprint:review' — the `review` snapshot
    // entry — while the provider came from `codeReview`.
    assert.equal(resolveAdapterModelAction(adapter, false), 'blueprint:code-review')
    assert.equal(resolveAdapterModelAction(adapter, false), adapterActionOf(adapter))
  })

  test('THE REGRESSION PIN: the escalation rung routes on lead-review, not build', () => {
    const { BlueprintBuildAdapter } = require('../role-adapters/blueprint/blueprint-build.adapter')
    const escalated = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext,
      taskContext: '',
      taskId: 'T011',
      attempt: 3,
      modelAction: 'blueprint:lead-review'
    })
    // This is the value handed to agent-executor-factory. Resolving 'blueprint:build'
    // here is what dispatched an escalation rung to the Claude CLI with a GLM model id.
    assert.equal(resolveAdapterModelAction(escalated, true), 'blueprint:lead-review')
    assert.equal(resolveAdapterModelAction(escalated, true), adapterActionOf(escalated))
    assert.notEqual(
      resolveAdapterModelAction(escalated, true),
      resolveModelAction(escalated.role as AgentRole, true)
    )
  })

  test('a plain build turn is unaffected — both paths still say blueprint:build', () => {
    const { BlueprintBuildAdapter } = require('../role-adapters/blueprint/blueprint-build.adapter')
    const build = new BlueprintBuildAdapter({
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      phaseContext,
      taskContext: '',
      taskId: 'T001',
      attempt: 1
    })
    assert.equal(resolveAdapterModelAction(build, true), 'blueprint:build')
    assert.equal(
      resolveAdapterModelAction(build, true),
      resolveModelAction(build.role as AgentRole, true)
    )
  })

  test('a non-blueprint adapter declares nothing and keeps the role-derived action', () => {
    // The default on BaseRoleAdapter returns undefined, so every adapter outside
    // the blueprint pipeline is behaviourally unchanged by this seam.
    const plain = { role: 'specialist' as AgentRole }
    assert.equal(resolveAdapterModelAction(plain, true), resolveModelAction('specialist', true))
    assert.equal(resolveAdapterModelAction(plain, false), resolveModelAction('specialist', false))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
