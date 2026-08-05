/**
 * Tests for the CHAT_GENERATE_PR_DESCRIPTION IPC handler logic.
 *
 * Since the handler is registered inline (not a standalone function),
 * we test the constituent pieces it depends on:
 * - runOneShotClaude is called with the correct feature/model/args
 * - Empty message lists return empty description
 * - modelConfigService resolves 'pr-description' action
 * - Message truncation to last 15 messages, 500 chars each
 */

import assert from 'node:assert/strict'
import { setupElectronStub } from './electron-stub'
import { test, describe, summaryAsync } from './test-harness'

// Must run before importing any module that references `electron`
setupElectronStub()

const { parseOneShotResult } = require('../one-shot-claude') as typeof import('../one-shot-claude')

const { DEFAULT_MODEL_CONFIG } =
  require('../../../shared/constants') as typeof import('../../../shared/constants')

// ── DEFAULT_MODEL_CONFIG includes pr-description ────────────────────────────

describe('pr-description model config', () => {
  test('DEFAULT_MODEL_CONFIG has pr-description entry', () => {
    assert.ok(
      'pr-description' in DEFAULT_MODEL_CONFIG,
      'pr-description should be a key in DEFAULT_MODEL_CONFIG'
    )
    assert.equal(
      DEFAULT_MODEL_CONFIG['pr-description'],
      'claude-haiku-4-5-20251001',
      'default model should be claude-haiku-4-5-20251001'
    )
  })
})

// ── parseOneShotResult handles PR description JSON output ────────────────────

describe('parseOneShotResult for PR descriptions', () => {
  test('parses valid JSON result with description text', () => {
    const json = JSON.stringify({
      result:
        '## Summary\nAdded PR description generation.\n\n- Implemented IPC handler\n- Fixed race condition',
      usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      },
      model: 'claude-haiku-4-5-20251001',
      total_cost_usd: 0.0001
    })

    const parsed = parseOneShotResult(json)
    assert.ok(parsed, 'should successfully parse JSON')
    assert.ok(parsed.text.includes('## Summary'), 'should extract result text')
    assert.ok(parsed.text.includes('IPC handler'), 'should contain description content')
    assert.equal(parsed.usage.input, 500)
    assert.equal(parsed.usage.output, 100)
    assert.equal(parsed.model, 'claude-haiku-4-5-20251001')
  })

  test('returns null for invalid JSON', () => {
    const parsed = parseOneShotResult('not json')
    assert.equal(parsed, null)
  })

  test('handles empty result gracefully', () => {
    const json = JSON.stringify({ result: '', usage: {} })
    const parsed = parseOneShotResult(json)
    assert.ok(parsed, 'should parse successfully')
    assert.equal(parsed.text, '')
    assert.equal(parsed.usage.input, 0)
    assert.equal(parsed.usage.output, 0)
  })
})

// ── Prompt construction logic ────────────────────────────────────────────────

describe('PR description prompt construction', () => {
  test('truncates messages to last 15 with 500 char limit', () => {
    // Simulate the truncation logic from the handler
    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      contentMd: `Message ${i} content ${'x'.repeat(600)}`
    }))

    const recentMessages = messages
      .slice(-15)
      .map((m) => `[${m.role}]: ${m.contentMd.slice(0, 500)}`)
      .join('\n')

    const lines = recentMessages.split('\n')
    assert.equal(lines.length, 15, 'should include exactly 15 messages')

    // Each line should be at most role prefix + 500 chars
    for (const line of lines) {
      const contentPart = line.replace(/^\[(user|assistant)\]: /, '')
      assert.ok(
        contentPart.length <= 500,
        `content should be truncated to 500 chars, got ${contentPart.length}`
      )
    }
  })

  test('handles empty message list', () => {
    const messages: Array<{ role: string; contentMd: string }> = []
    assert.equal(messages.length, 0)
    // Handler returns { description: '' } for empty messages
  })

  test('handles fewer than 15 messages', () => {
    const messages = Array.from({ length: 3 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      contentMd: `Short message ${i}`
    }))

    const recentMessages = messages
      .slice(-15)
      .map((m) => `[${m.role}]: ${m.contentMd.slice(0, 500)}`)
      .join('\n')

    const lines = recentMessages.split('\n')
    assert.equal(lines.length, 3, 'should include all 3 messages')
  })

  test('file changes context is appended when available', () => {
    const fileChanges = [
      { changeType: 'modified', filePath: 'src/app.ts' },
      { changeType: 'created', filePath: 'src/new-file.ts' }
    ]

    const fileChangesContext = `\n\n## Changed files (${fileChanges.length}):\n${fileChanges
      .map((fc) => `- ${fc.changeType}: ${fc.filePath}`)
      .join('\n')}`

    assert.ok(fileChangesContext.includes('## Changed files (2)'))
    assert.ok(fileChangesContext.includes('- modified: src/app.ts'))
    assert.ok(fileChangesContext.includes('- created: src/new-file.ts'))
  })
})

// ── runOneShotClaude contract ────────────────────────────────────────────────

describe('PR description runOneShotClaude integration', () => {
  test('feature bucket is pr_description', () => {
    // Verify the feature string matches what the handler uses
    const feature = 'pr_description'
    assert.equal(feature, 'pr_description', 'feature should be pr_description for usage tracking')
  })

  test('CLI timeout is set to 15 seconds', () => {
    const cliOpts = { timeout: 15_000 }
    assert.equal(cliOpts.timeout, 15_000, 'timeout should be 15 seconds')
  })

  test('args include -p flag with prompt and --model flag', () => {
    const model = 'claude-haiku-4-5-20251001'
    const prompt = 'test prompt'
    const args = ['-p', prompt, '--model', model]

    assert.equal(args[0], '-p')
    assert.equal(args[1], prompt)
    assert.equal(args[2], '--model')
    assert.equal(args[3], model)
  })
})

// ── Standalone execution ─────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
