/**
 * Tests for E2E behavioral assertions — validates each assertion against synthetic transcripts.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  streamCompleted,
  noErrorChunks,
  responseMatches,
  responseMinLength,
  toolCalled,
  toolNotCalled,
  toolCalledTimes,
  anyToolCalled,
  thinkingPresent,
  responseHasMermaidBlock,
  responseHasMarkdownTable,
  validJson,
  statusEntryMatches,
  turnCountAtMost,
  fileExistsInFixture,
  runAssertions
} from '../e2e-testing/e2e-assertions'
import type { E2ETranscriptEntry } from '../../../shared/types'
import { z } from 'zod'

// ── Synthetic Transcript Helpers ──

function textEntry(content: string): E2ETranscriptEntry {
  return { role: 'assistant', type: 'text', content, timestamp: Date.now() }
}

function userEntry(content: string): E2ETranscriptEntry {
  return { role: 'user', type: 'text', content, timestamp: Date.now() }
}

function toolUseEntry(toolName: string, toolArgs?: Record<string, unknown>): E2ETranscriptEntry {
  return { role: 'assistant', type: 'tool_use', toolName, toolArgs, timestamp: Date.now() }
}

function thinkingEntry(content: string): E2ETranscriptEntry {
  return { role: 'assistant', type: 'thinking', content, timestamp: Date.now() }
}

function errorEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'error', content, timestamp: Date.now() }
}

function statusEntry(content: string): E2ETranscriptEntry {
  return { role: 'system', type: 'status', content, timestamp: Date.now() }
}

describe('E2E Assertions', () => {
  // ── streamCompleted ──

  test('streamCompleted passes when assistant text exists', () => {
    const result = streamCompleted().run([textEntry('Hello')])
    assert.equal(result.passed, true)
  })

  test('streamCompleted passes when status=complete exists', () => {
    const result = streamCompleted().run([statusEntry('complete')])
    assert.equal(result.passed, true)
  })

  test('streamCompleted fails on empty transcript', () => {
    const result = streamCompleted().run([])
    assert.equal(result.passed, false)
  })

  // ── noErrorChunks ──

  test('noErrorChunks passes with no errors', () => {
    const result = noErrorChunks().run([textEntry('Hello')])
    assert.equal(result.passed, true)
  })

  test('noErrorChunks fails with error chunks', () => {
    const result = noErrorChunks().run([textEntry('Hello'), errorEntry('Something broke')])
    assert.equal(result.passed, false)
    assert.ok(result.reason?.includes('Something broke'))
  })

  // ── responseMatches ──

  test('responseMatches passes when regex matches', () => {
    const result = responseMatches(/hello/i).run([textEntry('Hello World')])
    assert.equal(result.passed, true)
  })

  test('responseMatches fails when regex does not match', () => {
    const result = responseMatches(/goodbye/i).run([textEntry('Hello World')])
    assert.equal(result.passed, false)
  })

  test('responseMatches concatenates all text entries', () => {
    const result = responseMatches(/HelloWorld/).run([
      textEntry('Hello'),
      textEntry('World')
    ])
    assert.equal(result.passed, true)
  })

  // ── responseMinLength ──

  test('responseMinLength passes when long enough', () => {
    const result = responseMinLength(5).run([textEntry('Hello World')])
    assert.equal(result.passed, true)
  })

  test('responseMinLength fails when too short', () => {
    const result = responseMinLength(100).run([textEntry('Hi')])
    assert.equal(result.passed, false)
    assert.ok(result.reason?.includes('2'))
  })

  // ── toolCalled ──

  test('toolCalled passes when tool is found', () => {
    const result = toolCalled('Read').run([
      textEntry('Let me read that'),
      toolUseEntry('Read', { file_path: 'hello.ts' })
    ])
    assert.equal(result.passed, true)
  })

  test('toolCalled matches case-insensitively', () => {
    const result = toolCalled('read').run([toolUseEntry('mcp__file-tools__Read')])
    assert.equal(result.passed, true)
  })

  test('toolCalled fails when tool is not found', () => {
    const result = toolCalled('Write').run([toolUseEntry('Read')])
    assert.equal(result.passed, false)
    assert.ok(result.reason?.includes('Read'))
  })

  test('toolCalled with args matcher', () => {
    const result = toolCalled('Read', (args) => args.file_path === 'hello.ts').run([
      toolUseEntry('Read', { file_path: 'hello.ts' })
    ])
    assert.equal(result.passed, true)
  })

  // ── toolNotCalled ──

  test('toolNotCalled passes when tool is absent', () => {
    const result = toolNotCalled('Write').run([toolUseEntry('Read')])
    assert.equal(result.passed, true)
  })

  test('toolNotCalled fails when tool is present', () => {
    const result = toolNotCalled('Read').run([toolUseEntry('Read')])
    assert.equal(result.passed, false)
  })

  test('toolNotCalled with empty name acts as responseExists', () => {
    const result = toolNotCalled('').run([textEntry('Some response')])
    assert.equal(result.passed, true)
  })

  // ── validJson ──

  test('validJson passes with valid JSON matching schema', () => {
    const schema = z.object({ name: z.string(), age: z.number() })
    const result = validJson(schema).run([textEntry('{"name": "Alice", "age": 30}')])
    assert.equal(result.passed, true)
  })

  test('validJson fails with invalid JSON', () => {
    const schema = z.object({ name: z.string() })
    const result = validJson(schema).run([textEntry('not json at all')])
    assert.equal(result.passed, false)
    assert.ok(result.reason?.includes('Failed to parse'))
  })

  test('validJson fails with wrong schema', () => {
    const schema = z.object({ name: z.string(), age: z.number() })
    const result = validJson(schema).run([textEntry('{"name": "Alice"}')])
    assert.equal(result.passed, false)
    assert.ok(result.reason?.includes('schema validation'))
  })

  test('validJson handles markdown code fences', () => {
    const schema = z.object({ x: z.number() })
    const result = validJson(schema).run([textEntry('```json\n{"x": 42}\n```')])
    assert.equal(result.passed, true)
  })

  // ── turnCountAtMost ──

  test('turnCountAtMost passes within limit', () => {
    const result = turnCountAtMost(2).run([userEntry('Hi'), userEntry('Bye')])
    assert.equal(result.passed, true)
  })

  test('turnCountAtMost fails over limit', () => {
    const result = turnCountAtMost(1).run([userEntry('Hi'), userEntry('Bye')])
    assert.equal(result.passed, false)
  })

  // ── fileExistsInFixture ──

  test('fileExistsInFixture passes when Write tool targets path', () => {
    const result = fileExistsInFixture('greeting.ts').run([
      toolUseEntry('Write', { file_path: 'src/greeting.ts', content: 'hello' })
    ])
    assert.equal(result.passed, true)
  })

  test('fileExistsInFixture fails when no Write call found', () => {
    const result = fileExistsInFixture('greeting.ts').run([toolUseEntry('Read')])
    assert.equal(result.passed, false)
  })

  test('fileExistsInFixture checks content regex', () => {
    const result = fileExistsInFixture('greeting.ts', /hello/).run([
      toolUseEntry('Write', { file_path: 'src/greeting.ts', content: 'goodbye' })
    ])
    assert.equal(result.passed, false)
  })

  // ── thinkingPresent ──

  test('thinkingPresent passes when thinking entry exists', () => {
    const result = thinkingPresent().run([thinkingEntry('Let me think...'), textEntry('The answer')])
    assert.equal(result.passed, true)
  })

  test('thinkingPresent fails when no thinking entries', () => {
    const result = thinkingPresent().run([textEntry('Just text')])
    assert.equal(result.passed, false)
    assert.ok(result.reason?.includes('No thinking'))
  })

  // ── toolCalledTimes ──

  test('toolCalledTimes passes when count meets minimum', () => {
    const result = toolCalledTimes('emit_plan', 2).run([
      toolUseEntry('mcp__control-actions__emit_plan'),
      textEntry('Updated'),
      toolUseEntry('mcp__control-actions__emit_plan')
    ])
    assert.equal(result.passed, true)
  })

  test('toolCalledTimes fails when count below minimum', () => {
    const result = toolCalledTimes('emit_plan', 2).run([
      toolUseEntry('mcp__control-actions__emit_plan')
    ])
    assert.equal(result.passed, false)
    assert.ok(result.reason?.includes('1 time(s)'))
  })

  test('toolCalledTimes handles zero calls', () => {
    const result = toolCalledTimes('Write', 1).run([textEntry('No tools')])
    assert.equal(result.passed, false)
  })

  // ── anyToolCalled ──

  test('anyToolCalled passes when one of the tools is found', () => {
    const result = anyToolCalled(['FindSymbol', 'FileOutline', 'FindDefinition']).run([
      toolUseEntry('mcp__code_graph__FileOutline')
    ])
    assert.equal(result.passed, true)
  })

  test('anyToolCalled fails when none of the tools are found', () => {
    const result = anyToolCalled(['FindSymbol', 'FileOutline']).run([
      toolUseEntry('Read'),
      toolUseEntry('Write')
    ])
    assert.equal(result.passed, false)
    assert.ok(result.reason?.includes('None of'))
  })

  test('anyToolCalled works with empty transcript', () => {
    const result = anyToolCalled(['Read']).run([])
    assert.equal(result.passed, false)
  })

  // ── responseHasMermaidBlock ──

  test('responseHasMermaidBlock passes with valid mermaid block', () => {
    const result = responseHasMermaidBlock().run([
      textEntry('Here is a diagram:\n```mermaid\ngraph TD\n  A --> B\n```\n')
    ])
    assert.equal(result.passed, true)
  })

  test('responseHasMermaidBlock fails without mermaid block', () => {
    const result = responseHasMermaidBlock().run([
      textEntry('Here is some code:\n```javascript\nconsole.log("hi")\n```\n')
    ])
    assert.equal(result.passed, false)
  })

  test('responseHasMermaidBlock fails with empty mermaid block', () => {
    const result = responseHasMermaidBlock().run([
      textEntry('```mermaid\n```')
    ])
    assert.equal(result.passed, false)
  })

  // ── responseHasMarkdownTable ──

  test('responseHasMarkdownTable passes with valid table', () => {
    const result = responseHasMarkdownTable().run([
      textEntry('| Feature | REST | GraphQL |\n|---|---|---|\n| Type | Verb-based | Query-based |\n')
    ])
    assert.equal(result.passed, true)
  })

  test('responseHasMarkdownTable fails without table', () => {
    const result = responseHasMarkdownTable().run([
      textEntry('Just some text without any table formatting.')
    ])
    assert.equal(result.passed, false)
  })

  test('responseHasMarkdownTable fails with separator but only one pipe row', () => {
    const result = responseHasMarkdownTable().run([
      textEntry('|---|\nSome text')
    ])
    assert.equal(result.passed, false)
  })

  // ── statusEntryMatches ──

  test('statusEntryMatches passes when pattern matches a status entry', () => {
    const result = statusEntryMatches(/compaction: ok/).run([
      textEntry('Some text'),
      statusEntry('compaction: ok')
    ])
    assert.equal(result.passed, true)
  })

  test('statusEntryMatches passes with partial regex match', () => {
    const result = statusEntryMatches(/compact_boundary/).run([
      statusEntry('compact_boundary: auto'),
      textEntry('Response')
    ])
    assert.equal(result.passed, true)
  })

  test('statusEntryMatches fails when no status entry matches', () => {
    const result = statusEntryMatches(/compaction: ok/).run([
      textEntry('Some text'),
      statusEntry('complete')
    ])
    assert.equal(result.passed, false)
    assert.ok(result.reason?.includes('No status entry matched'))
  })

  test('statusEntryMatches fails with empty transcript', () => {
    const result = statusEntryMatches(/anything/).run([])
    assert.equal(result.passed, false)
  })

  test('statusEntryMatches ignores non-status entries', () => {
    const result = statusEntryMatches(/compaction/).run([
      textEntry('compaction: ok'),
      errorEntry('compaction error')
    ])
    assert.equal(result.passed, false)
  })

  // ── runAssertions ──

  test('runAssertions runs all and returns results', () => {
    const transcript: E2ETranscriptEntry[] = [textEntry('Hello World')]
    const results = runAssertions(
      [streamCompleted(), noErrorChunks(), responseMinLength(5)],
      transcript
    )
    assert.equal(results.length, 3)
    assert.ok(results.every((r) => r.passed))
  })

  test('runAssertions catches throwing assertions', () => {
    const badAssertion = {
      name: 'exploder',
      run: () => { throw new Error('boom') }
    }
    const results = runAssertions([badAssertion], [textEntry('x')])
    assert.equal(results.length, 1)
    assert.equal(results[0].passed, false)
    assert.ok(results[0].reason?.includes('boom'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
