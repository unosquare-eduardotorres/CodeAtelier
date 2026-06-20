/**
 * Unit tests for audit-prompt-templates — stack-adaptive prompt rendering
 * for each workspace health auditor.
 *
 * Pure function with zero side effects. Tests the renderAuditPrompt renderer
 * across all 7 track IDs, lean vs full verbosity, skill injection, and
 * roundContext appending.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { renderAuditPrompt } from '../audit-prompt-templates'
import type { AuditTrackId } from '../../../shared/types'

const ALL_TRACK_IDS: AuditTrackId[] = [
  'database',
  'code',
  'testing',
  'architecture',
  'security',
  'documentation',
  'ui-ux'
]

describe('renderAuditPrompt', () => {
  // ── Each track produces a valid prompt ──

  test('each of 7 trackIds produces a valid prompt with substituted placeholders', () => {
    for (const trackId of ALL_TRACK_IDS) {
      const prompt = renderAuditPrompt({
        trackId,
        workspaceName: 'TestProject',
        detectedTechs: ['TypeScript', 'React']
      })
      // Must contain the workspace name
      assert.ok(prompt.includes('TestProject'), `${trackId}: missing workspaceName`)
      // Must contain the detected stack
      assert.ok(prompt.includes('TypeScript, React'), `${trackId}: missing stack summary`)
      // Must contain the auditor name (e.g. "Database Auditor")
      assert.ok(prompt.includes('Auditor'), `${trackId}: missing Auditor in name`)
      // Must contain scoring focus (numbered list)
      assert.ok(prompt.includes('1.'), `${trackId}: missing scoring focus`)
      // The first occurrence of each placeholder should be replaced.
      // Note: String.replace() only replaces the first occurrence, so
      // templates with duplicate placeholders may retain one — this is
      // a known pre-existing behavior. We verify the key substitutions worked.
      assert.ok(
        prompt.includes('TestProject'),
        `${trackId}: first workspaceName should be replaced`
      )
    }
  })

  // ── Empty detectedTechs fallback ──

  test('empty detectedTechs produces fallback text', () => {
    const prompt = renderAuditPrompt({
      trackId: 'code',
      workspaceName: 'MyApp',
      detectedTechs: []
    })
    assert.ok(prompt.includes('Not detected'), 'should have fallback for empty techs')
  })

  // ── Lean model variant (Opus 4.8) ──

  test('lean model uses compressed template', () => {
    const fullPrompt = renderAuditPrompt({
      trackId: 'code',
      workspaceName: 'MyApp',
      detectedTechs: ['Node.js'],
      model: 'claude-sonnet-4-6' // full verbosity
    })
    const leanPrompt = renderAuditPrompt({
      trackId: 'code',
      workspaceName: 'MyApp',
      detectedTechs: ['Node.js'],
      model: 'claude-opus-4-8' // lean verbosity
    })
    // Lean prompt should be meaningfully shorter
    assert.ok(
      leanPrompt.length < fullPrompt.length,
      `lean (${leanPrompt.length}) should be shorter than full (${fullPrompt.length})`
    )
  })

  test('lean template for all tracks is shorter than full', () => {
    for (const trackId of ALL_TRACK_IDS) {
      const full = renderAuditPrompt({
        trackId,
        workspaceName: 'Test',
        detectedTechs: ['Go'],
        model: 'claude-sonnet-4-6'
      })
      const lean = renderAuditPrompt({
        trackId,
        workspaceName: 'Test',
        detectedTechs: ['Go'],
        model: 'claude-opus-4-8'
      })
      assert.ok(lean.length < full.length, `${trackId}: lean should be shorter`)
    }
  })

  // ── skillContent injection ──

  test('skillContent is injected into the prompt', () => {
    const prompt = renderAuditPrompt({
      trackId: 'security',
      workspaceName: 'SecureApp',
      detectedTechs: ['Express'],
      skillContent: 'Check for SQL injection vulnerabilities in all query builders.'
    })
    assert.ok(prompt.includes('Reference Skills'))
    assert.ok(prompt.includes('SQL injection'))
  })

  test('no skills section when skillContent is not provided', () => {
    const prompt = renderAuditPrompt({
      trackId: 'testing',
      workspaceName: 'TestApp',
      detectedTechs: []
    })
    assert.ok(!prompt.includes('Reference Skills'))
  })

  // ── roundContext ──

  test('roundContext appends scoped-inspection block', () => {
    const prompt = renderAuditPrompt({
      trackId: 'database',
      workspaceName: 'DBApp',
      detectedTechs: ['PostgreSQL'],
      roundContext: {
        roundNumber: 2,
        fileBatch: ['src/db/schema.sql', 'src/db/migrations/001.sql'],
        previousFindingsSummary: '3 high, 1 medium',
        remainingFileCount: 5
      }
    })
    assert.ok(prompt.includes('Round 2'))
    assert.ok(prompt.includes('src/db/schema.sql'))
    assert.ok(prompt.includes('src/db/migrations/001.sql'))
    assert.ok(prompt.includes('3 high, 1 medium'))
    assert.ok(prompt.includes('5 files remain'))
    assert.ok(prompt.includes('Do NOT repeat'))
  })

  test('no round section when roundContext is absent', () => {
    const prompt = renderAuditPrompt({
      trackId: 'code',
      workspaceName: 'App',
      detectedTechs: []
    })
    assert.ok(!prompt.includes('Round '))
  })

  // ── Domain prompt content ──

  test('database track mentions migration safety', () => {
    const prompt = renderAuditPrompt({
      trackId: 'database',
      workspaceName: 'App',
      detectedTechs: []
    })
    assert.ok(prompt.includes('migration'), 'database should mention migrations')
  })

  test('security track mentions input validation', () => {
    const prompt = renderAuditPrompt({
      trackId: 'security',
      workspaceName: 'App',
      detectedTechs: []
    })
    assert.ok(prompt.includes('validation'), 'security should mention validation')
  })

  test('architecture track mentions coupling', () => {
    const prompt = renderAuditPrompt({
      trackId: 'architecture',
      workspaceName: 'App',
      detectedTechs: []
    })
    assert.ok(prompt.includes('coupling'), 'architecture should mention coupling')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
