/**
 * Unit tests for SpecialistBuilder pure methods:
 *   - fingerprintStack (3 lines — SHA-256 hash of sorted tech stack)
 *   - buildMetaPrompt (~90 lines — pure string template builder)
 *
 * fingerprintStack is private, so we replicate its exact logic (3 lines).
 * buildMetaPrompt is public — we import the SpecialistBuilder class and call it directly.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, describe, summaryAsync } from './test-harness'
import { specialistBuilderService } from '../specialist-builder.service'

// ── Replicate fingerprintStack (private, 3 lines — source line 439) ──

function fingerprintStack(detectedTechs: string[]): string {
  const sorted = [...detectedTechs].sort()
  return createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 16)
}

// ── Access public buildMetaPrompt via singleton ──

const builder = specialistBuilderService

// ── fingerprintStack tests ──

describe('fingerprintStack', () => {
  test('deterministic_same_techs_same_hash', () => {
    const h1 = fingerprintStack(['react', 'node', 'typescript'])
    const h2 = fingerprintStack(['react', 'node', 'typescript'])
    assert.equal(h1, h2)
  })

  test('different_techs_different_hash', () => {
    const h1 = fingerprintStack(['react', 'node'])
    const h2 = fingerprintStack(['vue', 'node'])
    assert.notEqual(h1, h2)
  })

  test('order_independent', () => {
    const h1 = fingerprintStack(['react', 'node', 'typescript'])
    const h2 = fingerprintStack(['typescript', 'react', 'node'])
    assert.equal(h1, h2, 'Sorting should make order irrelevant')
  })

  test('returns_16_char_hex_string', () => {
    const h = fingerprintStack(['react'])
    assert.equal(h.length, 16)
    assert.ok(/^[0-9a-f]{16}$/.test(h), `Expected hex string, got: ${h}`)
  })

  test('empty_array_produces_valid_hash', () => {
    const h = fingerprintStack([])
    assert.equal(h.length, 16)
    assert.ok(/^[0-9a-f]{16}$/.test(h))
  })
})

// ── buildMetaPrompt tests ──

describe('buildMetaPrompt', () => {
  test('includes_workspaceName', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'MyApp',
      detectedTechs: ['react'],
      claudeMdReference: 'ref',
      skeleton: 'skel'
    })
    assert.ok(result.includes('MyApp'))
  })

  test('includes_detected_techs', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'App',
      detectedTechs: ['react', 'typescript', 'node'],
      claudeMdReference: 'ref',
      skeleton: 'skel'
    })
    assert.ok(result.includes('react'))
    assert.ok(result.includes('typescript'))
    assert.ok(result.includes('node'))
  })

  test('empty_techs_shows_none_detected', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'App',
      detectedTechs: [],
      claudeMdReference: 'ref',
      skeleton: 'skel'
    })
    assert.ok(result.includes('(none detected)'))
  })

  test('includes_claudeMdReference', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'App',
      detectedTechs: [],
      claudeMdReference: 'My project uses Express and PostgreSQL',
      skeleton: 'skel'
    })
    assert.ok(result.includes('My project uses Express and PostgreSQL'))
  })

  test('includes_skeleton', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'App',
      detectedTechs: [],
      claudeMdReference: 'ref',
      skeleton: 'I am a senior engineer who specializes in...'
    })
    assert.ok(result.includes('I am a senior engineer who specializes in...'))
  })

  test('verbosity_lean_specifies_250_words', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'App',
      detectedTechs: [],
      claudeMdReference: 'ref',
      skeleton: 'skel',
      verbosity: 'lean'
    })
    assert.ok(result.includes('250'))
  })

  test('verbosity_full_specifies_400_words', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'App',
      detectedTechs: [],
      claudeMdReference: 'ref',
      skeleton: 'skel',
      verbosity: 'full'
    })
    assert.ok(result.includes('400'))
  })

  test('default_verbosity_uses_400_words', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'App',
      detectedTechs: [],
      claudeMdReference: 'ref',
      skeleton: 'skel'
    })
    assert.ok(result.includes('400'))
  })

  test('output_contains_Project_Specialist_reference', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'App',
      detectedTechs: [],
      claudeMdReference: 'ref',
      skeleton: 'skel'
    })
    assert.ok(result.includes('Project Specialist'))
  })

  test('output_contains_identity_section', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'App',
      detectedTechs: [],
      claudeMdReference: 'ref',
      skeleton: 'skel'
    })
    assert.ok(result.includes('## Your identity'))
    assert.ok(result.includes('## Decision heuristics'))
    assert.ok(result.includes('## Architecture instincts'))
  })

  test('large_tech_stack_handled', () => {
    const techs = Array.from({ length: 50 }, (_, i) => `tech-${i}`)
    const result = builder.buildMetaPrompt({
      workspaceName: 'App',
      detectedTechs: techs,
      claudeMdReference: 'ref',
      skeleton: 'skel'
    })
    assert.ok(result.includes('tech-0'))
    assert.ok(result.includes('tech-49'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
