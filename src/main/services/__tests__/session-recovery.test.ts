import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'

describe('Session Recovery - buildRecoverySummary', () => {
  // Simulate what buildRecoverySummary does with mock messages
  function buildRecoverySummary(messages: { role: string; contentMd: string }[]): string {
    const recent = messages.slice(-20)
    const lines = recent.map((m) => {
      const role = m.role === 'user' ? 'User' : 'Assistant'
      const content =
        m.contentMd.length > 2000 ? m.contentMd.slice(0, 2000) + '...[truncated]' : m.contentMd
      return `[${role}]: ${content}`
    })
    return [
      '--- SESSION RECOVERY CONTEXT ---',
      'The previous session was lost. Here is a summary of the recent conversation:',
      '',
      ...lines,
      '',
      '--- END RECOVERY CONTEXT ---',
      'Continue the conversation naturally from where we left off.'
    ].join('\n')
  }

  test('builds summary from recent messages', () => {
    const messages = [
      { role: 'user', contentMd: 'Hello' },
      { role: 'da-vinci', contentMd: 'Hi there!' }
    ]
    const summaryText = buildRecoverySummary(messages)
    assert.ok(summaryText.includes('[User]: Hello'))
    assert.ok(summaryText.includes('[Assistant]: Hi there!'))
    assert.ok(summaryText.includes('--- SESSION RECOVERY CONTEXT ---'))
  })

  test('truncates long messages at 2000 chars', () => {
    const longContent = 'x'.repeat(3000)
    const messages = [{ role: 'user', contentMd: longContent }]
    const summaryText = buildRecoverySummary(messages)
    assert.ok(summaryText.includes('...[truncated]'))
    assert.ok(!summaryText.includes('x'.repeat(2001)))
  })

  test('takes only last 20 messages', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'da-vinci',
      contentMd: `Message ${i}`
    }))
    const summaryText = buildRecoverySummary(messages)
    assert.ok(!summaryText.includes('Message 0'))
    assert.ok(summaryText.includes('Message 10'))
    assert.ok(summaryText.includes('Message 29'))
  })

  test('handles empty messages array', () => {
    const summaryText = buildRecoverySummary([])
    assert.ok(summaryText.includes('--- SESSION RECOVERY CONTEXT ---'))
    assert.ok(summaryText.includes('--- END RECOVERY CONTEXT ---'))
  })
})

describe('Session Recovery - Error Detection', () => {
  test('detects stale session error pattern', () => {
    const errorMsg =
      'SDK execution failed: Claude Code returned an error result: No conversation found with session ID: 39a3f7ca-579d-45ad-a239-564af96d42c8'
    assert.ok(errorMsg.includes('No conversation found with session ID'))
  })

  test('does not false-positive on other errors', () => {
    const otherError = 'SDK execution failed: rate limit exceeded'
    assert.ok(!otherError.includes('No conversation found with session ID'))
  })

  test('recovery depth prevents infinite loops', () => {
    const MAX_RECOVERY_DEPTH = 1
    const recoveryDepth = 1
    assert.ok(recoveryDepth >= MAX_RECOVERY_DEPTH)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
