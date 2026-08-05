/**
 * Unit tests for rationale mining (Phase 3).
 *
 * Only the pure extractor is covered here — the writer path is a thin wrapper
 * around memoryEngineService.writeFact, which has its own tests.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { extractRationales, MAX_RATIONALES_PER_FILE } from '../rationale-miner.service'

describe('extractRationales — markers', () => {
  test('captures WHY / NOTE / HACK / GOTCHA comments', () => {
    const source = [
      '// WHY: the upstream API returns 200 on failure',
      'const ok = res.body.status === "ok"',
      '# HACK: sleep until the daemon opens its socket',
      'time.sleep(2)',
      '-- GOTCHA: this index is case-sensitive on Linux only',
      'CREATE INDEX idx_name ON t(name);',
      '/* NOTE: keep in sync with the renderer copy */'
    ].join('\n')

    const found = extractRationales(source, 'src/a.ts')
    assert.deepEqual(
      found.map((f) => f.marker),
      ['WHY', 'HACK', 'GOTCHA', 'NOTE']
    )
  })

  test('maps markers to memory categories', () => {
    const byMarker = new Map(
      extractRationales(
        [
          '// WHY: chosen for latency',
          '// HACK: works around a driver bug',
          '// GOTCHA: fails silently on Windows',
          '// NOTE: mirrors the schema in db/schema.sql'
        ].join('\n'),
        'src/a.ts'
      ).map((r) => [r.marker, r.category])
    )
    assert.equal(byMarker.get('WHY'), 'decision')
    assert.equal(byMarker.get('HACK'), 'gotcha')
    assert.equal(byMarker.get('GOTCHA'), 'gotcha')
    assert.equal(byMarker.get('NOTE'), 'reference')
  })

  test('ignores lowercase prose so ordinary comments are not mined', () => {
    const source = ['// note: this is just a normal remark', '// why do we do this? unclear'].join(
      '\n'
    )
    assert.deepEqual(extractRationales(source, 'src/a.ts'), [])
  })

  test('ignores marker-like text that is not a comment', () => {
    const source = 'const label = "WHY: not a comment, just a string"'
    assert.deepEqual(extractRationales(source, 'src/a.ts'), [])
  })

  test('skips markers with no substance', () => {
    assert.deepEqual(extractRationales('// HACK: fix', 'src/a.ts'), [])
  })
})

describe('extractRationales — ADR / RFC citations', () => {
  test('captures ADR and RFC references inside comments', () => {
    const found = extractRationales(
      ['// See ADR-14 for the queue-ordering decision', '# Follows RFC 7231 semantics'].join('\n'),
      'src/a.ts'
    )
    assert.equal(found.length, 2)
    assert.equal(found[0].marker, 'ADR')
    assert.equal(found[0].category, 'decision')
    assert.equal(found[1].marker, 'RFC')
  })

  test('ignores ADR-like text outside comments', () => {
    // A bare citation in code is a value (a URL, an id), not a decision record.
    assert.deepEqual(extractRationales('const doc = "ADR-14"', 'src/a.ts'), [])
  })
})

describe('extractRationales — content shape', () => {
  test('records the source location and the line the comment sits above', () => {
    const source = [
      '',
      '// WHY: retries must be idempotent here',
      'await retry(() => send(msg))'
    ].join('\n')
    const [found] = extractRationales(source, 'src/net/send.ts')
    assert.equal(found.line, 2)
    assert.equal(found.title, 'WHY: retries must be idempotent here')
    assert.ok(found.content.includes('src/net/send.ts:2'), 'content carries file:line')
    assert.ok(found.content.includes('await retry(() => send(msg))'), 'content carries the anchor')
  })

  test('truncates very long comments instead of dropping them', () => {
    const long = 'x'.repeat(400)
    const [found] = extractRationales(`// WHY: ${long}`, 'src/a.ts')
    assert.ok(found.title.length <= 100)
    assert.ok(found.title.endsWith('…'))
  })

  test('deduplicates identical rationales within a file', () => {
    const source = [
      '// WHY: guarded because the socket may already be closed',
      'a()',
      '// WHY: guarded because the socket may already be closed',
      'b()'
    ].join('\n')
    assert.equal(extractRationales(source, 'src/a.ts').length, 1)
  })

  test('caps the number mined per file', () => {
    const source = Array.from(
      { length: MAX_RATIONALES_PER_FILE + 5 },
      (_, i) => `// HACK: workaround number ${i} for the flaky upstream service`
    ).join('\n')
    assert.equal(extractRationales(source, 'src/a.ts').length, MAX_RATIONALES_PER_FILE)
  })
})

// Only print totals and exit when this file is run directly — under run-tests.ts
// the shared harness owns the summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
