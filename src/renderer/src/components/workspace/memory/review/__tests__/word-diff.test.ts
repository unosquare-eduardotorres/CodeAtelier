/**
 * word-diff — the review queue's word-level LCS diff and its cosine parser.
 *
 * Duplicate pairs sit at ≥0.90 cosine, so the two titles differ by a word or
 * two. If the diff over-reports, every token lights up and the highlight is
 * worthless; if it under-reports, the reviewer approves a merge without ever
 * seeing what actually changed. Both failure modes are silent in the UI.
 *
 * Run: tsx src/renderer/src/components/workspace/memory/review/__tests__/word-diff.test.ts
 */
import assert from 'node:assert/strict'
import {
  test,
  describe,
  summaryAsync
} from '../../../../../../../main/services/__tests__/test-harness'
import { wordDiff, parseCosine, type DiffToken } from '../word-diff'

/** Reassembling the tokens must reproduce the input, whitespace included. */
const rebuild = (tokens: DiffToken[]): string => tokens.map((t) => t.text).join('')

const sides = (tokens: DiffToken[], side: DiffToken['side']): string[] =>
  tokens.filter((t) => t.side === side).map((t) => t.text)

describe('wordDiff', () => {
  test('identical strings produce no differing tokens', () => {
    const { left, right } = wordDiff('schema version is 85', 'schema version is 85')
    assert.deepEqual(sides(left, 'a'), [])
    assert.deepEqual(sides(right, 'b'), [])
    assert.equal(rebuild(left), 'schema version is 85')
    assert.equal(rebuild(right), 'schema version is 85')
  })

  test('a single changed word is the only thing highlighted', () => {
    const { left, right } = wordDiff('schema version is 85', 'schema version is 94')
    assert.deepEqual(sides(left, 'a'), ['85'])
    assert.deepEqual(sides(right, 'b'), ['94'])
  })

  test('a shared prefix stays shared', () => {
    const { left, right } = wordDiff('use the repository', 'use the repository pattern')
    assert.deepEqual(sides(left, 'a'), [])
    // The trailing space is a token too — only the new word is `b`-side text.
    assert.ok(sides(right, 'b').includes('pattern'))
    assert.deepEqual(
      left.filter((t) => t.side === 'same').map((t) => t.text),
      ['use', ' ', 'the', ' ', 'repository']
    )
  })

  test('disjoint strings share no words — only the separating whitespace', () => {
    const { left, right } = wordDiff('alpha beta', 'gamma delta')
    assert.deepEqual(sides(left, 'a'), ['alpha', 'beta'])
    assert.deepEqual(sides(right, 'b'), ['gamma', 'delta'])
    // Whitespace is tokenized too, so the shared separator legitimately
    // matches; nothing with visible text does.
    const sharedText = left.filter((t) => t.side === 'same').map((t) => t.text)
    assert.equal(
      sharedText.every((t) => t.trim() === ''),
      true
    )
  })

  test('both sides always rebuild to their input', () => {
    const a = 'Prisma  migrations run on boot'
    const b = 'Prisma migrations run at startup'
    const { left, right } = wordDiff(a, b)
    assert.equal(rebuild(left), a)
    assert.equal(rebuild(right), b)
  })

  test('empty inputs are handled on either side', () => {
    assert.deepEqual(wordDiff('', ''), { left: [], right: [] })

    const { left, right } = wordDiff('', 'only right')
    assert.deepEqual(left, [])
    assert.equal(rebuild(right), 'only right')
    assert.equal(
      right.every((t) => t.side === 'b'),
      true
    )

    const flipped = wordDiff('only left', '')
    assert.deepEqual(flipped.right, [])
    assert.equal(rebuild(flipped.left), 'only left')
  })

  test('a repeated word does not collapse into a single match', () => {
    const { left, right } = wordDiff('run run run', 'run run')
    assert.equal(rebuild(left), 'run run run')
    assert.equal(rebuild(right), 'run run')
    // Exactly one token's worth of surplus on the left.
    assert.deepEqual(sides(right, 'b'), [])
    assert.ok(sides(left, 'a').length > 0)
  })
})

describe('parseCosine', () => {
  test('reads the marker the dedup scanner writes', () => {
    assert.equal(parseCosine('Auto-merged duplicate (cosine: 0.920)'), 0.92)
  })

  test('tolerates extra whitespace after the colon', () => {
    assert.equal(parseCosine('cosine:   0.5'), 0.5)
  })

  test('returns null when there is no marker', () => {
    assert.equal(parseCosine('Resolved by hand'), null)
  })

  test('returns null for a null resolution', () => {
    assert.equal(parseCosine(null), null)
  })

  test('returns null for an empty resolution', () => {
    assert.equal(parseCosine(''), null)
  })

  test('returns null when the captured value is not a number', () => {
    // The character class admits a bare '.', which parseFloat rejects.
    assert.equal(parseCosine('cosine: .'), null)
  })

  test('takes the first marker when several are present', () => {
    assert.equal(parseCosine('cosine: 0.91 then cosine: 0.99'), 0.91)
  })
})

// ── Standalone runner ─────────────────────────────────────────────
// summaryAsync calls process.exit — unguarded it kills the whole suite when
// this file is imported by a runner, taking every later test file with it.
if (process.argv[1]?.includes('word-diff')) {
  void summaryAsync()
}
