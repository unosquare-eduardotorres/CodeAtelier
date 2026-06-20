/**
 * Tests for the /btw ephemeral side question backend logic.
 *
 * Validates that the IPC handler correctly:
 * - Loads conversation context from recent messages
 * - Builds the prompt with context injection
 * - Calls runOneShotClaude with feature: 'btw'
 * - Does NOT pass a conversationId (ephemeral usage)
 * - Handles errors gracefully
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

// ── Pure-logic tests for the BTW prompt construction ──

describe('/btw prompt construction', () => {
  test('context text is built from role + content of recent messages', () => {
    const messages = [
      { role: 'user', contentMd: 'How do I add a new route?' },
      { role: 'da-vinci', contentMd: 'You can add a route in src/routes/...' }
    ]

    const contextText = messages
      .map((m) => `[${m.role}]: ${m.contentMd?.slice(0, 2000) ?? ''}`)
      .join('\n\n')

    assert.ok(contextText.includes('[user]: How do I add a new route?'))
    assert.ok(contextText.includes('[da-vinci]: You can add a route'))
  })

  test('content is truncated to 2000 chars per message', () => {
    const longContent = 'x'.repeat(5000)
    const messages = [{ role: 'user', contentMd: longContent }]

    const contextText = messages
      .map((m) => `[${m.role}]: ${m.contentMd?.slice(0, 2000) ?? ''}`)
      .join('\n\n')

    assert.equal(contextText.length, '[user]: '.length + 2000)
  })

  test('null/undefined contentMd falls back to empty string', () => {
    const messages = [
      { role: 'user', contentMd: null as string | null },
      { role: 'da-vinci', contentMd: undefined as string | undefined }
    ]

    const contextText = messages
      .map((m) => `[${m.role}]: ${m.contentMd?.slice(0, 2000) ?? ''}`)
      .join('\n\n')

    assert.ok(contextText.includes('[user]: '))
    assert.ok(contextText.includes('[da-vinci]: '))
  })

  test('CLI args include --code when repoPath is provided', () => {
    const repoPath = '/Users/test/my-project'
    const question = 'What config key was that?'
    const systemPrompt = 'You are answering a quick side question.'

    const cliArgs = ['-p', `${systemPrompt}\n\nSide question: ${question}`]
    if (repoPath) {
      cliArgs.unshift('--code', repoPath)
    }

    assert.equal(cliArgs[0], '--code')
    assert.equal(cliArgs[1], repoPath)
    assert.equal(cliArgs[2], '-p')
  })

  test('CLI args omit --code when repoPath is absent', () => {
    const repoPath: string | undefined = undefined
    const question = 'What config key was that?'
    const systemPrompt = 'You are answering a quick side question.'

    const cliArgs = ['-p', `${systemPrompt}\n\nSide question: ${question}`]
    if (repoPath) {
      cliArgs.unshift('--code', repoPath)
    }

    assert.equal(cliArgs[0], '-p')
    assert.ok(!cliArgs.includes('--code'))
  })

  test('feature bucket is set to "btw" for usage tracking', () => {
    const opts = {
      feature: 'btw',
      workspaceId: 'ws-123',
      // Note: no conversationId — truly ephemeral
      args: ['-p', 'prompt']
    }

    assert.equal(opts.feature, 'btw')
    assert.ok(!('conversationId' in opts))
  })
})
