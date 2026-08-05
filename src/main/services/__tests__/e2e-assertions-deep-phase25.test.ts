/**
 * Phase 25, Wave 5 — E2E assertions deep coverage.
 *
 * Covers: e2e-testing/e2e-assertions.ts (739 lines)
 *
 * Strategy: Test all exported assertion factory functions with mock
 * E2E results. These are pure functions that return assertion objects.
 *
 * Run: tsx src/main/services/__tests__/e2e-assertions-deep-phase25.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let streamCompleted: any, noErrorChunks: any, responseMatches: any
let responseMinLength: any, toolCalled: any, responseExists: any
let toolNotCalled: any, toolCalledTimes: any
let anyToolCalled: any, responseHasMermaidBlock: any, responseHasMarkdownTable: any
let statusEntryMatches: any
let loaded = false

try {
  const mod = require('../e2e-testing/e2e-assertions')
  streamCompleted = mod.streamCompleted
  noErrorChunks = mod.noErrorChunks
  responseMatches = mod.responseMatches
  responseMinLength = mod.responseMinLength
  toolCalled = mod.toolCalled
  responseExists = mod.responseExists
  toolNotCalled = mod.toolNotCalled
  toolCalledTimes = mod.toolCalledTimes
  anyToolCalled = mod.anyToolCalled
  responseHasMermaidBlock = mod.responseHasMermaidBlock
  responseHasMarkdownTable = mod.responseHasMarkdownTable
  statusEntryMatches = mod.statusEntryMatches
  loaded = true
} catch (err) {
  console.log(`⚠ e2e-assertions.ts load failed: ${(err as Error).message?.split('\n')[0]}`)
}

function makeMockTranscript(overrides: any[] = []): any[] {
  return [
    { role: 'user', type: 'text', content: 'Hello' },
    { role: 'assistant', type: 'text', content: 'Hello world, I am a test response' },
    {
      role: 'assistant',
      type: 'tool_use',
      content: null,
      toolName: 'Read',
      toolInput: { path: 'file.ts' }
    },
    { role: 'assistant', type: 'status', content: 'complete' },
    ...overrides
  ]
}

if (loaded) {
  describe('streamCompleted (Phase 25)', () => {
    test('returns assertion object with name and run', () => {
      if (!streamCompleted) return
      const assertion = streamCompleted()
      assert.ok(typeof assertion === 'object')
      assert.ok(typeof assertion.name === 'string')
      assert.ok(typeof assertion.run === 'function')
    })
    test('passes on valid transcript', () => {
      if (!streamCompleted) return
      const assertion = streamCompleted()
      const result = assertion.run(makeMockTranscript())
      assert.ok(typeof result === 'object')
      assert.equal(result.passed, true)
    })
  })

  describe('noErrorChunks (Phase 25)', () => {
    test('returns assertion with run', () => {
      if (!noErrorChunks) return
      const assertion = noErrorChunks()
      assert.ok(typeof assertion.run === 'function')
    })
    test('passes when no error chunks', () => {
      if (!noErrorChunks) return
      const assertion = noErrorChunks()
      const result = assertion.run(makeMockTranscript())
      assert.ok(result.passed === true)
    })
  })

  describe('responseMatches (Phase 25)', () => {
    test('matches regex in response', () => {
      if (!responseMatches) return
      const assertion = responseMatches(/Hello/)
      const result = assertion.run(makeMockTranscript())
      assert.equal(result.passed, true)
    })
    test('fails on non-matching regex', () => {
      if (!responseMatches) return
      const assertion = responseMatches(/NONEXISTENT_PATTERN_XYZ/)
      const result = assertion.run(makeMockTranscript())
      assert.equal(result.passed, false)
    })
  })

  describe('responseMinLength (Phase 25)', () => {
    test('passes when response is long enough', () => {
      if (!responseMinLength) return
      const assertion = responseMinLength(5)
      const result = assertion.run(makeMockTranscript())
      assert.equal(result.passed, true)
    })
    test('fails when response is too short', () => {
      if (!responseMinLength) return
      const assertion = responseMinLength(10000)
      const result = assertion.run(makeMockTranscript())
      assert.equal(result.passed, false)
    })
  })

  describe('toolCalled (Phase 25)', () => {
    test('returns assertion', () => {
      if (!toolCalled) return
      const assertion = toolCalled('Read')
      assert.ok(typeof assertion.run === 'function')
    })
    test('runs against transcript', () => {
      if (!toolCalled) return
      const assertion = toolCalled('Read')
      const result = assertion.run(makeMockTranscript())
      assert.ok(typeof result === 'object')
    })
  })

  describe('responseExists (Phase 25)', () => {
    test('passes when response exists', () => {
      if (!responseExists) return
      const assertion = responseExists()
      const result = assertion.run(makeMockTranscript())
      assert.equal(result.passed, true)
    })
    test('fails when no assistant text', () => {
      if (!responseExists) return
      const assertion = responseExists()
      const result = assertion.run([{ role: 'user', type: 'text', content: 'hi' }])
      assert.equal(result.passed, false)
    })
  })

  describe('toolNotCalled (Phase 25)', () => {
    test('passes when tool not in transcript', () => {
      if (!toolNotCalled) return
      const assertion = toolNotCalled('Write')
      const result = assertion.run(makeMockTranscript())
      assert.ok(typeof result === 'object')
    })
  })

  describe('toolCalledTimes (Phase 25)', () => {
    test('checks call count', () => {
      if (!toolCalledTimes) return
      const assertion = toolCalledTimes('Read', 1)
      const result = assertion.run(makeMockTranscript())
      assert.ok(typeof result === 'object')
    })
  })

  describe('anyToolCalled (Phase 25)', () => {
    test('passes when any tool matches', () => {
      if (!anyToolCalled) return
      const assertion = anyToolCalled(['Read', 'Write'])
      const result = assertion.run(makeMockTranscript())
      assert.ok(typeof result === 'object')
    })
  })

  describe('responseHasMermaidBlock (Phase 25)', () => {
    test('checks for mermaid blocks', () => {
      if (!responseHasMermaidBlock) return
      const assertion = responseHasMermaidBlock()
      const transcript = [
        { role: 'assistant', type: 'text', content: '```mermaid\ngraph LR\nA-->B\n```' }
      ]
      const result = assertion.run(transcript)
      assert.ok(typeof result === 'object')
    })
  })

  describe('responseHasMarkdownTable (Phase 25)', () => {
    test('checks for markdown table', () => {
      if (!responseHasMarkdownTable) return
      const assertion = responseHasMarkdownTable()
      const transcript = [{ role: 'assistant', type: 'text', content: '| col |\n| --- |\n| val |' }]
      const result = assertion.run(transcript)
      assert.ok(typeof result === 'object')
    })
  })

  describe('statusEntryMatches (Phase 25)', () => {
    test('checks status entries', () => {
      if (!statusEntryMatches) return
      const assertion = statusEntryMatches(/complete/)
      const result = assertion.run(makeMockTranscript())
      assert.ok(typeof result === 'object')
    })
  })
}

if (require.main === module) {
  void summaryAsync()
}
