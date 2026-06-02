/**
 * Tests for GrillSessionRepository.findIdeaIdsWithPlan — workspace-scoped
 * lookup of ideas that have a persisted structured plan.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'
import { seedWorkspace } from '../../test-helpers'
import type { GrillStructuredPlan } from '../../../../shared/types'

const env = trySetupTestDb()

function makePlan(title: string): GrillStructuredPlan {
  return {
    version: 1,
    title,
    summary: 'A minimal plan.',
    goalType: 'feature',
    decisions: [],
    items: [],
    risks: [],
    constraints: [],
    originalDescription: '',
    requirementDocument: ''
  }
}

if (!env) {
  describe('GrillSessionRepository (skipped — native module unavailable)', () => {
    test('findIdeaIdsWithPlan() returns ideas with a plan', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { grillSessionRepository } = require('../grill-session.repository')

  const seedIdea = (workspaceId: string, title: string): string => {
    const row = db
      .prepare(`INSERT INTO ideas (workspace_id, title) VALUES (?, ?) RETURNING id`)
      .get(workspaceId, title) as { id: string }
    return row.id
  }

  describe('GrillSessionRepository.findIdeaIdsWithPlan', () => {
    test('returns only ideas that have a persisted plan', () => {
      const ideaA = seedIdea(wsId, 'Idea A')
      const ideaB = seedIdea(wsId, 'Idea B')

      const sessionA = grillSessionRepository.create(ideaA, wsId)
      grillSessionRepository.savePlan(sessionA.id, makePlan('Idea A'))
      grillSessionRepository.create(ideaB, wsId) // no plan

      const ids = grillSessionRepository.findIdeaIdsWithPlan(wsId)
      assert.deepEqual(ids, [ideaA])
    })

    test('is workspace-scoped — excludes plans from other workspaces', () => {
      const otherWs = seedWorkspace(db, 'other-workspace')
      const ideaOther = seedIdea(otherWs, 'Other WS Idea')
      const sessionOther = grillSessionRepository.create(ideaOther, otherWs)
      grillSessionRepository.savePlan(sessionOther.id, makePlan('Other WS Idea'))

      const ids = grillSessionRepository.findIdeaIdsWithPlan(otherWs)
      assert.deepEqual(ids, [ideaOther])

      // The original workspace's result must not include the other-workspace idea.
      const wsIds = grillSessionRepository.findIdeaIdsWithPlan(wsId)
      assert.ok(!wsIds.includes(ideaOther))
    })

    test('returns [] for an unknown workspace', () => {
      const ids = grillSessionRepository.findIdeaIdsWithPlan('nonexistent-workspace')
      assert.deepEqual(ids, [])
    })
  })
}
