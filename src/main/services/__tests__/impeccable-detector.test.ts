/**
 * Unit tests for src/main/services/impeccable-detector.service.ts
 *
 * Driven by fixtures captured from the REAL engine (v0.1.3) against this repo,
 * rather than from hand-invented JSON — the whole point of the P3.0 spike was
 * that the output shape had been guessed wrong twice.
 *
 * The three regression pins that matter:
 *   1. absolute → workspace-relative conversion (dedupe against LLM findings
 *      silently no-ops without it)
 *   2. three distinct `side-tab` hits in one file are NOT collapsed
 *   3. an unrecognised severity degrades to 'medium' instead of throwing
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, describe } from './test-harness'
import {
  DETECTOR_SOURCE,
  detectorFindingKey,
  parseDetectorPayload,
  relativizeDetectorPath
} from '../impeccable-detector.service'

const FIXTURES = join(__dirname, 'fixtures', 'impeccable-detect')

/** The anonymised workspace root the fixtures were rewritten to. */
const WS = '/Users/dev/projects/sample-app'

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.json`), 'utf-8')
}

// ── relativizeDetectorPath ───────────────────────────────────────────────────

describe('relativizeDetectorPath', () => {
  test('converts the engine absolute path to a workspace-relative one', () => {
    assert.equal(
      relativizeDetectorPath(`${WS}/src/renderer/src/assets/main.css`, WS),
      'src/renderer/src/assets/main.css'
    )
  })

  test('never leaks a home directory into the result', () => {
    const rel = relativizeDetectorPath(`${WS}/src/app.css`, WS)
    assert.ok(!rel.includes('/Users/'), `leaked absolute path: ${rel}`)
  })

  test('tolerates an already-relative path', () => {
    assert.equal(relativizeDetectorPath('src/app.css', WS), 'src/app.css')
  })

  test('returns "." when the file IS the workspace root', () => {
    assert.equal(relativizeDetectorPath(WS, WS), '.')
  })

  test('preserves a path outside the workspace as a climbing relative path', () => {
    assert.equal(relativizeDetectorPath('/Users/dev/projects/other/a.css', WS), '../other/a.css')
  })
})

// ── detectorFindingKey ───────────────────────────────────────────────────────

describe('detectorFindingKey', () => {
  test('same rule at different lines produces different keys', () => {
    assert.notEqual(
      detectorFindingKey('side-tab', 'src/main.css', 480),
      detectorFindingKey('side-tab', 'src/main.css', 502)
    )
  })
})

// ── parseDetectorPayload ─────────────────────────────────────────────────────

describe('parseDetectorPayload', () => {
  test('an empty scan yields no findings and is not malformed', () => {
    const r = parseDetectorPayload(fixture('empty'), WS)
    assert.equal(r.findings.length, 0)
    assert.equal(r.ruleCount, 0)
    assert.equal(r.malformed, false)
  })

  test('empty stdout is treated as an empty scan, not a parse failure', () => {
    const r = parseDetectorPayload('   \n', WS)
    assert.equal(r.malformed, false)
    assert.equal(r.findings.length, 0)
  })

  test('maps the real 6-finding capture', () => {
    const r = parseDetectorPayload(fixture('slop-warnings'), WS)
    assert.equal(r.findings.length, 6)
    // overused-font, side-tab, bounce-easing
    assert.equal(r.ruleCount, 3)
    assert.equal(r.malformed, false)
  })

  test('REGRESSION: three side-tab hits in one file stay three findings', () => {
    const r = parseDetectorPayload(fixture('slop-warnings'), WS)
    const sideTabs = r.findings.filter((f) => f.title === 'Side-tab accent border')
    assert.equal(sideTabs.length, 3, 'positional findings must not be collapsed')

    // Each must be individually addressable — distinct ids and distinct lines
    // surfaced in the description.
    assert.equal(new Set(sideTabs.map((f) => f.id)).size, 3)
    for (const line of ['480', '502', '604']) {
      assert.ok(
        sideTabs.some((f) => f.description.includes(`:${line}`)),
        `expected a side-tab finding at line ${line}`
      )
    }
  })

  test('every finding is badged with the detector source', () => {
    const r = parseDetectorPayload(fixture('slop-warnings'), WS)
    assert.ok(r.findings.every((f) => f.source === DETECTOR_SOURCE))
  })

  test('file paths are relativized, never absolute', () => {
    const r = parseDetectorPayload(fixture('slop-warnings'), WS)
    for (const f of r.findings) {
      assert.ok(f.filePath, 'finding must carry a filePath')
      assert.ok(!f.filePath!.startsWith('/'), `absolute path leaked: ${f.filePath}`)
    }
    assert.ok(r.findings.some((f) => f.filePath === 'src/renderer/src/assets/main.css'))
  })

  test('maps warning to medium severity', () => {
    const r = parseDetectorPayload(fixture('slop-warnings'), WS)
    assert.ok(r.findings.every((f) => f.severity === 'medium'))
  })

  test('folds importedBy into the description when present', () => {
    const r = parseDetectorPayload(fixture('with-importedby'), WS)
    assert.equal(r.findings.length, 1)
    assert.match(r.findings[0].description, /Reached via: main\.css, admin\.css, print\.css/)
  })

  test('advisory findings are included and mapped to info', () => {
    const r = parseDetectorPayload(fixture('advisory'), WS)
    const advisory = r.findings.find((f) => f.title === 'Em-dash overuse')
    assert.ok(advisory, 'advisory finding must be retained, not dropped')
    assert.equal(advisory.severity, 'info')
    assert.match(advisory.description, /advisory/i)
  })

  test('a file-level finding (line 0) is not rendered as ":0"', () => {
    const r = parseDetectorPayload(fixture('advisory'), WS)
    const advisory = r.findings.find((f) => f.title === 'Em-dash overuse')!
    assert.ok(!advisory.description.includes(':0'), 'line 0 means whole-file, not line zero')
  })

  test('a non-advisory finding in the same payload keeps its own severity', () => {
    const r = parseDetectorPayload(fixture('advisory'), WS)
    const gradient = r.findings.find((f) => f.title === 'Gradient text')!
    assert.equal(gradient.severity, 'medium')
  })

  // ── Defensive parsing ──

  test('an envelope object instead of an array is reported malformed', () => {
    const r = parseDetectorPayload(fixture('malformed'), WS)
    assert.equal(r.malformed, true)
    assert.equal(r.findings.length, 0)
  })

  test('unparseable text degrades to malformed rather than throwing', () => {
    const r = parseDetectorPayload('not json at all {{{', WS)
    assert.equal(r.malformed, true)
    assert.equal(r.findings.length, 0)
  })

  test('entries missing antipattern or file are skipped, valid ones kept', () => {
    const r = parseDetectorPayload(fixture('partial-entries'), WS)
    const titles = r.findings.map((f) => f.title)
    assert.ok(titles.includes('Side-tab accent border'))
    assert.ok(!titles.includes('Missing rule id'))
    assert.ok(!titles.includes('Missing file'))
    assert.ok(r.skipped >= 4, `expected skipped entries, got ${r.skipped}`)
    assert.equal(r.malformed, false)
  })

  test('an unrecognised severity falls back to medium instead of throwing', () => {
    const r = parseDetectorPayload(fixture('partial-entries'), WS)
    const unknown = r.findings.find((f) => f.title === 'Rule with an unrecognised severity')
    assert.ok(unknown, 'a finding with an unknown severity must still be reported')
    assert.equal(unknown.severity, 'medium')
  })

  test('maps error severity to high', () => {
    const r = parseDetectorPayload(fixture('partial-entries'), WS)
    const noLine = r.findings.find((f) => f.title === 'Rule with no line')
    assert.ok(noLine)
    assert.equal(noLine.severity, 'high')
  })

  test('an identical rule/file/line triple is de-duplicated', () => {
    const one = {
      antipattern: 'side-tab',
      name: 'Side-tab',
      severity: 'warning',
      file: `${WS}/a.css`,
      line: 3
    }
    const r = parseDetectorPayload(JSON.stringify([one, one]), WS)
    assert.equal(r.findings.length, 1)
    assert.equal(r.skipped, 1)
  })
})
