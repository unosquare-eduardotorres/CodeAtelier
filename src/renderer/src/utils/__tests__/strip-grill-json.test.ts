/**
 * Tests for stripGrillEvaluationBlocks — specifically the F10 FIX wiring:
 * the grill transform must strip an orphaned block CLOSER from a continuation
 * segment (a mid-block segment split), via the shared stripOrphanedBlockCloser.
 *
 * Run: tsx src/renderer/src/utils/__tests__/strip-grill-json.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../../main/services/__tests__/test-harness'
import { stripGrillEvaluationBlocks } from '../strip-grill-json'

describe('stripGrillEvaluationBlocks — F10 orphaned closer', () => {
  test('continuation segment: JSON tail + bare closing fence stripped', () => {
    const continuation = `"score": 7, "feedback": "needs work"}
\`\`\`

Prose after the block.`

    const result = stripGrillEvaluationBlocks(continuation)
    assert.ok(!result.includes('"score": 7'), 'JSON tail must not render as prose')
    assert.ok(!result.includes('```'), 'orphaned closing fence must be stripped')
    assert.ok(result.includes('Prose after the block.'))
  })

  test('standard fenced block still stripped end-to-end', () => {
    const text = `Before.

\`\`\`grill-evaluation
{"trackId": "t1", "score": 9}
\`\`\`

After.`

    const result = stripGrillEvaluationBlocks(text)
    assert.ok(!result.includes('grill-evaluation'))
    assert.ok(!result.includes('"trackId"'))
    assert.ok(result.includes('Before.'))
    assert.ok(result.includes('After.'))
  })

  test('legit code block opener with info string survives', () => {
    const text = '```js\nconsole.log(1)\n```\n\nEnd.'
    const result = stripGrillEvaluationBlocks(text)
    assert.ok(result.includes('```js'))
    assert.ok(result.includes('console.log(1)'))
  })
})
