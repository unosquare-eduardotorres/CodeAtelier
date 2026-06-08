/**
 * Unit tests for tool-input-summarizer.ts — data-driven strategy map that turns
 * raw tool input into a short human-readable display string.
 *
 * Pure logic — no Electron deps — runs from the main-process harness.
 *
 * Coverage:
 *  - field / fields / template / static strategy types.
 *  - Read offset/limit range formatting; Edit single vs multi-edit; Write line count.
 *  - Grep pattern + path; path relativization via workspacePath.
 *  - mcp__ generic fallback (3-part + 2-part); unknown tool → ''.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { summarizeToolInput } from '../tool-input-summarizer'

describe('summarizeToolInput — field/static strategies', () => {
  test('Bash returns the command (field strategy)', () => {
    assert.equal(summarizeToolInput('Bash', { command: 'npm test' }), 'npm test')
  })

  test('Bash with no command returns empty string', () => {
    assert.equal(summarizeToolInput('Bash', {}), '')
  })

  test('Glob returns the pattern', () => {
    assert.equal(summarizeToolInput('Glob', { pattern: '**/*.ts' }), '**/*.ts')
  })

  test('WebSearch returns the query', () => {
    assert.equal(summarizeToolInput('WebSearch', { query: 'electron fuses' }), 'electron fuses')
  })

  test('TodoWrite returns the static label', () => {
    assert.equal(summarizeToolInput('TodoWrite', {}), 'Task management')
  })
})

describe('summarizeToolInput — Read template', () => {
  test('plain path', () => {
    assert.equal(summarizeToolInput('Read', { file_path: '/a/b/c.ts' }), '/a/b/c.ts')
  })

  test('relativizes against workspacePath', () => {
    assert.equal(
      summarizeToolInput('Read', { file_path: '/home/u/proj/src/x.ts' }, '/home/u/proj'),
      'src/x.ts'
    )
  })

  test('offset + limit renders a line range', () => {
    assert.equal(
      summarizeToolInput('Read', { file_path: '/f.ts', offset: 10, limit: 5 }),
      '/f.ts (lines 10–14)'
    )
  })

  test('offset only renders a from-line hint', () => {
    assert.equal(
      summarizeToolInput('Read', { file_path: '/f.ts', offset: 20 }),
      '/f.ts (from line 20)'
    )
  })
})

describe('summarizeToolInput — Write/Edit templates', () => {
  test('Write reports line count', () => {
    assert.equal(
      summarizeToolInput('Write', { file_path: '/f.ts', content: 'a\nb\nc' }),
      '/f.ts (3 lines)'
    )
  })

  test('Write with no content returns just the path', () => {
    assert.equal(summarizeToolInput('Write', { file_path: '/f.ts' }), '/f.ts')
  })

  test('Edit with multiple edits reports edit count', () => {
    assert.equal(
      summarizeToolInput('Edit', { file_path: '/f.ts', edits: [{}, {}, {}] }),
      '/f.ts (3 edits)'
    )
  })

  test('Edit with a single edit shows an old_string preview', () => {
    const out = summarizeToolInput('Edit', {
      file_path: '/f.ts',
      edits: [{ old_string: 'const x = 1' }]
    })
    assert.equal(out, '/f.ts → "const x = 1"')
  })

  test('Edit truncates a long old_string preview with an ellipsis', () => {
    const out = summarizeToolInput('Edit', {
      file_path: '/f.ts',
      edits: [{ old_string: 'x'.repeat(50) }]
    })
    assert.ok(out.endsWith('…"'))
  })
})

describe('summarizeToolInput — Grep template', () => {
  test('pattern only', () => {
    assert.equal(summarizeToolInput('Grep', { pattern: 'foo' }), '/foo/')
  })

  test('pattern with path', () => {
    assert.equal(
      summarizeToolInput('Grep', { pattern: 'foo', path: '/proj/src' }, '/proj'),
      '/foo/ in src'
    )
  })
})

describe('summarizeToolInput — fallbacks', () => {
  test('unhandled mcp__ tool uses server/tool fallback', () => {
    assert.equal(summarizeToolInput('mcp__my-server__doThing', {}), 'my-server/doThing')
  })

  test('mcp__ tool with too few parts returns the raw name', () => {
    assert.equal(summarizeToolInput('mcp__only', {}), 'mcp__only')
  })

  test('unknown non-mcp tool returns empty string', () => {
    assert.equal(summarizeToolInput('TotallyUnknown', { foo: 'bar' }), '')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
