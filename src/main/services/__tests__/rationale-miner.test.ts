/**
 * Unit tests for rationale mining (Phase 3).
 *
 * The pure extractor is covered directly; the writer path is covered only at
 * its gate — mining is opt-in, and a gate that silently opens would flood the
 * Brain with every comment in the repo on the next index.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import {
  extractRationales,
  MAX_RATIONALES_PER_FILE,
  rationaleMinerService
} from '../rationale-miner.service'

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

// ── mineFiles gate ──────────────────────────────────────────────────────────

describe('mineFiles — opt-in gate', () => {
  test('writes nothing until memoryCaptureRationales is enabled', async () =>
    // Patches process-wide singletons — must not overlap with other async tests.
    runExclusive(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rationale-gate-'))
      writeFileSync(
        join(dir, 'a.ts'),
        '// WHY: the socket must be closed before retrying\nawait retry(send)\n'
      )

      const repos = await import('../../db/repositories')
      const memory = await import('../memory-engine.service')
      const workspaceRepo = repos.workspaceRepository as unknown as Record<string, unknown>
      const engine = memory.memoryEngineService as unknown as Record<string, unknown>
      const originalGetSettings = workspaceRepo.getSettings
      const originalWriteFact = engine.writeFact

      const writes: Record<string, unknown>[] = []
      engine.writeFact = async (input: Record<string, unknown>): Promise<{ id: string }> => {
        writes.push(input)
        return { id: `fact-${writes.length}` }
      }

      try {
        workspaceRepo.getSettings = (): Record<string, unknown> => ({})
        const off = await rationaleMinerService.mineFiles('ws-1', dir, ['a.ts'])
        assert.deepEqual(off, { scanned: 0, written: 0 }, 'disabled must not even read files')
        assert.equal(writes.length, 0, 'no facts may be written while the gate is closed')

        workspaceRepo.getSettings = (): Record<string, unknown> => ({
          memoryCaptureRationales: true
        })
        const on = await rationaleMinerService.mineFiles('ws-1', dir, ['a.ts'])
        assert.equal(on.scanned, 1)
        assert.equal(on.written, 1)
        assert.equal(writes.length, 1)
        assert.equal(writes[0].sourceType, 'tool')
        assert.deepEqual(writes[0].scopePaths, ['a.ts'])
        assert.equal(writes[0].workspaceId, 'ws-1')
      } finally {
        workspaceRepo.getSettings = originalGetSettings
        engine.writeFact = originalWriteFact
        rmSync(dir, { recursive: true, force: true })
      }
    }))
})

// Only print totals and exit when this file is run directly — under run-tests.ts
// the shared harness owns the summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
