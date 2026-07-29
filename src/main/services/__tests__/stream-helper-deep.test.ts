/**
 * Unit tests for stream-helper.ts — pure filler generators + chunk-to-transcript mapper.
 *
 * Targets: src/main/services/e2e-testing/stream-helper.ts (22% → 80%)
 * All functions tested here are stateless — zero mocking required.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// Dynamic import — stream-helper transitively imports chat-agent → db/index
// which needs the electron stub's .sql?raw hook to be installed first.
void (async () => {
  const {
    generateFillerWithNeedle,
    generateNoWhitespaceFiller,
    chunkToTranscriptEntry,
  } = await import('../e2e-testing/stream-helper')

  // ── generateFillerWithNeedle ───────────────────────────────────────────────

  describe('stream-helper › generateFillerWithNeedle', () => {
    test('produces output of approximately the requested length', () => {
      const result = generateFillerWithNeedle(5000)
      assert.ok(result.length >= 5000, `Expected ≥5000, got ${result.length}`)
    })

    test('contains the SECRET_CODE needle', () => {
      const result = generateFillerWithNeedle(1000)
      assert.ok(result.includes('SECRET_CODE: NEEDLE-7X9Q'))
    })

    test('needle appears at the end', () => {
      const result = generateFillerWithNeedle(2000)
      assert.ok(result.endsWith('\n\nSECRET_CODE: NEEDLE-7X9Q\n\n'))
    })

    test('cycles through paragraphs', () => {
      const result = generateFillerWithNeedle(5000)
      assert.ok(result.includes('The history of computing'))
      assert.ok(result.includes('Software engineering principles'))
      assert.ok(result.includes('Database systems'))
      assert.ok(result.includes('Networking protocols'))
      assert.ok(result.includes('Cloud computing'))
      assert.ok(result.includes('Machine learning'))
      assert.ok(result.includes('Cryptographic systems'))
      assert.ok(result.includes('Programming language theory'))
    })

    test('small char count still includes needle', () => {
      const result = generateFillerWithNeedle(50)
      assert.ok(result.includes('SECRET_CODE: NEEDLE-7X9Q'))
    })

    test('large char count produces large output', () => {
      const result = generateFillerWithNeedle(50000)
      assert.ok(result.length >= 50000, `Expected ≥50000, got ${result.length}`)
    })
  })

  // ── generateNoWhitespaceFiller ─────────────────────────────────────────────

  describe('stream-helper › generateNoWhitespaceFiller', () => {
    test('produces output of approximately the requested length', () => {
      const result = generateNoWhitespaceFiller(5000)
      assert.ok(result.length >= 5000, `Expected ≥5000, got ${result.length}`)
    })

    test('contains no whitespace characters in filler portion', () => {
      const result = generateNoWhitespaceFiller(1000)
      const withoutNeedle = result.replace('SECRET_CODE:NEEDLE-7X9Q', '')
      assert.ok(!/\s/.test(withoutNeedle), 'Filler should have no whitespace')
    })

    test('uses hex-like alphabet characters', () => {
      const result = generateNoWhitespaceFiller(500)
      const filler = result.replace('SECRET_CODE:NEEDLE-7X9Q', '')
      const validChars = new Set('abcdef0123456789ABCDEF')
      for (const ch of filler) {
        assert.ok(validChars.has(ch), `Unexpected character: '${ch}'`)
      }
    })

    test('contains the needle at the end', () => {
      const result = generateNoWhitespaceFiller(2000)
      assert.ok(result.endsWith('SECRET_CODE:NEEDLE-7X9Q'))
    })

    test('small char count still includes needle', () => {
      const result = generateNoWhitespaceFiller(30)
      assert.ok(result.includes('SECRET_CODE:NEEDLE-7X9Q'))
    })
  })

  // ── chunkToTranscriptEntry ─────────────────────────────────────────────────

  describe('stream-helper › chunkToTranscriptEntry', () => {
    test('text chunk → assistant/text', () => {
      const entry = chunkToTranscriptEntry({ type: 'text', content: 'Hello world' } as any)
      assert.ok(entry)
      assert.equal(entry.role, 'assistant')
      assert.equal(entry.type, 'text')
      assert.equal(entry.content, 'Hello world')
      assert.equal(typeof entry.timestamp, 'number')
    })

    test('text chunk with missing content → empty string', () => {
      const entry = chunkToTranscriptEntry({ type: 'text' } as any)
      assert.ok(entry)
      assert.equal(entry.content, '')
    })

    test('thinking chunk → assistant/thinking', () => {
      const entry = chunkToTranscriptEntry({ type: 'thinking', content: 'Let me think...' } as any)
      assert.ok(entry)
      assert.equal(entry.role, 'assistant')
      assert.equal(entry.type, 'thinking')
      assert.equal(entry.content, 'Let me think...')
    })

    test('tool_use chunk → assistant/tool_use with parsed args', () => {
      const entry = chunkToTranscriptEntry({
        type: 'tool_use',
        toolName: 'read_file',
        toolInput: '{"path": "/src/app.ts"}',
      } as any)
      assert.ok(entry)
      assert.equal(entry.role, 'assistant')
      assert.equal(entry.type, 'tool_use')
      assert.equal(entry.toolName, 'read_file')
      assert.deepEqual(entry.toolArgs, { path: '/src/app.ts' })
    })

    test('tool_use chunk with invalid JSON → undefined args', () => {
      const entry = chunkToTranscriptEntry({
        type: 'tool_use',
        toolName: 'run_command',
        toolInput: '{invalid json',
      } as any)
      assert.ok(entry)
      assert.equal(entry.type, 'tool_use')
      assert.equal(entry.toolArgs, undefined)
    })

    test('tool_use chunk with no toolInput → undefined args', () => {
      const entry = chunkToTranscriptEntry({
        type: 'tool_use',
        toolName: 'search',
      } as any)
      assert.ok(entry)
      assert.equal(entry.toolArgs, undefined)
    })

    test('tool_result chunk → assistant/tool_result', () => {
      const entry = chunkToTranscriptEntry({
        type: 'tool_result',
        toolName: 'read_file',
        content: 'file contents here',
      } as any)
      assert.ok(entry)
      assert.equal(entry.role, 'assistant')
      assert.equal(entry.type, 'tool_result')
      assert.equal(entry.toolName, 'read_file')
      assert.equal(entry.toolResult, 'file contents here')
    })

    test('error chunk → system/error with error field priority', () => {
      const entry = chunkToTranscriptEntry({
        type: 'error',
        error: 'Connection failed',
        content: 'fallback content',
      } as any)
      assert.ok(entry)
      assert.equal(entry.role, 'system')
      assert.equal(entry.type, 'error')
      assert.equal(entry.content, 'Connection failed')
    })

    test('error chunk without error field → content fallback', () => {
      const entry = chunkToTranscriptEntry({
        type: 'error',
        content: 'Some error content',
      } as any)
      assert.ok(entry)
      assert.equal(entry.content, 'Some error content')
    })

    test('error chunk without error or content → Unknown error', () => {
      const entry = chunkToTranscriptEntry({ type: 'error' } as any)
      assert.ok(entry)
      assert.equal(entry.content, 'Unknown error')
    })

    test('status chunk → system/status', () => {
      const entry = chunkToTranscriptEntry({ type: 'status', content: 'Processing...' } as any)
      assert.ok(entry)
      assert.equal(entry.role, 'system')
      assert.equal(entry.type, 'status')
      assert.equal(entry.content, 'Processing...')
    })

    test('compact_boundary chunk → system/status with prefix', () => {
      const entry = chunkToTranscriptEntry({ type: 'compact_boundary', content: 'reason' } as any)
      assert.ok(entry)
      assert.equal(entry.role, 'system')
      assert.equal(entry.type, 'status')
      assert.equal(entry.content, 'compact_boundary: reason')
    })

    test('context_usage_update chunk → system/status', () => {
      const entry = chunkToTranscriptEntry({ type: 'context_usage_update' } as any)
      assert.ok(entry)
      assert.equal(entry.content, 'context_usage_update')
    })

    test('permission_request chunk → system/status with toolName', () => {
      const entry = chunkToTranscriptEntry({
        type: 'permission_request',
        toolName: 'write_file',
      } as any)
      assert.ok(entry)
      assert.equal(entry.content, 'permission_request: write_file')
    })

    test('permission_request chunk without toolName → unknown', () => {
      const entry = chunkToTranscriptEntry({ type: 'permission_request' } as any)
      assert.ok(entry)
      assert.equal(entry.content, 'permission_request: unknown')
    })

    test('todo_update chunk → system/status', () => {
      const entry = chunkToTranscriptEntry({ type: 'todo_update' } as any)
      assert.ok(entry)
      assert.equal(entry.content, 'todo_update')
    })

    test('phase_progress chunk → system/status with title', () => {
      const entry = chunkToTranscriptEntry({
        type: 'phase_progress',
        phaseProgress: { phaseTitle: 'Build Phase' },
      } as any)
      assert.ok(entry)
      assert.equal(entry.content, 'phase_progress: Build Phase')
    })

    test('phase_progress without phaseProgress → empty title', () => {
      const entry = chunkToTranscriptEntry({ type: 'phase_progress' } as any)
      assert.ok(entry)
      assert.equal(entry.content, 'phase_progress: ')
    })

    test('turn_boundary chunk → system/status', () => {
      const entry = chunkToTranscriptEntry({ type: 'turn_boundary' } as any)
      assert.ok(entry)
      assert.equal(entry.content, 'turn_boundary')
    })

    test('unknown chunk type → system/status fallback with type name', () => {
      const entry = chunkToTranscriptEntry({
        type: 'custom_unknown_type',
        toolName: 'myTool',
        content: 'some content',
      } as any)
      assert.ok(entry)
      assert.equal(entry.role, 'system')
      assert.equal(entry.type, 'status')
      assert.ok(entry.content!.includes('custom_unknown_type'))
      assert.ok(entry.content!.includes('myTool'))
    })

    test('unknown chunk type without toolName or content', () => {
      const entry = chunkToTranscriptEntry({ type: 'exotic_type' } as any)
      assert.ok(entry)
      assert.equal(entry.content, 'exotic_type')
    })

    test('unknown chunk type with long content truncates to 200 chars', () => {
      const longContent = 'A'.repeat(300)
      const entry = chunkToTranscriptEntry({
        type: 'verbose_type',
        content: longContent,
      } as any)
      assert.ok(entry)
      assert.ok(entry.content!.length < 300, 'Should truncate long content')
      assert.ok(entry.content!.includes('verbose_type'))
    })

    test('all chunk types produce entries with numeric timestamps', () => {
      const types = ['text', 'thinking', 'tool_use', 'tool_result', 'error', 'status',
        'compact_boundary', 'context_usage_update', 'permission_request', 'todo_update',
        'phase_progress', 'turn_boundary'] as const
      for (const type of types) {
        const entry = chunkToTranscriptEntry({ type } as any)
        assert.ok(entry, `Entry for ${type} should not be null`)
        assert.equal(typeof entry.timestamp, 'number', `${type} should have numeric timestamp`)
      }
    })
  })
})()
