/**
 * base.adapter.ts — toEnvelope() end-to-end behavioural coverage.
 *
 * calculateConfidence() and the concrete adapters' extract* overrides are
 * covered elsewhere (handoff-adapters-p27.test.ts, target-adapters tests).
 * This file exercises the piece nothing else touches: the abstract base
 * class's toEnvelope() assembly method itself — truncation, TTL math,
 * defaults, the size guard, and that redaction is actually applied to the
 * returned envelope (not just available as a separately-tested function).
 *
 * A minimal concrete subclass is defined in-file so every extract* input can
 * be controlled precisely, independent of any real domain's fixture shape.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import { HandoffSourceAdapter } from '../handoff-adapters/base.adapter'
import { HANDOFF_TTL_DAYS, MAX_ENVELOPE_SIZE_BYTES } from '../../../shared/handoff-types'
import type {
  HandoffSource,
  CompletedStep,
  RemainingStep,
  HandoffDecision,
  HandoffRisk,
  ArtifactRef
} from '../../../shared/handoff-types'

// ── A minimal, fully-controllable concrete adapter for exercising the base class ──

interface FixtureInput {
  intent: string
  originalGoal: string
  contextSummary: string
  completedWork?: CompletedStep[]
  remainingWork?: RemainingStep[]
  decisions?: HandoffDecision[]
  constraints?: string[]
  risks?: HandoffRisk[]
  artifacts?: ArtifactRef[]
  structuredPlanRef?: string
}

class FixtureAdapter extends HandoffSourceAdapter<FixtureInput> {
  readonly source: HandoffSource = 'chat'

  extractIntent(input: FixtureInput): string {
    return input.intent
  }
  extractOriginalGoal(input: FixtureInput): string {
    return input.originalGoal
  }
  extractContextSummary(input: FixtureInput): string {
    return input.contextSummary
  }
  extractCompletedWork(input: FixtureInput): CompletedStep[] {
    return input.completedWork ?? []
  }
  extractRemainingWork(input: FixtureInput): RemainingStep[] {
    return input.remainingWork ?? []
  }
  extractDecisions(input: FixtureInput): HandoffDecision[] {
    return input.decisions ?? []
  }
  extractConstraints(input: FixtureInput): string[] {
    return input.constraints ?? []
  }
  extractRisks(input: FixtureInput): HandoffRisk[] {
    return input.risks ?? []
  }
  extractArtifacts(input: FixtureInput): ArtifactRef[] {
    return input.artifacts ?? []
  }
  extractStructuredPlanRef(input: FixtureInput): string | undefined {
    return input.structuredPlanRef
  }
}

const adapter = new FixtureAdapter()

function baseFixture(overrides: Partial<FixtureInput> = {}): FixtureInput {
  return {
    intent: 'Fix the thing',
    originalGoal: 'Original user goal',
    contextSummary: 'Some context summary text',
    ...overrides
  }
}

// ── toEnvelope() — identity + defaults ──

describe('base.adapter toEnvelope — identity and defaults', () => {
  test('assigns source, target, workspaceId from base input', () => {
    const env = adapter.toEnvelope(baseFixture(), { workspaceId: 'ws-1', target: 'grill' })
    assert.equal(env.source, 'chat')
    assert.equal(env.target, 'grill')
    assert.equal(env.workspaceId, 'ws-1')
    assert.equal(env.version, 1)
  })

  test('generates a fresh UUID id per call', () => {
    const e1 = adapter.toEnvelope(baseFixture(), { workspaceId: 'ws-1', target: 'chat' })
    const e2 = adapter.toEnvelope(baseFixture(), { workspaceId: 'ws-1', target: 'chat' })
    assert.notEqual(e1.id, e2.id)
    assert.match(e1.id, /^[0-9a-f-]{36}$/)
  })

  test('priority defaults to medium when omitted', () => {
    const env = adapter.toEnvelope(baseFixture(), { workspaceId: 'ws-1', target: 'chat' })
    assert.equal(env.priority, 'medium')
  })

  test('priority is honored when provided', () => {
    const env = adapter.toEnvelope(baseFixture(), {
      workspaceId: 'ws-1',
      target: 'chat',
      priority: 'critical'
    })
    assert.equal(env.priority, 'critical')
  })

  test('createdBy defaults to system when omitted', () => {
    const env = adapter.toEnvelope(baseFixture(), { workspaceId: 'ws-1', target: 'chat' })
    assert.equal(env.createdBy, 'system')
  })

  test('createdBy is honored when provided', () => {
    const env = adapter.toEnvelope(baseFixture(), {
      workspaceId: 'ws-1',
      target: 'chat',
      createdBy: 'user'
    })
    assert.equal(env.createdBy, 'user')
  })

  test('parentHandoffId and sourceSessionId pass through unchanged', () => {
    const env = adapter.toEnvelope(baseFixture(), {
      workspaceId: 'ws-1',
      target: 'chat',
      parentHandoffId: 'hoff-parent',
      sourceSessionId: 'sess-1'
    })
    assert.equal(env.parentHandoffId, 'hoff-parent')
    assert.equal(env.sourceSessionId, 'sess-1')
  })

  test('optional-override extractors default to empty arrays', () => {
    const env = adapter.toEnvelope(baseFixture(), { workspaceId: 'ws-1', target: 'chat' })
    assert.deepEqual(env.codeAnchors, [])
    assert.deepEqual(env.suggestedTools, [])
    assert.deepEqual(env.suggestedSkills, [])
    assert.deepEqual(env.filesToReadFirst, [])
    assert.deepEqual(env.commandsToRunFirst, [])
    assert.equal(env.structuredPlanRef, undefined)
    assert.equal(env.extensions, undefined)
  })
})

// ── toEnvelope() — intent truncation boundary ──

describe('base.adapter toEnvelope — intent truncation (120 char boundary)', () => {
  test('intent at exactly 120 chars is not truncated', () => {
    const intent = 'x'.repeat(120)
    const env = adapter.toEnvelope(baseFixture({ intent }), { workspaceId: 'ws-1', target: 'chat' })
    assert.equal(env.intent, intent)
    assert.equal(env.intent.length, 120)
    assert.ok(!env.intent.endsWith('...'))
  })

  test('intent at 121 chars is truncated to 120 chars with a "..." suffix', () => {
    const intent = 'y'.repeat(121)
    const env = adapter.toEnvelope(baseFixture({ intent }), { workspaceId: 'ws-1', target: 'chat' })
    assert.equal(env.intent.length, 120)
    assert.ok(env.intent.endsWith('...'))
    assert.equal(env.intent, 'y'.repeat(117) + '...')
  })

  test('short intent is left untouched', () => {
    const env = adapter.toEnvelope(baseFixture({ intent: 'short' }), {
      workspaceId: 'ws-1',
      target: 'chat'
    })
    assert.equal(env.intent, 'short')
  })
})

// ── toEnvelope() — TTL math ──

describe('base.adapter toEnvelope — expiresAt TTL', () => {
  test('expiresAt is exactly createdAt + HANDOFF_TTL_DAYS days', () => {
    const env = adapter.toEnvelope(baseFixture(), { workspaceId: 'ws-1', target: 'chat' })
    const created = new Date(env.createdAt).getTime()
    const expires = new Date(env.expiresAt!).getTime()
    const expectedMs = HANDOFF_TTL_DAYS * 24 * 60 * 60 * 1000
    assert.equal(expires - created, expectedMs)
  })
})

// ── toEnvelope() — confidence derived from actual extractor output ──

describe('base.adapter toEnvelope — confidence derived from real extractors', () => {
  test('confidence reflects the extractor outputs actually returned', () => {
    const env = adapter.toEnvelope(
      baseFixture({
        structuredPlanRef: 'plan-1',
        decisions: [{ what: 'a', why: 'b' }],
        completedWork: [{ title: 'x', outcome: 'y' }],
        constraints: ['c'],
        risks: [{ risk: 'r', severity: 'low' }]
      }),
      { workspaceId: 'ws-1', target: 'chat' }
    )
    assert.equal(env.confidence, 1.0)
  })

  test('confidence is the 0.5 floor when every optional field is empty', () => {
    const env = adapter.toEnvelope(baseFixture(), { workspaceId: 'ws-1', target: 'chat' })
    assert.equal(env.confidence, 0.5)
  })
})

// ── toEnvelope() — MAX_ENVELOPE_SIZE_BYTES guard ──

describe('base.adapter toEnvelope — size guard', () => {
  test('throws when the assembled envelope exceeds MAX_ENVELOPE_SIZE_BYTES', () => {
    const hugeContext = 'a'.repeat(MAX_ENVELOPE_SIZE_BYTES + 1000)
    assert.throws(
      () =>
        adapter.toEnvelope(baseFixture({ contextSummary: hugeContext }), {
          workspaceId: 'ws-1',
          target: 'chat'
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        // Names the actual byte count and the configured maximum.
        assert.match(err.message, /exceeds max size/)
        assert.match(err.message, new RegExp(String(MAX_ENVELOPE_SIZE_BYTES)))
        return true
      }
    )
  })

  test('does not throw for a normally-sized envelope', () => {
    assert.doesNotThrow(() => {
      adapter.toEnvelope(baseFixture(), { workspaceId: 'ws-1', target: 'chat' })
    })
  })
})

// ── toEnvelope() — redaction is actually applied ──

describe('base.adapter toEnvelope — redaction pipeline is applied to the output', () => {
  test('a secret-shaped token in intent does not survive into the returned envelope', () => {
    const secret = 'sk-ant-' + 'a'.repeat(30)
    const env = adapter.toEnvelope(baseFixture({ intent: `Fix key ${secret}`.slice(0, 40) }), {
      workspaceId: 'ws-1',
      target: 'chat'
    })
    assert.ok(!env.intent.includes(secret), 'secret token leaked into intent')
    assert.match(env.intent, /\[REDACTED:anthropic-key\]/)
  })

  test('an absolute /Users/ path in contextSummary is normalized', () => {
    const env = adapter.toEnvelope(
      baseFixture({ contextSummary: 'See /Users/alice/project/src/file.ts for details' }),
      { workspaceId: 'ws-1', target: 'chat' }
    )
    assert.ok(!env.contextSummary.includes('/Users/alice'))
    assert.ok(env.contextSummary.includes('~/project/src/file.ts'))
  })

  test('constraints array elements are individually redacted', () => {
    const env = adapter.toEnvelope(
      baseFixture({ constraints: ['Contact admin@example.com for access'] }),
      { workspaceId: 'ws-1', target: 'chat' }
    )
    assert.ok(!env.constraints[0].includes('admin@example.com'))
    assert.match(env.constraints[0], /\[REDACTED:email\]/)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
