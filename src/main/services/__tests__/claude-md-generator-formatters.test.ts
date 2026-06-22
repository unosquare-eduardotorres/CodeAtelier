/**
 * Unit tests for claude-md-generator.ts — exported formatter functions.
 *
 * Tests formatDecisions, formatTrackScores, and buildTemplateFallback directly.
 * The existing claude-md-generator.test.ts covers the top-level generateClaudeMd
 * (0-decisions path). This file covers the now-exported helpers with branch coverage.
 *
 * Phase 4C — ~12 tests. All pure logic.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  formatDecisions,
  formatTrackScores,
  buildTemplateFallback
} from '../claude-md-generator'
import type { GrillDecision, GrillTrackScore } from '../../../shared/types'

// ── formatDecisions ──

describe('formatDecisions', () => {
  test('empty decisions → fallback text', () => {
    const result = formatDecisions([])
    assert.equal(result, 'No decisions captured.')
  })

  test('single track with one decision', () => {
    const decisions: GrillDecision[] = [
      {
        trackId: 'tech-stack' as any,
        questionId: 'q1',
        questionText: 'Language?',
        selectedOption: 'TypeScript'
      }
    ]
    const result = formatDecisions(decisions)
    assert.ok(result.includes('### tech-stack'))
    assert.ok(result.includes('**Language?**: TypeScript'))
  })

  test('multiple tracks grouped correctly', () => {
    const decisions: GrillDecision[] = [
      {
        trackId: 'tech-stack' as any,
        questionId: 'q1',
        questionText: 'Language?',
        selectedOption: 'TypeScript'
      },
      {
        trackId: 'architecture' as any,
        questionId: 'q2',
        questionText: 'Pattern?',
        selectedOption: 'Hexagonal'
      },
      {
        trackId: 'tech-stack' as any,
        questionId: 'q3',
        questionText: 'Framework?',
        selectedOption: 'React'
      }
    ]
    const result = formatDecisions(decisions)
    // Both track headings present
    assert.ok(result.includes('### tech-stack'))
    assert.ok(result.includes('### architecture'))
    // tech-stack has two decisions
    const techSection = result.split('### architecture')[0]
    assert.ok(techSection.includes('Language?'))
    assert.ok(techSection.includes('Framework?'))
  })

  test('decision with otherText includes parenthetical', () => {
    const decisions: GrillDecision[] = [
      {
        trackId: 'security' as any,
        questionId: 'q1',
        questionText: 'Auth strategy?',
        selectedOption: 'Other',
        otherText: 'Custom JWT'
      }
    ]
    const result = formatDecisions(decisions)
    assert.ok(result.includes('Other (Custom JWT)'))
  })
})

// ── formatTrackScores ──

describe('formatTrackScores', () => {
  test('empty scores → fallback text', () => {
    const result = formatTrackScores([])
    assert.equal(result, 'No track scores available.')
  })

  test('multiple scores formatted correctly', () => {
    const scores: GrillTrackScore[] = [
      {
        trackId: 'tech-stack' as any,
        score: 85,
        scoreLabel: 'Strong',
        iterationCount: 3,
        lastFeedback: 'Good choices'
      },
      {
        trackId: 'security' as any,
        score: 60,
        scoreLabel: 'Adequate',
        iterationCount: 2,
        lastFeedback: 'Needs auth review'
      }
    ]
    const result = formatTrackScores(scores)
    assert.ok(result.includes('**tech-stack**: 85/100 (Strong)'))
    assert.ok(result.includes('**security**: 60/100 (Adequate)'))
    assert.ok(result.includes('Good choices'))
    assert.ok(result.includes('Needs auth review'))
  })

  test('score label formatting preserved', () => {
    const scores: GrillTrackScore[] = [
      {
        trackId: 'testing' as any,
        score: 42,
        scoreLabel: 'Needs Work',
        iterationCount: 1,
        lastFeedback: 'Add coverage'
      }
    ]
    const result = formatTrackScores(scores)
    assert.ok(result.includes('42/100 (Needs Work)'))
  })
})

// ── buildTemplateFallback ──

describe('buildTemplateFallback', () => {
  test('includes project name in title', () => {
    const result = buildTemplateFallback('MyApp', 'A cool app')
    assert.ok(result.includes('# Project: MyApp'))
  })

  test('includes description in overview', () => {
    const result = buildTemplateFallback('MyApp', 'A cool app')
    assert.ok(result.includes('A cool app'))
  })

  test('empty description → "No description provided."', () => {
    const result = buildTemplateFallback('MyApp', '')
    assert.ok(result.includes('No description provided.'))
  })

  test('with decisions → includes Key Decisions section', () => {
    const decisions: GrillDecision[] = [
      {
        trackId: 'tech-stack' as any,
        questionId: 'q1',
        questionText: 'Language?',
        selectedOption: 'TypeScript'
      }
    ]
    const result = buildTemplateFallback('MyApp', 'Desc', decisions)
    assert.ok(result.includes('## Key Decisions'))
    assert.ok(result.includes('**Language?**: TypeScript'))
  })

  test('without decisions → no Key Decisions section', () => {
    const result = buildTemplateFallback('MyApp', 'Desc')
    assert.ok(!result.includes('Key Decisions'))
  })

  test('empty decisions array → no Key Decisions section', () => {
    const result = buildTemplateFallback('MyApp', 'Desc', [])
    assert.ok(!result.includes('Key Decisions'))
  })

  test('decision with otherText', () => {
    const decisions: GrillDecision[] = [
      {
        trackId: 'testing' as any,
        questionId: 'q1',
        questionText: 'Test framework?',
        selectedOption: 'Other',
        otherText: 'Vitest'
      }
    ]
    const result = buildTemplateFallback('App', 'Desc', decisions)
    assert.ok(result.includes('Other (Vitest)'))
  })

  test('always includes standard sections', () => {
    const result = buildTemplateFallback('App', 'Desc')
    assert.ok(result.includes('## Overview'))
    assert.ok(result.includes('## Tech Stack'))
    assert.ok(result.includes('## Conventions'))
    assert.ok(result.includes('## What NOT to do'))
    assert.ok(result.includes('## Key Commands'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
