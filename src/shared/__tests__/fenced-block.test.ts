/**
 * Unit tests for findFencedBlock.
 *
 * Regression origin: a structured plan whose JSON carried a fenced C# sample
 * inside a string value ("```csharp\n…") was truncated by the old lazy regex.
 * The plan card fell back to rendering raw JSON and the 13K-character tail
 * leaked into the chat bubble underneath it.
 *
 * Run: tsx src/shared/__tests__/fenced-block.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../main/services/__tests__/test-harness'
import { findFencedBlock, extractFencedContent, hasFencedBlock } from '../fenced-block'

describe('findFencedBlock — nesting safety', () => {
  test('a fenced code sample inside a JSON string value does not end the block', () => {
    // Distilled from message 13f47f18: the fence lives inside a string value, so
    // it is preceded by escaped \n on the same physical line and never at col 0.
    const json = JSON.stringify({
      title: 'MUL-2255 Implementation Audit',
      type: 'audit',
      summary: 'Findings',
      findings: [{ evidence: 'Use:\n```csharp\nvar x = 1;\n```\nend of sample' }]
    })
    const text = `Here is the audit.\n\n\`\`\`plan\n${json}\n\`\`\`\n\nThe audit card is above.`

    const block = findFencedBlock(text, 'plan')
    assert.ok(block, 'block found')
    assert.equal(block!.content, json, 'the whole JSON body is captured')
    const parsed = JSON.parse(block!.content)
    assert.equal(parsed.title, 'MUL-2255 Implementation Audit')
  })

  test('before/after are exactly the surrounding prose — no JSON tail leaks', () => {
    const json = '{"title":"T","note":"```ts\\nx\\n```"}'
    const text = `Intro line.\n\n\`\`\`plan\n${json}\n\`\`\`\n\nTrailing prose.`

    const block = findFencedBlock(text, 'plan')!
    assert.equal(text.slice(0, block.start), 'Intro line.\n\n')
    assert.equal(text.slice(block.end), '\n\nTrailing prose.')
  })

  test('the legacy lazy rule really did truncate this input (guard is meaningful)', () => {
    const json = '{"title":"T","note":"```ts\\nx\\n```"}'
    const text = `\`\`\`plan\n${json}\n\`\`\``
    const legacy = /`{3,4}plan\n([\s\S]*?)`{3,4}/.exec(text)
    assert.notEqual(legacy![1].trim(), json, 'legacy regex stops at the nested fence')
    assert.equal(extractFencedContent(text, 'plan'), json)
  })
})

describe('findFencedBlock — fence forms', () => {
  test('4-backtick fences are supported and require a 4-backtick close', () => {
    const text = '````plan\nbody ``` still inside\n````\ntail'
    const block = findFencedBlock(text, 'plan')!
    assert.equal(block.content, 'body ``` still inside')
    assert.equal(text.slice(block.end), '\ntail')
  })

  test('trailing spaces after the closing fence are tolerated', () => {
    const block = findFencedBlock('```plan\nbody\n```   \nafter', 'plan')!
    assert.equal(block.content, 'body')
  })

  test('trailing spaces after the language tag are tolerated', () => {
    assert.equal(extractFencedContent('```plan  \nbody\n```', 'plan'), 'body')
  })

  test('CRLF line endings', () => {
    const block = findFencedBlock('pre\r\n```plan\r\n{"a":1}\r\n```\r\npost', 'plan')!
    assert.equal(block.content, '{"a":1}')
  })

  test('markdown bodies are returned verbatim', () => {
    assert.equal(
      extractFencedContent('```plan\n# Quad\n\nDo the thing.\n```', 'plan'),
      '# Quad\n\nDo the thing.'
    )
  })

  test('an empty body yields an empty string, not null', () => {
    assert.equal(extractFencedContent('```plan\n```', 'plan'), '')
  })
})

describe('findFencedBlock — absence and fallback', () => {
  test('no opening fence → null', () => {
    assert.equal(findFencedBlock('just prose', 'plan'), null)
    assert.equal(hasFencedBlock('just prose', 'plan'), false)
  })

  test('unterminated block (mid-stream) → null', () => {
    assert.equal(findFencedBlock('```plan\n{"title":"partial"', 'plan'), null)
  })

  test('an inline-terminated block still resolves via the legacy fallback', () => {
    // No own-line fence anywhere — hand-written blocks like this must not break.
    const block = findFencedBlock('```plan\nbody text``` trailing', 'plan')!
    assert.equal(block.content, 'body text')
    assert.equal('```plan\nbody text``` trailing'.slice(block.end), ' trailing')
  })

  test('the language tag must match exactly', () => {
    assert.equal(findFencedBlock('```planning\nbody\n```', 'plan'), null)
    assert.equal(hasFencedBlock('```build-summary\n{}\n```', 'build-summary'), true)
    assert.equal(hasFencedBlock('```build-summary\n{}\n```', 'plan'), false)
  })

  test('empty input → null', () => {
    assert.equal(findFencedBlock('', 'plan'), null)
  })
})

// When run directly (not via run-tests.ts), print summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
