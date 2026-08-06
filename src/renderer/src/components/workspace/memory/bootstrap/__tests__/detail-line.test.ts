/**
 * detail-line — the progress panel's main line and the line underneath it.
 *
 * The rule with teeth is the second `!==` in `detailLine`: while a multi-chunk
 * item is in flight the main line carries a chunk suffix, so a `message` equal
 * to the bare `sourceRef` no longer string-matches the label and would render
 * the same filename twice, one line under the other.
 *
 * Run: tsx src/renderer/src/components/workspace/memory/bootstrap/__tests__/detail-line.test.ts
 */
import assert from 'node:assert/strict'
import {
  test,
  describe,
  summaryAsync
} from '../../../../../../../main/services/__tests__/test-harness'
import { itemLabel, detailLine } from '../detail-line'
import type { BootstrapProgress } from '../../../../../../../shared/types'

const progress = (partial: Partial<BootstrapProgress>): BootstrapProgress => ({
  jobId: 'job-1',
  runId: 'run-1',
  workspaceId: 'ws-1',
  phaseIndex: 2,
  phaseCount: 7,
  phaseLabel: 'docs',
  factsCreated: 12,
  message: '',
  jobStatus: 'running',
  mode: 'full',
  itemsTotal: 10,
  itemsDone: 3,
  itemsSkipped: 0,
  itemsFailed: 0,
  currentItem: null,
  perPhase: {},
  etaSeconds: null,
  itemsPerMinute: null,
  ...partial
})

const item = (
  sourceRef: string,
  chunkDone: number,
  chunkTotal: number
): BootstrapProgress['currentItem'] => ({
  sourceRef,
  phase: 'docs',
  chunkDone,
  chunkTotal,
  factsCreated: 0
})

describe('itemLabel', () => {
  test('appends a chunk counter for a multi-chunk item', () => {
    const p = progress({ currentItem: item('docs/guide.md', 2, 5) })
    assert.equal(itemLabel(p), 'docs/guide.md — chunk 2/5')
  })

  test('single-chunk items render the bare sourceRef, not "chunk 1/1"', () => {
    const p = progress({ currentItem: item('README.md', 1, 1) })
    assert.equal(itemLabel(p), 'README.md')
  })

  test('no item in flight yields null so the message owns the main line', () => {
    const p = progress({ currentItem: null, message: 'Planning…' })
    assert.equal(itemLabel(p), null)
  })
})

describe('detailLine', () => {
  test('is null when the message would echo the label verbatim', () => {
    const p = progress({
      currentItem: item('docs/guide.md', 2, 5),
      message: 'docs/guide.md — chunk 2/5'
    })
    assert.equal(p.message, itemLabel(p))
    assert.equal(detailLine(p), null)
  })

  test('is null when the message is the bare sourceRef under a chunk-suffixed label', () => {
    const p = progress({
      currentItem: item('docs/guide.md', 2, 5),
      message: 'docs/guide.md'
    })
    // The label is "docs/guide.md — chunk 2/5", so the first !== passes; only
    // the sourceRef comparison stops the duplicate render.
    assert.notEqual(p.message, itemLabel(p))
    assert.equal(detailLine(p), null)
  })

  test('surfaces the extractor status during a multi-chunk item', () => {
    const p = progress({
      currentItem: item('docs/guide.md', 2, 5),
      message: 'Rate limited — retrying in 4s…'
    })
    assert.equal(detailLine(p), 'Rate limited — retrying in 4s…')
  })

  test('is null with no item in flight, even when a message is present', () => {
    const p = progress({ currentItem: null, message: 'Finalizing…' })
    assert.equal(detailLine(p), null)
  })

  test('is null for an empty message', () => {
    const p = progress({ currentItem: item('README.md', 1, 1), message: '' })
    assert.equal(detailLine(p), null)
  })
})

// ── Standalone runner ─────────────────────────────────────────────
// summaryAsync calls process.exit — unguarded it kills the whole suite when
// this file is imported by a runner, taking every later test file with it.
if (process.argv[1]?.includes('detail-line')) {
  void summaryAsync()
}
