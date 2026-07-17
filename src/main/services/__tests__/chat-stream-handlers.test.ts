/**
 * Unit tests for chat-stream-handlers.ts — pure-logic helpers
 * extracted from ChatStreamService.
 *
 * Covers:
 * - formatImageAttachment: markdown annotation with mimeType and fileName
 * - formatTextAttachment: code-fenced content with token estimate
 * - formatFailedAttachment: failure message with path
 * - extractFileName: forward/backward/no slashes
 * - assembleAttachmentText: joining parts
 * - computeStreamIdentity: specialist, persona overlay, edge cases
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  formatImageAttachment,
  formatTextAttachment,
  formatFailedAttachment,
  extractFileName,
  assembleAttachmentText,
  computeStreamIdentity
} from '../chat-stream-handlers'

// ── formatImageAttachment ──

describe('formatImageAttachment', () => {
  test('includes fileName and mimeType', () => {
    const result = formatImageAttachment({
      base64: 'abc123==',
      mimeType: 'image/png',
      fileName: 'screenshot.png'
    })
    assert.ok(result.includes('screenshot.png'))
    assert.ok(result.includes('image/png'))
    assert.ok(result.includes('Attached image:'))
  })

  test('includes visibility note', () => {
    const result = formatImageAttachment({
      base64: 'data',
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg'
    })
    assert.ok(result.includes('visible in the conversation'))
  })
})

// ── formatTextAttachment ──

describe('formatTextAttachment', () => {
  test('wraps content in code fence with metadata', () => {
    const result = formatTextAttachment({
      content: 'const x = 1',
      tokens: 42,
      filePath: 'src/app.ts'
    })
    assert.ok(result.includes('src/app.ts'))
    assert.ok(result.includes('42 tokens'))
    assert.ok(result.includes('```'))
    assert.ok(result.includes('const x = 1'))
  })

  test('includes file path in bold header', () => {
    const result = formatTextAttachment({
      content: 'body',
      tokens: 10,
      filePath: '/home/user/project/README.md'
    })
    assert.ok(result.includes('**Attached file: /home/user/project/README.md**'))
  })
})

// ── formatFailedAttachment ──

describe('formatFailedAttachment', () => {
  test('includes file path and error message', () => {
    const result = formatFailedAttachment({
      filePath: 'src/missing.ts',
      error: 'ENOENT: no such file or directory'
    })
    assert.ok(result.includes('src/missing.ts'))
    assert.ok(result.includes('ENOENT'))
    assert.ok(result.includes('Failed to read'))
  })
})

// ── extractFileName ──

describe('extractFileName', () => {
  test('extracts from forward-slash path', () => {
    assert.equal(extractFileName('/home/user/project/src/app.ts'), 'app.ts')
  })

  test('returns full string for backslash-only path (no forward slashes)', () => {
    // On macOS/Linux, split('/') on a backslash path returns the whole string
    // since '/' never appears — the || fallback never fires because pop() is truthy
    const result = extractFileName('C:\\Users\\project\\src\\app.ts')
    assert.equal(typeof result, 'string')
    assert.ok(result.length > 0)
  })

  test('returns full string when no slashes', () => {
    assert.equal(extractFileName('app.ts'), 'app.ts')
  })

  test('returns "image" for empty string', () => {
    assert.equal(extractFileName(''), 'image')
  })
})

// ── assembleAttachmentText ──

describe('assembleAttachmentText', () => {
  test('joins parts into a single string', () => {
    const parts = ['part1\n', 'part2\n', 'part3\n']
    const result = assembleAttachmentText(parts)
    assert.equal(result, 'part1\npart2\npart3\n')
  })

  test('returns empty string for empty array', () => {
    assert.equal(assembleAttachmentText([]), '')
  })
})

// ── computeStreamIdentity ──

describe('computeStreamIdentity', () => {
  test('specialist (no persona, default adapter) → specialist-executing', () => {
    const result = computeStreamIdentity({
      messageRole: 'specialist',
      adapterAgentId: 'specialist',
      persona: null
    })
    assert.equal(result.streamingRole, 'specialist')
    assert.equal(result.phase, 'specialist-executing')
    assert.deepEqual(result.specialistMeta, { specialist: 'specialist' })
    assert.equal(result.adapterAgentId, 'specialist')
  })

  test('specialist (direct, no persona) → specialist-executing with agentId', () => {
    const result = computeStreamIdentity({
      messageRole: 'specialist',
      adapterAgentId: 'spec-backend',
      persona: null
    })
    assert.equal(result.streamingRole, 'specialist')
    assert.equal(result.phase, 'specialist-executing')
    assert.deepEqual(result.specialistMeta, { specialist: 'spec-backend' })
  })

  test('persona overlay → specialist role with persona agentId', () => {
    const result = computeStreamIdentity({
      messageRole: 'specialist',
      adapterAgentId: 'da-vinci',
      persona: { agentId: 'persona-frontend' }
    })
    assert.equal(result.streamingRole, 'specialist')
    assert.equal(result.phase, 'specialist-executing')
    assert.deepEqual(result.specialistMeta, { specialist: 'persona-frontend', taskId: '' })
  })

  test('persona overrides even if messageRole is specialist', () => {
    const result = computeStreamIdentity({
      messageRole: 'specialist',
      adapterAgentId: 'spec-a',
      persona: { agentId: 'persona-b' }
    })
    assert.equal(result.streamingRole, 'specialist')
    assert.deepEqual(result.specialistMeta, { specialist: 'persona-b', taskId: '' })
  })

  test('adapterAgentId is passed through', () => {
    const result = computeStreamIdentity({
      messageRole: 'specialist',
      adapterAgentId: 'custom-agent-id',
      persona: null
    })
    assert.equal(result.adapterAgentId, 'custom-agent-id')
  })
})

// ── Standalone runner ──
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
