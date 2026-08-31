/**
 * Unit tests for doc-classification (Agentic MapReduce for TASKS):
 * classifyDocs/partitionDocs (map-step input) and mergeDocTaskLists
 * (deterministic reduce). Live incident: blueprint 8acc ingested 11 docs
 * flat; the TASKS model narrated instead of emitting task JSON.
 *
 * Run: tsx src/shared/__tests__/doc-classification.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../main/services/__tests__/test-harness'
import {
  classifyDocByName,
  classifyDocs,
  partitionDocs,
  mergeDocTaskLists,
  type MergedTask
} from '../doc-classification'

describe('classifyDocByName', () => {
  test('scene files are plan units', () => {
    assert.equal(classifyDocByName('10-scene-07.md'), 'plan')
    assert.equal(classifyDocByName('scene_12.md'), 'plan')
    assert.equal(classifyDocByName('Scene 13 notes.md'), 'plan')
  })

  test('task/epic/story/FR files are plan units', () => {
    assert.equal(classifyDocByName('task-10.md'), 'plan')
    assert.equal(classifyDocByName('epic-login.md'), 'plan')
    assert.equal(classifyDocByName('FR-038-spec.md'), 'plan')
  })

  test('context files are reference', () => {
    assert.equal(classifyDocByName('README.md'), 'reference')
    assert.equal(classifyDocByName('BRIEF.md'), 'reference')
    assert.equal(classifyDocByName('storyboard.md'), 'reference')
    assert.equal(classifyDocByName('BUILD-ORDER.md'), 'reference')
  })

  test('reference wins ties - BUILD-ORDER matches task patterns too', () => {

    assert.equal(classifyDocByName('BUILD-ORDER.md'), 'reference')
  })

  test('unknown names default to reference (safe)', () => {
    assert.equal(classifyDocByName('notes.md'), 'reference')
    assert.equal(classifyDocByName('misc.txt'), 'reference')
  })
})

describe('classifyDocs + partitionDocs', () => {
  test('splits the 8acc shape: 4 reference + 7 plan docs', () => {
    const names = [
      'README.md',
      'BUILD-ORDER.md',
      'storyboard.md',
      'BRIEF.md',
      '10-scene-07.md',
      '11-scene-08.md',
      '12-scene-09.md',
      '13-scene-10.md',
      '14-scene-11.md',
      '15-scene-13.md',
      '16-scene-14.md'
    ]
    const { reference, plans } = partitionDocs(classifyDocs(names.map((name) => ({ name }))))
    assert.equal(reference.length, 4)
    assert.equal(plans.length, 7)
  })

  test('index preserves caller ordering', () => {
    const classified = classifyDocs([{ name: 'b-scene-1.md' }, { name: 'a.md' }])
    assert.equal(classified[0].index, 0)
    assert.equal(classified[1].index, 1)
  })
})

describe('mergeDocTaskLists (reduce step)', () => {
  const t = (taskId: string, wave: number, files: string[], dependsOn: string[] = []): MergedTask => ({
    taskId, wave, description: 'd-' + taskId, files, dependsOn
  })

  test('stacks doc waves sequentially - doc 2 continues after doc 1 max', () => {
    const r = mergeDocTaskLists([
      { docName: 'scene-07.md', tasks: [t('A1', 1, ['a.ts']), t('A2', 2, ['b.ts'])] },
      { docName: 'scene-08.md', tasks: [t('B1', 1, ['c.ts'])] }
    ])
    // doc1: waves 1,2; doc2 wave 1 becomes wave 3
    assert.deepEqual(
      r.tasks.map((x) => [x.taskId, x.wave]),
      [['T001', 1], ['T002', 2], ['T003', 3]]
    )
  })

  test('renumbers ids T001.. and rewrites dependsOn', () => {
    const r = mergeDocTaskLists([
      { docName: 'd1', tasks: [t('X9', 1, ['a.ts'])] },
      { docName: 'd2', tasks: [{ ...t('Y1', 1, ['b.ts']), dependsOn: ['X9'] }] }
    ])
    assert.equal(r.tasks[0].taskId, 'T001')
    assert.equal(r.tasks[1].taskId, 'T002')
    assert.deepEqual(r.tasks[1].dependsOn, ['T001'])
  })

  test('dedupes identical file sets across docs with a warning', () => {
    const r = mergeDocTaskLists([
      { docName: 'd1', tasks: [t('A1', 1, ['x.ts', 'y.ts'])] },
      { docName: 'd2', tasks: [t('B1', 1, ['y.ts', 'x.ts'])] }
    ])
    assert.equal(r.tasks.length, 1)
    assert.equal(r.warnings.length, 1)
    assert.match(r.warnings[0], /duplicate file set/)
  })

  test('empty docs contribute nothing; empty input yields empty graph', () => {
    const r = mergeDocTaskLists([{ docName: 'd1', tasks: [] }])
    assert.deepEqual(r.tasks, [])
    assert.deepEqual(r.warnings, [])
  })
})

if (import.meta.url === 'file://' + process.argv[1]) void summaryAsync()
