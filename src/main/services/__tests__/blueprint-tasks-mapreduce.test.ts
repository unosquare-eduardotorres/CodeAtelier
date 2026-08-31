/*
 * Unit tests for blueprint-tasks-mapreduce: the orchestration helpers
 * around the deterministic doc-classification primitives.
 *
 * Run: tsx src/main/services/__tests__/blueprint-tasks-mapreduce.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { buildMapPrompt, reduceToWavesJson } from '../blueprint-tasks-mapreduce'
import type { MergedTask } from '../blueprint-tasks-mapreduce'

describe('buildMapPrompt', () => {
  test('carries the doc content, index, and the do-not-cross-docs instruction', () => {
    const p = buildMapPrompt({
      docName: '10-scene-07.md',
      docContent: 'SCENE 07 CONTENT',
      referenceSummary: '- README.md',
      priorArtifactsSummary: 'artifacts on disk',
      docIndex: 2,
      totalDocs: 7
    })
    assert.match(p, /document 3 of 7: 10-scene-07\.md/)
    assert.match(p, /SCENE 07 CONTENT/)
    assert.match(p, /do NOT create tasks for them/)
    assert.match(p, /blueprint-tasks/)
  })
})

describe('reduceToWavesJson', () => {
  const t = (taskId: string, wave: number, files: string[]): MergedTask => ({
    taskId, wave, description: 'd-' + taskId, files
  })

  test('produces the waves-nested shape the persist path expects', () => {
    const r = reduceToWavesJson([
      { docName: 'a.md', tasks: [t('A1', 1, ['a.ts']), t('A2', 2, ['b.ts'])] },
      { docName: 'b.md', tasks: [t('B1', 1, ['c.ts'])] }
    ])
    assert.deepEqual(r.waves.map((w) => w.wave), [1, 2, 3])
    assert.equal(r.waves[0].tasks.length, 1)
    assert.equal(r.waves[2].tasks[0].taskId, 'T003')
    assert.deepEqual(r.warnings, [])
  })

  test('empty input yields empty waves', () => {
    const r = reduceToWavesJson([])
    assert.deepEqual(r.waves, [])
  })
})

if (import.meta.url === 'file://' + process.argv[1]) void summaryAsync()
