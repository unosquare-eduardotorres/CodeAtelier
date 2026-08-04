/**
 * Phase 27 — handoff adapter pure-function tests.
 *
 * Tests the pure functions exported from:
 *  - handoff-adapters/base.adapter.ts (calculateConfidence)
 *  - handoff-adapters/target-adapters.ts (renderEnvelopeMarkdown, resolveTargetAction)
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'
import { calculateConfidence } from '../handoff-adapters/base.adapter'
import { renderEnvelopeMarkdown, resolveTargetAction } from '../handoff-adapters/target-adapters'
import type { HandoffEnvelope } from '../../../shared/handoff-types'

// ── helpers ──

function baseEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    id: 'hoff-1',
    version: 1,
    source: 'chat',
    target: 'chat',
    workspaceId: 'ws-1',
    intent: 'Fix the auth bug',
    originalGoal: 'Fix authentication module',
    contextSummary: 'Auth module has a session expiry bug',
    completedWork: [],
    remainingWork: [],
    decisions: [],
    constraints: [],
    risks: [],
    artifacts: [],
    filesToReadFirst: [],
    commandsToRunFirst: [],
    suggestedTools: [],
    suggestedSkills: [],
    confidence: 0.5,
    priority: 'medium',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    createdBy: 'system',
    ...overrides
  } as HandoffEnvelope
}

// ── calculateConfidence ──

describe('calculateConfidence — derived confidence scoring', () => {
  test('base confidence is 0.5 for empty envelope', () => {
    const confidence = calculateConfidence({})
    assert.equal(confidence, 0.5)
  })

  test('structuredPlanRef adds 0.2', () => {
    const confidence = calculateConfidence({ structuredPlanRef: 'plan-1' })
    assert.equal(confidence, 0.7)
  })

  test('decisions add 0.1', () => {
    const confidence = calculateConfidence({
      decisions: [{ what: 'Use JWT', why: 'Stateless', madeAt: '' }]
    })
    assert.equal(confidence, 0.6)
  })

  test('completedWork adds 0.1', () => {
    const confidence = calculateConfidence({
      completedWork: [{ title: 'Done', outcome: 'ok' }]
    })
    assert.equal(confidence, 0.6)
  })

  test('constraints add 0.05', () => {
    const confidence = calculateConfidence({
      constraints: ['Must use Node.js']
    })
    assert.equal(confidence, 0.55)
  })

  test('risks add 0.05', () => {
    const confidence = calculateConfidence({
      risks: [{ risk: 'Breaking change', severity: 'medium' }]
    })
    assert.equal(confidence, 0.55)
  })

  test('max confidence is 1.0', () => {
    const confidence = calculateConfidence({
      structuredPlanRef: 'plan-1',
      decisions: [{ what: 'a', why: 'b', madeAt: '' }],
      completedWork: [{ title: 'x', outcome: 'y' }],
      constraints: ['c'],
      risks: [{ risk: 'r', severity: 'low' }]
    })
    assert.equal(confidence, 1.0)
  })

  test('partial envelope scores correctly', () => {
    const confidence = calculateConfidence({
      structuredPlanRef: 'plan-1',
      decisions: [{ what: 'a', why: 'b', madeAt: '' }]
    })
    assert.equal(confidence, 0.8) // 0.5 + 0.2 + 0.1
  })
})

// ── renderEnvelopeMarkdown ──

describe('renderEnvelopeMarkdown — format rendering', () => {
  test('compact format returns short string ≤500 chars', () => {
    const env = baseEnvelope({
      completedWork: [{ title: 'Setup', outcome: 'Done' }],
      remainingWork: [{ title: 'Deploy', description: 'Deploy to prod', priority: 'high' }]
    })
    const result = renderEnvelopeMarkdown(env, 'compact')
    assert.ok(result.length <= 500)
    assert.ok(result.includes('Fix the auth bug'))
    assert.ok(result.includes('Setup'))
    assert.ok(result.includes('Deploy'))
  })

  test('standard format includes all sections', () => {
    const env = baseEnvelope({
      completedWork: [{ title: 'Auth fix', outcome: 'Session now refreshes correctly' }],
      remainingWork: [
        { title: 'Add tests', description: 'Unit tests for auth', priority: 'medium' }
      ],
      decisions: [{ what: 'Use JWT', why: 'Stateless sessions', madeAt: '' }],
      risks: [{ risk: 'Breaking change to API', severity: 'medium' }],
      filesToReadFirst: ['src/auth.ts']
    })
    const result = renderEnvelopeMarkdown(env, 'standard')
    assert.ok(result.includes('## Handoff'))
    assert.ok(result.includes('Completed Work'))
    assert.ok(result.includes('Remaining Work'))
    assert.ok(result.includes('Key Decisions'))
    assert.ok(result.includes('Risks'))
    assert.ok(result.includes('Files to Read First'))
  })

  test('standard format defaults when no format given', () => {
    const env = baseEnvelope()
    const result = renderEnvelopeMarkdown(env)
    assert.ok(result.includes('## Handoff'))
  })

  test('full format includes all details', () => {
    const env = baseEnvelope({
      completedWork: [{ title: 'Auth fix', outcome: 'Done' }],
      artifacts: [{ path: 'src/auth.ts', description: 'Auth module', type: 'file' }],
      commandsToRunFirst: ['npm test'],
      constraints: ['Must maintain backward compatibility'],
      codeAnchors: [{ file: 'src/auth.ts', title: 'Entry', line: 1 }]
    })
    const result = renderEnvelopeMarkdown(env, 'full')
    assert.ok(result.length > 0)
    assert.ok(result.includes('Auth fix'))
  })

  test('handles empty envelope gracefully', () => {
    const env = baseEnvelope()
    const result = renderEnvelopeMarkdown(env, 'standard')
    assert.ok(result.includes('Fix the auth bug'))
    // Should not include sections with no content
    assert.ok(!result.includes('Completed Work'))
    assert.ok(!result.includes('Remaining Work'))
  })
})

// ── resolveTargetAction ──

describe('resolveTargetAction — target routing', () => {
  test('chat target resolves to chat type action', () => {
    const env = baseEnvelope({ target: 'chat' })
    const action = resolveTargetAction(env)
    assert.equal(action.type, 'chat')
  })

  test('chat target action includes contextMarkdown', () => {
    const env = baseEnvelope({ target: 'chat' })
    const action = resolveTargetAction(env) as any
    assert.equal(typeof action.contextMarkdown, 'string')
    assert.ok(action.contextMarkdown.length > 0)
  })

  test('grill target resolves to grill type action', () => {
    const env = baseEnvelope({ target: 'grill' })
    const action = resolveTargetAction(env)
    assert.equal(action.type, 'grill')
  })

  test('goals target resolves to goals type action', () => {
    const env = baseEnvelope({
      target: 'goals',
      remainingWork: [{ title: 'Deploy', description: 'Deploy to prod', priority: 'high' }]
    })
    const action = resolveTargetAction(env)
    assert.equal(action.type, 'goals')
  })

  test('council target resolves to council type action', () => {
    const env = baseEnvelope({ target: 'council' })
    const action = resolveTargetAction(env)
    assert.equal(action.type, 'council')
  })

  test('blueprint target resolves to blueprint type action', () => {
    const env = baseEnvelope({ target: 'blueprint' })
    const action = resolveTargetAction(env)
    assert.equal(action.type, 'blueprint')
  })

  test('unknown target throws', () => {
    const env = baseEnvelope({ target: 'unknown' as any })
    assert.throws(() => resolveTargetAction(env), /Unknown handoff target/)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
