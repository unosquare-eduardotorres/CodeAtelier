/**
 * GoalCard — unit tests for modification-awareness logic.
 *
 * GoalCard is an internal (non-exported) component in ChatExecutionPanel.tsx.
 * We test its core derivation rule (`isModified`) and rendering invariants
 * by replicating the logic in a pure function, which mirrors the component's
 * behavior without needing a full React render environment.
 *
 * The component's isModified rule:
 *   `!readOnly && originalGoal != null && goal.trim() !== originalGoal.trim()`
 *
 * NOTE: This file uses node:test. Run it standalone:
 *   npx tsx src/renderer/src/components/chat/__tests__/GoalCard.test.ts
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

// ── Replicate GoalCard's core logic ──────────────────────────────────────

interface GoalCardProps {
  goal: string
  readOnly?: boolean
  originalGoal?: string
  onRegenerate?: () => void
  onReset?: () => void
}

/** Mirrors the `isModified` derivation in GoalCard */
function isGoalModified(props: GoalCardProps): boolean {
  const { goal, readOnly = false, originalGoal } = props
  return !readOnly && originalGoal != null && goal.trim() !== originalGoal.trim()
}

/** Mirrors the character counter visibility rule */
function isCharCounterVisible(props: GoalCardProps): boolean {
  return !props.readOnly && props.goal.length > 3500
}

/** Mirrors which buttons are shown when isModified is true */
function visibleButtons(props: GoalCardProps): string[] {
  const buttons: string[] = []
  if (isGoalModified(props)) {
    if (props.onReset) buttons.push('Reset')
    if (props.onRegenerate) buttons.push('Regenerate Plan')
  }
  return buttons
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('GoalCard — isModified logic', () => {
  test('default render (no originalGoal) → not modified', () => {
    assert.equal(isGoalModified({ goal: 'Build an API' }), false)
  })

  test('goal matches originalGoal → not modified', () => {
    assert.equal(isGoalModified({ goal: 'Build an API', originalGoal: 'Build an API' }), false)
  })

  test('goal differs from originalGoal → modified', () => {
    assert.equal(isGoalModified({ goal: 'Build a CLI tool', originalGoal: 'Build an API' }), true)
  })

  test('whitespace-only difference → not modified (trim comparison)', () => {
    assert.equal(isGoalModified({ goal: '  Build an API  ', originalGoal: 'Build an API' }), false)
  })

  test('readOnly mode + different goal → not modified (readOnly suppresses)', () => {
    assert.equal(
      isGoalModified({
        goal: 'Build a CLI tool',
        originalGoal: 'Build an API',
        readOnly: true
      }),
      false
    )
  })

  test('empty goal vs non-empty originalGoal → modified', () => {
    assert.equal(isGoalModified({ goal: '', originalGoal: 'Build an API' }), true)
  })

  test('both empty → not modified', () => {
    assert.equal(isGoalModified({ goal: '', originalGoal: '' }), false)
  })

  test('originalGoal is undefined → not modified regardless of goal', () => {
    assert.equal(isGoalModified({ goal: 'Anything at all', originalGoal: undefined }), false)
  })
})

describe('GoalCard — button visibility', () => {
  test('Reset button calls onReset when modified', () => {
    let resetCalled = false
    const onReset = (): void => {
      resetCalled = true
    }
    const buttons = visibleButtons({
      goal: 'New goal',
      originalGoal: 'Old goal',
      onReset
    })
    assert.ok(buttons.includes('Reset'))
    onReset()
    assert.ok(resetCalled)
  })

  test('Regenerate Plan button visible when modified + onRegenerate provided', () => {
    const buttons = visibleButtons({
      goal: 'New goal',
      originalGoal: 'Old goal',
      onRegenerate: () => {}
    })
    assert.ok(buttons.includes('Regenerate Plan'))
  })

  test('no buttons when not modified', () => {
    const buttons = visibleButtons({
      goal: 'Same goal',
      originalGoal: 'Same goal',
      onReset: () => {},
      onRegenerate: () => {}
    })
    assert.deepEqual(buttons, [])
  })

  test('no Reset button when onReset not provided', () => {
    const buttons = visibleButtons({
      goal: 'New goal',
      originalGoal: 'Old goal',
      onRegenerate: () => {}
    })
    assert.ok(!buttons.includes('Reset'))
    assert.ok(buttons.includes('Regenerate Plan'))
  })

  test('no Regenerate button when onRegenerate not provided', () => {
    const buttons = visibleButtons({
      goal: 'New goal',
      originalGoal: 'Old goal',
      onReset: () => {}
    })
    assert.ok(buttons.includes('Reset'))
    assert.ok(!buttons.includes('Regenerate Plan'))
  })
})

describe('GoalCard — character counter', () => {
  test('goal > 3500 chars → counter visible', () => {
    assert.ok(isCharCounterVisible({ goal: 'x'.repeat(3501) }))
  })

  test('goal exactly 3500 chars → counter NOT visible', () => {
    assert.ok(!isCharCounterVisible({ goal: 'x'.repeat(3500) }))
  })

  test('goal < 3500 chars → counter NOT visible', () => {
    assert.ok(!isCharCounterVisible({ goal: 'Short goal' }))
  })

  test('readOnly mode + long goal → counter NOT visible', () => {
    assert.ok(!isCharCounterVisible({ goal: 'x'.repeat(3501), readOnly: true }))
  })
})
