/**
 * Lean Mode Blocks — verifies compressed per-message mode context blocks
 * for Opus 4.8+ preserve key behavioral rules while being significantly shorter.
 *
 * Pure logic: no filesystem, no network, no real Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import {
  PLAN_MODE_SECTION,
  PLAN_MODE_SECTION_LEAN,
  BUILD_MODE_SECTION,
  BUILD_MODE_SECTION_LEAN,
  DANGER_MODE_SECTION,
  DANGER_MODE_SECTION_LEAN
} from '../default-prompts'

describe('Lean Mode Blocks', () => {
  test('lean plan is shorter than full plan', () => {
    assert.ok(PLAN_MODE_SECTION_LEAN.length < PLAN_MODE_SECTION.length)
    assert.ok(
      PLAN_MODE_SECTION_LEAN.length < PLAN_MODE_SECTION.length * 0.7,
      `Lean plan (${PLAN_MODE_SECTION_LEAN.length}) should be <70% of full (${PLAN_MODE_SECTION.length})`
    )
  })

  test('lean build is shorter than full build', () => {
    assert.ok(BUILD_MODE_SECTION_LEAN.length < BUILD_MODE_SECTION.length)
    assert.ok(
      BUILD_MODE_SECTION_LEAN.length < BUILD_MODE_SECTION.length * 0.7,
      `Lean build (${BUILD_MODE_SECTION_LEAN.length}) should be <70% of full (${BUILD_MODE_SECTION.length})`
    )
  })

  test('lean danger is shorter than full danger', () => {
    assert.ok(DANGER_MODE_SECTION_LEAN.length < DANGER_MODE_SECTION.length)
    assert.ok(
      DANGER_MODE_SECTION_LEAN.length < DANGER_MODE_SECTION.length * 0.7,
      `Lean danger (${DANGER_MODE_SECTION_LEAN.length}) should be <70% of full (${DANGER_MODE_SECTION.length})`
    )
  })

  test('lean plan preserves key structural sections', () => {
    assert.ok(PLAN_MODE_SECTION_LEAN.includes('emit_plan'), 'Missing emit_plan reference')
    assert.ok(PLAN_MODE_SECTION_LEAN.includes('type'), 'Missing type field reference')
    assert.ok(PLAN_MODE_SECTION_LEAN.includes('diagrams'), 'Missing diagrams reference')
    assert.ok(
      PLAN_MODE_SECTION_LEAN.includes('Operational Requests'),
      'Missing Operational Requests'
    )
    assert.ok(PLAN_MODE_SECTION_LEAN.includes('read-only'), 'Missing read-only indicator')
    assert.ok(PLAN_MODE_SECTION_LEAN.includes('Phased Plans'), 'Missing Phased Plans section')
  })

  test('lean build preserves safety rules', () => {
    assert.ok(BUILD_MODE_SECTION_LEAN.includes('STOP'), 'Missing STOP rules')
    assert.ok(BUILD_MODE_SECTION_LEAN.includes('Destructive'), 'Missing Destructive command rule')
    assert.ok(BUILD_MODE_SECTION_LEAN.includes('approval'), 'Missing approval requirement')
    assert.ok(BUILD_MODE_SECTION_LEAN.includes('Tool Errors'), 'Missing Tool Errors section')
    assert.ok(BUILD_MODE_SECTION_LEAN.includes('typecheck'), 'Missing typecheck requirement')
    assert.ok(BUILD_MODE_SECTION_LEAN.includes('ask_user'), 'Missing ask_user for ambiguity')
  })

  test('lean danger preserves safety boundaries', () => {
    assert.ok(DANGER_MODE_SECTION_LEAN.includes('isolated'), 'Missing isolation caveat')
    assert.ok(DANGER_MODE_SECTION_LEAN.includes('STOP'), 'Missing STOP rules reference')
    assert.ok(DANGER_MODE_SECTION_LEAN.includes('typecheck'), 'Missing typecheck requirement')
  })

  test('lean build preserves error recovery guidance', () => {
    assert.ok(
      BUILD_MODE_SECTION_LEAN.includes('re-read'),
      'Missing re-read guidance for stale file errors'
    )
    assert.ok(
      BUILD_MODE_SECTION_LEAN.includes('EACCES'),
      'Missing EACCES permission check reference'
    )
  })

  test('lean plan preserves all plan types', () => {
    assert.ok(PLAN_MODE_SECTION_LEAN.includes('bug'), 'Missing bug plan type')
    assert.ok(PLAN_MODE_SECTION_LEAN.includes('feature'), 'Missing feature plan type')
    assert.ok(PLAN_MODE_SECTION_LEAN.includes('refactor'), 'Missing refactor plan type')
    assert.ok(PLAN_MODE_SECTION_LEAN.includes('audit'), 'Missing audit plan type')
    assert.ok(PLAN_MODE_SECTION_LEAN.includes('investigation'), 'Missing investigation plan type')
  })
})
