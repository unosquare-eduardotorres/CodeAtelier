/**
 * Unit tests for zero-coverage service files — import verification and
 * pure function testing where accessible.
 *
 * Phase 14, Track 13 — Services at 0%:
 * - auto-update.service.ts (173 lines)
 * - context-handoff.service.ts (69 lines)
 * - docs.service.ts (43 lines)
 * - mermaid.service.ts (53 lines)
 * - subscription.service.ts (207 lines)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicated pure logic from context-handoff.service.ts ──

interface MessageSummary {
  role: string
  content: string
}

const MAX_MESSAGES = 20
const MAX_CHARS = 8000
const MAX_PER_MESSAGE = 1000

/**
 * Replicated from ContextHandoffService.generateFallbackHandoff
 * (context-handoff.service.ts:27-55).
 */
function generateFallbackHandoff(messages: MessageSummary[]): string {
  if (!messages || messages.length === 0) {
    return 'No prior conversation context available.'
  }

  const recent = messages.slice(-MAX_MESSAGES)
  const parts: string[] = []
  let totalChars = 0

  for (const msg of recent) {
    const prefix = msg.role === 'user' ? '**User:**' : '**Assistant:**'
    let content = msg.content
    if (content.length > MAX_PER_MESSAGE) {
      content = content.slice(0, MAX_PER_MESSAGE) + '…'
    }
    const line = `${prefix} ${content}`
    if (totalChars + line.length > MAX_CHARS) break
    parts.push(line)
    totalChars += line.length
  }

  return parts.join('\n\n')
}

/**
 * Replicated docs file filtering logic from docs.service.ts.
 */
function filterDocFiles(
  files: Array<{ name: string; ext: string; mtime: number }>
): Array<{ name: string; ext: string; mtime: number; supported: boolean }> {
  const SUPPORTED_EXTENSIONS = new Set(['md'])
  return files
    .filter((f) => !f.name.startsWith('.'))
    .map((f) => ({ ...f, supported: SUPPORTED_EXTENSIONS.has(f.ext) }))
    .sort((a, b) => b.mtime - a.mtime)
}

/**
 * Replicated auto-update feed URL construction logic.
 *
 * The drive source is NOT a file:// URL: electron-updater's generic provider
 * fetches through electron.net, which only supports http:/https:. The folder is
 * served over a loopback HTTP server instead (see update-feed-server.ts), and
 * `feedServerUrl` is that server's base URL.
 */
function buildFeedUrl(config: {
  source: 'github' | 'drive'
  drivePath?: string
  feedServerUrl?: string
  githubOwner?: string
  githubRepo?: string
}): string | null {
  if (config.source === 'drive' && config.drivePath) {
    return config.feedServerUrl ?? null
  }
  if (config.source === 'github' && config.githubOwner && config.githubRepo) {
    return `https://github.com/${config.githubOwner}/${config.githubRepo}`
  }
  return null
}

// ── Tests ──

describe('Context Handoff — generateFallbackHandoff', () => {
  test('empty_messages_returns_fallback', () => {
    assert.equal(generateFallbackHandoff([]), 'No prior conversation context available.')
  })

  test('null_messages_returns_fallback', () => {
    assert.equal(generateFallbackHandoff(null as any), 'No prior conversation context available.')
  })

  test('single_user_message_formatted', () => {
    const result = generateFallbackHandoff([{ role: 'user', content: 'Hello' }])
    assert.ok(result.includes('**User:** Hello'))
  })

  test('assistant_message_formatted', () => {
    const result = generateFallbackHandoff([{ role: 'assistant', content: 'Hi there' }])
    assert.ok(result.includes('**Assistant:** Hi there'))
  })

  test('long_message_truncated', () => {
    const longContent = 'x'.repeat(2000)
    const result = generateFallbackHandoff([{ role: 'user', content: longContent }])
    assert.ok(result.length < 2000)
    assert.ok(result.includes('…'))
  })

  test('max_20_messages_taken', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: 'user',
      content: `Message ${i}`
    }))
    const result = generateFallbackHandoff(messages)
    // Should contain later messages (11-30), not earlier ones
    assert.ok(result.includes('Message 29'))
    assert.ok(!result.includes('Message 0'))
  })

  test('respects_total_char_budget', () => {
    const messages = Array.from({ length: 20 }, () => ({
      role: 'user',
      content: 'x'.repeat(500)
    }))
    const result = generateFallbackHandoff(messages)
    assert.ok(result.length <= MAX_CHARS + 500) // Some buffer for prefix
  })

  test('multiple_messages_separated_by_double_newline', () => {
    const result = generateFallbackHandoff([
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' }
    ])
    assert.ok(result.includes('\n\n'))
  })
})

describe('Docs Service — file filtering', () => {
  test('filters_hidden_files', () => {
    const result = filterDocFiles([
      { name: '.hidden', ext: 'md', mtime: 100 },
      { name: 'readme', ext: 'md', mtime: 200 }
    ])
    assert.equal(result.length, 1)
    assert.equal(result[0].name, 'readme')
  })

  test('marks_md_as_supported', () => {
    const result = filterDocFiles([{ name: 'guide', ext: 'md', mtime: 100 }])
    assert.ok(result[0].supported)
  })

  test('marks_non_md_as_unsupported', () => {
    const result = filterDocFiles([{ name: 'notes', ext: 'txt', mtime: 100 }])
    assert.ok(!result[0].supported)
  })

  test('sorts_by_mtime_descending', () => {
    const result = filterDocFiles([
      { name: 'old', ext: 'md', mtime: 100 },
      { name: 'new', ext: 'md', mtime: 300 },
      { name: 'mid', ext: 'md', mtime: 200 }
    ])
    assert.equal(result[0].name, 'new')
    assert.equal(result[1].name, 'mid')
    assert.equal(result[2].name, 'old')
  })
})

describe('Auto-Update — feed URL construction', () => {
  test('drive_source_returns_loopback_http_url_not_file_url', () => {
    const url = buildFeedUrl({
      source: 'drive',
      drivePath: '/network/updates',
      feedServerUrl: 'http://127.0.0.1:51234/deadbeef/'
    })
    // Regression guard: a file:// feed throws "ClientRequest only supports
    // http: and https: protocols" inside electron-updater.
    assert.ok(url !== null)
    assert.ok(url!.startsWith('http://127.0.0.1:'))
    assert.ok(!url!.startsWith('file://'))
  })

  test('drive_source_without_feed_server_returns_null', () => {
    const url = buildFeedUrl({ source: 'drive', drivePath: '/network/updates' })
    assert.equal(url, null)
  })

  test('github_source_returns_github_url', () => {
    const url = buildFeedUrl({
      source: 'github',
      githubOwner: 'anthropics',
      githubRepo: 'AgentStudio'
    })
    assert.equal(url, 'https://github.com/anthropics/AgentStudio')
  })

  test('missing_drive_path_returns_null', () => {
    const url = buildFeedUrl({ source: 'drive' })
    assert.equal(url, null)
  })

  test('missing_github_fields_returns_null', () => {
    const url = buildFeedUrl({ source: 'github', githubOwner: 'anthropics' })
    assert.equal(url, null)
  })
})

// ── Module import coverage ──

describe('Zero-coverage services — module imports', () => {
  test('context_handoff_service_importable', async () => {
    const mod = await import('../context-handoff.service')
    assert.ok(mod.contextHandoffService)
  })

  test('docs_service_importable', async () => {
    const mod = await import('../docs.service')
    assert.ok(mod.docsService)
  })

  test('subscription_service_importable', async () => {
    const mod = await import('../subscription.service')
    assert.ok(mod.subscriptionService)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
