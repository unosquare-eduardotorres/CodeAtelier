/**
 * getFailureStory tests (blueprint detail re-architecture R2).
 *
 * Imports the REAL phase-summaries module — it is pure (no React) — and pins
 * the derivation the failed-run verdict banner depends on: environmental
 * blockers outrank gaps, gaps derive from the verify artifact when lastError
 * is absent, and build-phase task failures are capped and paired with their
 * verification-failure artifacts.
 *
 * Run: tsx src/main/services/__tests__/phase-summaries-failure-story.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

import {
  getFailureStory,
  failedPhaseLabel
} from '../../../renderer/src/components/workspace/blueprints/detail/phase-summaries'
import type {
  BlueprintWithDetails,
  BlueprintPhase,
  BlueprintTask
} from '../../../shared/blueprint-types'

function phase(partial: Partial<BlueprintPhase>): BlueprintPhase {
  return {
    id: partial.id ?? 'p1',
    blueprintId: 'bp1',
    phase: partial.phase ?? 'build',
    status: partial.status ?? 'failed',
    startedAt: partial.startedAt ?? '2026-01-01T00:00:00Z',
    completedAt: partial.completedAt ?? null,
    artifactsJson: partial.artifactsJson ?? [],
    contextSnapshot: partial.contextSnapshot ?? null,
    ...partial
  } as BlueprintPhase
}

function bp(phases: BlueprintPhase[], tasks: BlueprintTask[]): BlueprintWithDetails {
  return {
    id: 'bp1',
    workspaceId: 'ws1',
    status: 'failed',
    title: 't',
    description: '',
    priority: 'P2',
    createdAt: '2026-01-01T00:00:00Z',
    currentPhase: 'build',
    phases,
    tasks,
    settingsJson: {},
    attachmentsJson: []
  } as unknown as BlueprintWithDetails
}

const verifyGapsArtifact = {
  type: 'verify',
  kind: 'verification',
  contentJson: {
    overallStatus: 'gaps_found',
    remediationTasks: [{ taskId: 'R1' }, { taskId: 'R2' }]
  }
}

describe('getFailureStory', () => {
  test('finds the failed phase and surfaces the ephemeral lastError', () => {
    const story = getFailureStory(bp([phase({ phase: 'build' })], []), {
      blueprintId: 'bp1',
      message: 'boom'
    })
    assert.equal(story.failedPhase?.phase, 'build')
    assert.equal(story.errorMsg, 'boom')
    assert.equal(story.context, null)
  })

  test('environmental blockers outrank gaps and disable retry', () => {
    const story = getFailureStory(
      bp(
        [
          phase({
            phase: 'verify',
            contextSnapshot: JSON.stringify({ environmentalFailure: 'pnpm not on PATH' })
          })
        ],
        []
      ),
      null
    )
    assert.equal(story.context?.isEnvironmental, true)
    assert.equal(story.context?.title, 'Environmental Failure — Retry Disabled')
  })

  test('gaps context derives from the verify artifact when lastError is absent', () => {
    const story = getFailureStory(
      bp([phase({ phase: 'verify', artifactsJson: [verifyGapsArtifact] as never })], []),
      null
    )
    assert.equal(story.context?.isGaps, true)
    assert.ok(story.context?.description.includes('2'))
  })

  test('build failures carry capped persisted task reasons + artifact pairing', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({
      taskId: `T${i + 1}`,
      status: 'failed',
      filePathsJson: []
    })) as unknown as BlueprintTask[]
    const story = getFailureStory(bp([phase({ phase: 'build' })], tasks), null)
    assert.equal(story.failedTaskList?.shown.length, 5)
    assert.equal(story.failedTaskList?.hiddenCount, 2)
    assert.equal(story.taskDisplays.length, 5)
    assert.ok(story.taskDisplays[0].display.title)
  })

  test('non-build failures have no task list', () => {
    const story = getFailureStory(bp([phase({ phase: 'plan' })], []), null)
    assert.equal(story.failedTaskList, null)
  })

  test('failedPhaseLabel falls back through current/failed phase', () => {
    assert.equal(failedPhaseLabel(bp([phase({ phase: 'build' })], [])), 'Build')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
