/**
 * Unit tests for the static gate analysis (G4 write-set, G3 stub scan,
 * G5 test integrity) and the diff parsing they all rest on.
 *
 * The recurring theme: these gates read the DIFF, not the file. A gate that
 * failed a task for a pre-existing `TODO` would burn two builder retries and a
 * strong-model fix before anyone noticed the gate was wrong.
 *
 * Run: tsx src/shared/__tests__/gate-analysis.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../main/services/__tests__/test-harness'
import {
  countTests,
  evaluateTestIntegrity,
  evaluateWriteSet,
  parseDiffAddedLines,
  parseDiffFiles,
  pathMatches,
  scanAddedLinesForStubs,
  type AddedLine
} from '../gate-analysis'

describe('pathMatches', () => {
  test('exact paths and directory prefixes match', () => {
    assert.equal(pathMatches('src/a.ts', 'src/a.ts'), true)
    assert.equal(pathMatches('src/api/x.ts', 'src/api'), true)
    assert.equal(pathMatches('src/api/x.ts', 'src/api/'), true)
  })

  test('a prefix only matches on a segment boundary — src/api does not cover src/apiary.ts', () => {
    assert.equal(pathMatches('src/apiary.ts', 'src/api'), false)
  })

  test('windows separators normalise', () => {
    assert.equal(pathMatches('src\\api\\x.ts', 'src/api'), true)
    assert.equal(pathMatches('./src/a.ts', 'src/a.ts'), true)
  })
})

describe('evaluateWriteSet', () => {
  const allowed = ['src/feature/', 'src/index.ts']

  test('everything inside the set passes', () => {
    const r = evaluateWriteSet({
      changedFiles: ['src/feature/a.ts', 'src/index.ts'],
      allowedFiles: allowed
    })
    assert.deepEqual(r.violations, [])
    assert.equal(r.changedCount, 2)
  })

  test('a change outside the set is a violation and names the file', () => {
    const r = evaluateWriteSet({
      changedFiles: ['src/feature/a.ts', 'src/other/b.ts'],
      allowedFiles: allowed
    })
    assert.deepEqual(r.violations, ['src/other/b.ts'])
  })

  test('a forbidden hit is reported as forbidden, not double-counted as a violation', () => {
    const r = evaluateWriteSet({
      changedFiles: ['db/migrations/001.sql'],
      allowedFiles: allowed,
      forbiddenFiles: ['db/migrations/']
    })
    assert.deepEqual(r.forbidden, ['db/migrations/001.sql'])
    assert.deepEqual(r.violations, [], 'one mistake must not look like two failures')
  })

  test('touching a packet test file is not a write-set violation — G5 owns that', () => {
    const r = evaluateWriteSet({
      changedFiles: ['src/feature/a.test.ts'],
      allowedFiles: allowed,
      testFiles: ['src/feature/a.test.ts']
    })
    assert.deepEqual(r.violations, [])
  })
})

describe('parseDiffAddedLines', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,2 +10,3 @@',
    ' const keep = 1',
    '-const gone = 2',
    '+const added = 2',
    '+const alsoAdded = 3',
    'diff --git a/src/b.ts b/src/b.ts',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1,1 @@',
    '+export const brandNew = true'
  ].join('\n')

  test('added lines carry the right file and post-image line numbers', () => {
    const lines = parseDiffAddedLines(diff)
    assert.deepEqual(lines, [
      { file: 'src/a.ts', line: 11, text: 'const added = 2' },
      { file: 'src/a.ts', line: 12, text: 'const alsoAdded = 3' },
      { file: 'src/b.ts', line: 1, text: 'export const brandNew = true' }
    ])
  })

  test('removals do not advance the post-image counter', () => {
    const lines = parseDiffAddedLines(diff).filter((l) => l.file === 'src/a.ts')
    assert.equal(lines[0].line, 11, 'the removed line must not shift the added one')
  })

  test('a deletion (+++ /dev/null) contributes no added lines', () => {
    const deletion = ['--- a/src/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-a', '-b'].join(
      '\n'
    )
    assert.deepEqual(parseDiffAddedLines(deletion), [])
  })

  test('parseDiffFiles lists the post-image paths', () => {
    assert.deepEqual(parseDiffFiles(diff).sort(), ['src/a.ts', 'src/b.ts'])
  })

  test('empty input yields nothing rather than throwing', () => {
    assert.deepEqual(parseDiffAddedLines(''), [])
    assert.deepEqual(parseDiffFiles(''), [])
  })
})

describe('scanAddedLinesForStubs', () => {
  const at = (text: string, file = 'src/a.ts', line = 1): AddedLine => ({ file, line, text })

  test('catches the markers a model leaves behind', () => {
    const findings = scanAddedLinesForStubs([
      at('  // TODO: wire this up'),
      at('  // FIXME broken', 'src/b.ts', 4),
      at('  throw new NotImplementedException();', 'src/c.cs', 9),
      at('    raise NotImplementedError', 'src/d.py', 3),
      at('  unimplemented!()', 'src/e.rs', 7)
    ])
    assert.equal(findings.length, 5)
    assert.equal(findings[0].kind, 'todo')
    assert.equal(findings[1].kind, 'fixme')
    assert.equal(findings[2].kind, 'not-implemented')
  })

  test('catches empty bodies and placeholder returns', () => {
    // R2.2: the bare `return null` no longer counts — only a placeholder return
    // WITH a TODO-style comment does. The bare `{}` body rule is gone too.
    // (`placeholder` wording — `TODO`/`FIXME` wording is caught by the earlier
    // marker rules, which is fine: it is still a finding.)
    const findings = scanAddedLinesForStubs([
      at('def handle(self):'),
      at('    pass', 'src/d.py', 2),
      at('  return null // placeholder — real value in the next task', 'src/f.ts', 3)
    ])
    const kinds = findings.map((f) => f.kind)
    assert.ok(kinds.includes('empty-body'))
    assert.ok(kinds.includes('placeholder-return'))
  })

  test('real implementation lines are not flagged', () => {
    const findings = scanAddedLinesForStubs([
      at('export function add(a: number, b: number) {'),
      at('  return a + b', 'src/a.ts', 2),
      at('}', 'src/a.ts', 3),
      at('const todoList = items.filter(Boolean)', 'src/a.ts', 4)
    ])
    assert.deepEqual(findings, [], `unexpected findings: ${JSON.stringify(findings)}`)
  })

  test('one finding per line — a line with two markers is one problem', () => {
    const findings = scanAddedLinesForStubs([at('// TODO FIXME both')])
    assert.equal(findings.length, 1)
  })

  test('the snippet is length-capped for evidence', () => {
    const findings = scanAddedLinesForStubs([at(`// TODO ${'x'.repeat(500)}`)])
    assert.ok(findings[0].snippet.length <= 160)
  })
})

describe('countTests', () => {
  test('counts across the common runners', () => {
    assert.equal(countTests("test('a', () => {})\nit('b', () => {})"), 2)
    assert.equal(countTests('def test_one():\n    pass\ndef test_two():\n    pass'), 2)
    assert.equal(countTests('[Fact]\npublic void A() {}\n[Theory]\npublic void B() {}'), 2)
    assert.equal(countTests('func TestFoo(t *testing.T) {}'), 1)
  })

  test('a file with no tests counts zero', () => {
    assert.equal(countTests('export const x = 1'), 0)
  })
})

describe('evaluateTestIntegrity', () => {
  const before = { 'a.test.ts': { hash: 'h1', testCount: 3 } }

  test('an untouched test file passes', () => {
    const r = evaluateTestIntegrity({
      before,
      after: { 'a.test.ts': { hash: 'h1', testCount: 3 } },
      addedTestLines: []
    })
    assert.equal(r.ok, true)
  })

  test('a modified test file fails — the builder must change the code, not the spec', () => {
    const r = evaluateTestIntegrity({
      before,
      after: { 'a.test.ts': { hash: 'h2', testCount: 3 } },
      addedTestLines: []
    })
    assert.equal(r.ok, false)
    assert.deepEqual(r.modified, ['a.test.ts'])
  })

  test('a deleted test file fails', () => {
    const r = evaluateTestIntegrity({ before, after: { 'a.test.ts': null }, addedTestLines: [] })
    assert.equal(r.ok, false)
    assert.deepEqual(r.deleted, ['a.test.ts'])
  })

  test('a test count drop fails even when the hash check would have passed on its own', () => {
    const r = evaluateTestIntegrity({
      before,
      after: { 'a.test.ts': { hash: 'h2', testCount: 1 } },
      addedTestLines: []
    })
    assert.deepEqual(r.countDrops, [{ file: 'a.test.ts', before: 3, after: 1 }])
  })

  test('added skip/only markers fail across runners', () => {
    const lines = [
      'it.skip("x", () => {})',
      'describe.only("y", () => {})',
      'xit("z", () => {})',
      '@pytest.mark.skip',
      't.Skip("later")'
    ].map((text, i) => ({ file: 'a.test.ts', line: i + 1, text }))

    const r = evaluateTestIntegrity({
      before,
      after: { 'a.test.ts': { hash: 'h1', testCount: 3 } },
      addedTestLines: lines
    })
    assert.equal(r.skipsAdded.length, 5)
    assert.equal(r.ok, false)
  })

  test('an ordinary added line in a test file is not a skip', () => {
    const r = evaluateTestIntegrity({
      before,
      after: { 'a.test.ts': { hash: 'h1', testCount: 3 } },
      addedTestLines: [{ file: 'a.test.ts', line: 1, text: '  const skipped = false' }]
    })
    assert.deepEqual(r.skipsAdded, [])
  })

  test('a test count INCREASE is fine — adding tests is not cheating', () => {
    const r = evaluateTestIntegrity({
      before,
      after: { 'a.test.ts': { hash: 'h1', testCount: 9 } },
      addedTestLines: []
    })
    assert.deepEqual(r.countDrops, [])
    assert.equal(r.ok, true)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
