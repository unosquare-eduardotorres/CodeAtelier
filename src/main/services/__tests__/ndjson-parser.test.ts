/**
 * Unit tests for ndjson-parser — NDJSON stream parser and writer for the
 * Claude CLI interactive mode.
 *
 * Pure logic tests using in-memory Node Readable streams. electron-log is
 * import-safe under tsx.
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test, describe, summaryAsync } from './test-harness'
import {
  parseNdjsonStream,
  writeNdjsonMessage,
  buildUserMessage
} from '../cli-executor/ndjson-parser'

/** Create a Readable from an array of string chunks. */
function streamFrom(chunks: string[]): Readable {
  return Readable.from(chunks)
}

/** Collect all yielded objects from the async generator. */
async function collectParsed(
  stream: Readable,
  log?: { warn: (msg: string) => void }
): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = []
  for await (const obj of parseNdjsonStream(stream, log)) {
    results.push(obj)
  }
  return results
}

// ── parseNdjsonStream ────────────────────────────────────────────────────────

describe('parseNdjsonStream', () => {
  test('parses complete lines into JSON objects', async () => {
    const stream = streamFrom(['{"type":"a"}\n{"type":"b"}\n'])
    const results = await collectParsed(stream)
    assert.equal(results.length, 2)
    assert.equal(results[0].type, 'a')
    assert.equal(results[1].type, 'b')
  })

  test('handles partial lines split across chunks', async () => {
    const stream = streamFrom(['{"ty', 'pe":"split"}\n'])
    const results = await collectParsed(stream)
    assert.equal(results.length, 1)
    assert.equal(results[0].type, 'split')
  })

  test('skips empty lines', async () => {
    const stream = streamFrom(['{"type":"a"}\n\n\n{"type":"b"}\n'])
    const results = await collectParsed(stream)
    assert.equal(results.length, 2)
  })

  test('malformed JSON yields parse_error object', async () => {
    const warnings: string[] = []
    const log = { warn: (msg: string) => warnings.push(msg) }
    const stream = streamFrom(['{invalid json}\n{"type":"ok"}\n'])
    const results = await collectParsed(stream, log)
    assert.equal(results.length, 2)
    assert.equal(results[0].type, 'parse_error')
    assert.ok(typeof results[0].error === 'string')
    assert.ok((results[0].raw as string).includes('invalid json'))
    assert.equal(results[1].type, 'ok')
    assert.equal(warnings.length, 1)
  })

  test('flushes remaining buffer at stream end (valid JSON)', async () => {
    const stream = streamFrom(['{"type":"final"}']) // no trailing newline
    const results = await collectParsed(stream)
    assert.equal(results.length, 1)
    assert.equal(results[0].type, 'final')
  })

  test('flushes remaining buffer at stream end (malformed)', async () => {
    const warnings: string[] = []
    const stream = streamFrom(['{bad']) // no trailing newline, invalid
    const results = await collectParsed(stream, { warn: (m) => warnings.push(m) })
    assert.equal(results.length, 1)
    assert.equal(results[0].type, 'parse_error')
    assert.equal(warnings.length, 1)
  })

  test('handles Buffer chunks (not just strings)', async () => {
    const stream = Readable.from([Buffer.from('{"type":"buf"}\n')])
    const results = await collectParsed(stream)
    assert.equal(results.length, 1)
    assert.equal(results[0].type, 'buf')
  })

  test('works without a log argument (no-op log)', async () => {
    const stream = streamFrom(['{bad}\n'])
    const results = await collectParsed(stream) // no log passed
    assert.equal(results.length, 1)
    assert.equal(results[0].type, 'parse_error')
  })
})

// ── writeNdjsonMessage ───────────────────────────────────────────────────────

describe('writeNdjsonMessage', () => {
  test('serializes message + newline to the stream', () => {
    let written = ''
    const mockStream = {
      write: (data: string) => {
        written = data
        return true
      }
    } as unknown as NodeJS.WritableStream
    const ok = writeNdjsonMessage(mockStream, { type: 'user', text: 'hi' })
    assert.equal(ok, true)
    assert.ok(written.endsWith('\n'))
    assert.deepEqual(JSON.parse(written.trim()), { type: 'user', text: 'hi' })
  })

  test('returns false when stream.write returns false (backpressure)', () => {
    const mockStream = {
      write: () => false
    } as unknown as NodeJS.WritableStream
    const ok = writeNdjsonMessage(mockStream, { type: 'test' })
    assert.equal(ok, false)
  })

  test('returns false when stream.write throws', () => {
    const mockStream = {
      write: () => {
        throw new Error('broken pipe')
      }
    } as unknown as NodeJS.WritableStream
    const ok = writeNdjsonMessage(mockStream, { type: 'test' })
    assert.equal(ok, false)
  })
})

// ── buildUserMessage ─────────────────────────────────────────────────────────

describe('buildUserMessage', () => {
  test('wraps text string into content blocks', () => {
    const msg = buildUserMessage('Hello, Claude')
    assert.equal(msg.type, 'user')
    const message = msg.message as Record<string, unknown>
    assert.equal(message.role, 'user')
    const content = message.content as Array<Record<string, unknown>>
    assert.equal(content.length, 1)
    assert.equal(content[0].type, 'text')
    assert.equal(content[0].text, 'Hello, Claude')
  })

  test('passes through array content blocks unchanged', () => {
    const blocks = [
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', data: 'abc' } }
    ]
    const msg = buildUserMessage(blocks)
    const message = msg.message as Record<string, unknown>
    assert.deepEqual(message.content, blocks)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
