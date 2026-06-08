/**
 * Unit tests for grillPlanToStructuredPlan — the pure GrillStructuredPlan →
 * StructuredPlan mapper used by the grill→chat handoff. No DB or CLI touched.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { grillPlanToStructuredPlan } from '../grill-plan-mapper'
import type { GrillStructuredPlan } from '../../../shared/types'

function makeGrillPlan(overrides: Partial<GrillStructuredPlan> = {}): GrillStructuredPlan {
  return {
    version: 1,
    title: 'Add retry logic',
    summary: 'Resilient uploads with backoff.',
    goalType: 'feature',
    decisions: [
      {
        trackId: 'architecture',
        trackName: 'Architecture',
        score: 80,
        items: [
          {
            question: 'Retry strategy?',
            answer: 'Exponential backoff',
            rationale: 'Avoids thundering herd'
          }
        ]
      }
    ],
    items: [
      {
        id: 'item-1',
        title: 'Upload handler',
        description: 'Add backoff to uploads',
        scope: 'backend',
        files: ['src/upload.ts', 'src/retry.ts'],
        dependsOn: [],
        includesTests: true
      }
    ],
    risks: ['May increase latency on persistent failures'],
    constraints: ['Use existing resilience library'],
    originalDescription: 'Uploads fail intermittently',
    requirementDocument: '# Requirement\n...',
    ...overrides
  }
}

describe('grillPlanToStructuredPlan', () => {
  test('maps goalType to plan type (bugfix → bug, tests → refactor)', () => {
    assert.equal(grillPlanToStructuredPlan(makeGrillPlan({ goalType: 'feature' })).type, 'feature')
    assert.equal(
      grillPlanToStructuredPlan(makeGrillPlan({ goalType: 'refactor' })).type,
      'refactor'
    )
    assert.equal(grillPlanToStructuredPlan(makeGrillPlan({ goalType: 'bugfix' })).type, 'bug')
    assert.equal(grillPlanToStructuredPlan(makeGrillPlan({ goalType: 'tests' })).type, 'refactor')
  })

  test('maps items to phases with derived complexity, fileCount and files', () => {
    const out = grillPlanToStructuredPlan(makeGrillPlan())
    assert.equal(out.phases?.length, 1)
    const phase = out.phases![0]
    assert.equal(phase.id, 1)
    assert.equal(phase.title, 'Upload handler')
    assert.equal(phase.fileCount, 2)
    assert.equal(phase.complexity, 2) // 2 files + 0 dependsOn
    assert.equal(phase.risk, 'low')
    assert.deepEqual(phase.files, [
      { file: 'src/upload.ts', change: '[backend] Upload handler' },
      { file: 'src/retry.ts', change: '[backend] Upload handler' }
    ])
  })

  test('derives high risk when dependsOn > 2', () => {
    const out = grillPlanToStructuredPlan(
      makeGrillPlan({
        items: [
          {
            id: 'i1',
            title: 'T',
            description: 'd',
            scope: 'backend',
            files: ['a.ts'],
            dependsOn: ['x', 'y', 'z'],
            includesTests: false
          }
        ]
      })
    )
    assert.equal(out.phases![0].risk, 'high')
  })

  test('flattens decisions across tracks into what/why pairs', () => {
    const out = grillPlanToStructuredPlan(makeGrillPlan())
    assert.deepEqual(out.decisions, [
      { what: 'Retry strategy? → Exponential backoff', why: 'Avoids thundering herd' }
    ])
  })

  test('maps risks to medium-severity entries', () => {
    const out = grillPlanToStructuredPlan(makeGrillPlan())
    assert.deepEqual(out.risks, [
      { risk: 'May increase latency on persistent failures', severity: 'medium' }
    ])
  })

  test('dedupes the flat files list across items', () => {
    const out = grillPlanToStructuredPlan(
      makeGrillPlan({
        items: [
          {
            id: 'a',
            title: 'A',
            description: '',
            scope: 'backend',
            files: ['x.ts', 'y.ts'],
            dependsOn: [],
            includesTests: false
          },
          {
            id: 'b',
            title: 'B',
            description: '',
            scope: 'shared',
            files: ['y.ts', 'z.ts'],
            dependsOn: [],
            includesTests: false
          }
        ]
      })
    )
    assert.deepEqual(out.files, ['x.ts', 'y.ts', 'z.ts'])
  })

  test('omits empty optional arrays', () => {
    const out = grillPlanToStructuredPlan(makeGrillPlan({ decisions: [], items: [], risks: [] }))
    assert.equal(out.decisions, undefined)
    assert.equal(out.phases, undefined)
    assert.equal(out.risks, undefined)
    assert.deepEqual(out.files, [])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
