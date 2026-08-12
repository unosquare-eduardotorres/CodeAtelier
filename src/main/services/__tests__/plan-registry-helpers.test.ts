/**
 * Unit tests for Plan Registry service pure logic — plan source classification,
 * structured plan validation, status transitions, file/phase/risk counting.
 *
 * Phase 14, Track 12b — plan-registry.service.ts (~250 lines at ~27%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicated pure logic from PlanRegistryService ──

type PlanSource = 'conversation' | 'mpa' | 'council' | 'grill' | 'blueprint'
type PlanStatus = 'draft' | 'active' | 'archived' | 'completed' | 'abandoned'

/**
 * Replicated plan source classification.
 */
function classifyPlanSource(origin: string): PlanSource {
  if (origin.includes('mpa') || origin.includes('orchestrat')) return 'mpa'
  if (origin.includes('council')) return 'council'
  if (origin.includes('grill')) return 'grill'
  if (origin.includes('blueprint')) return 'blueprint'
  return 'conversation'
}

/**
 * Replicated structured plan validation.
 */
function validateStructuredPlan(plan: Record<string, unknown>): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (!plan.title || typeof plan.title !== 'string') {
    errors.push('Missing or invalid title')
  }

  if (!Array.isArray(plan.items) || plan.items.length === 0) {
    errors.push('Missing or empty items array')
  } else {
    for (let i = 0; i < (plan.items as any[]).length; i++) {
      const item = (plan.items as any[])[i]
      if (!item.id) errors.push(`Item ${i} missing id`)
      if (!item.title) errors.push(`Item ${i} missing title`)
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Replicated status transition logic.
 */
function isValidStatusTransition(from: PlanStatus, to: PlanStatus): boolean {
  const transitions: Record<PlanStatus, PlanStatus[]> = {
    draft: ['active', 'archived', 'abandoned'],
    active: ['completed', 'archived', 'abandoned'],
    archived: ['active'], // Can reactivate
    completed: ['archived'],
    abandoned: ['active', 'archived'] // Can resurrect
  }
  return transitions[from]?.includes(to) ?? false
}

/**
 * Replicated file/phase/risk counting logic.
 */
function computePlanMetrics(plan: {
  items: Array<{
    files?: string[]
    phase?: string
    risk?: string
  }>
}): { fileCount: number; phaseCount: number; riskItems: number } {
  const allFiles = new Set<string>()
  const allPhases = new Set<string>()
  let riskItems = 0

  for (const item of plan.items) {
    if (item.files) {
      for (const f of item.files) allFiles.add(f)
    }
    if (item.phase) allPhases.add(item.phase)
    if (item.risk === 'high' || item.risk === 'critical') riskItems++
  }

  return {
    fileCount: allFiles.size,
    phaseCount: allPhases.size,
    riskItems
  }
}

// ── Tests ──

describe('Plan Registry — source classification', () => {
  test('mpa_origin_classified_as_mpa', () => {
    assert.equal(classifyPlanSource('mpa-pipeline'), 'mpa')
  })

  test('orchestration_origin_classified_as_mpa', () => {
    assert.equal(classifyPlanSource('orchestration-run-123'), 'mpa')
  })

  test('council_origin_classified_as_council', () => {
    assert.equal(classifyPlanSource('council-session-abc'), 'council')
  })

  test('grill_origin_classified_as_grill', () => {
    assert.equal(classifyPlanSource('grill-evaluation'), 'grill')
  })

  test('blueprint_origin_classified_as_blueprint', () => {
    assert.equal(classifyPlanSource('blueprint-spec'), 'blueprint')
  })

  test('unknown_origin_classified_as_conversation', () => {
    assert.equal(classifyPlanSource('user-chat'), 'conversation')
    assert.equal(classifyPlanSource(''), 'conversation')
  })
})

describe('Plan Registry — structured plan validation', () => {
  test('valid_plan_passes', () => {
    const result = validateStructuredPlan({
      title: 'My Plan',
      items: [
        { id: 'item-1', title: 'Task 1' },
        { id: 'item-2', title: 'Task 2' }
      ]
    })
    assert.ok(result.valid)
    assert.equal(result.errors.length, 0)
  })

  test('missing_title_fails', () => {
    const result = validateStructuredPlan({
      items: [{ id: '1', title: 'T' }]
    })
    assert.ok(!result.valid)
    assert.ok(result.errors.some((e) => e.includes('title')))
  })

  test('empty_items_fails', () => {
    const result = validateStructuredPlan({
      title: 'Plan',
      items: []
    })
    assert.ok(!result.valid)
    assert.ok(result.errors.some((e) => e.includes('items')))
  })

  test('missing_items_fails', () => {
    const result = validateStructuredPlan({ title: 'Plan' })
    assert.ok(!result.valid)
  })

  test('items_missing_id_reports_error', () => {
    const result = validateStructuredPlan({
      title: 'Plan',
      items: [{ title: 'Task without ID' }]
    })
    assert.ok(!result.valid)
    assert.ok(result.errors.some((e) => e.includes('id')))
  })
})

describe('Plan Registry — status transitions', () => {
  test('draft_to_active_is_valid', () => {
    assert.ok(isValidStatusTransition('draft', 'active'))
  })

  test('active_to_completed_is_valid', () => {
    assert.ok(isValidStatusTransition('active', 'completed'))
  })

  test('active_to_archived_is_valid', () => {
    assert.ok(isValidStatusTransition('active', 'archived'))
  })

  test('completed_to_draft_is_invalid', () => {
    assert.ok(!isValidStatusTransition('completed', 'draft'))
  })

  test('draft_to_completed_is_invalid', () => {
    assert.ok(!isValidStatusTransition('draft', 'completed'))
  })

  test('archived_can_reactivate', () => {
    assert.ok(isValidStatusTransition('archived', 'active'))
  })

  test('abandoned_can_resurrect', () => {
    assert.ok(isValidStatusTransition('abandoned', 'active'))
  })
})

describe('Plan Registry — metrics computation', () => {
  test('counts_unique_files', () => {
    const metrics = computePlanMetrics({
      items: [
        { files: ['a.ts', 'b.ts'] },
        { files: ['b.ts', 'c.ts'] } // b.ts is duplicate
      ]
    })
    assert.equal(metrics.fileCount, 3) // a, b, c
  })

  test('counts_unique_phases', () => {
    const metrics = computePlanMetrics({
      items: [
        { phase: 'planning' },
        { phase: 'implementation' },
        { phase: 'planning' } // duplicate
      ]
    })
    assert.equal(metrics.phaseCount, 2)
  })

  test('counts_high_risk_items', () => {
    const metrics = computePlanMetrics({
      items: [{ risk: 'high' }, { risk: 'low' }, { risk: 'critical' }, { risk: 'medium' }]
    })
    assert.equal(metrics.riskItems, 2)
  })

  test('empty_plan_returns_zeros', () => {
    const metrics = computePlanMetrics({ items: [] })
    assert.equal(metrics.fileCount, 0)
    assert.equal(metrics.phaseCount, 0)
    assert.equal(metrics.riskItems, 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
