/**
 * Phase 27 — handoff-redaction.ts pure function tests.
 *
 * redactEnvelope is the main export; internally it uses redactSecrets,
 * redactPII, normalizePaths, and redactExtensions. All are pure string
 * manipulation — no I/O, no side effects.
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'
import { redactEnvelope } from '../handoff-redaction'
import type { HandoffEnvelope } from '../../../shared/handoff-types'

// ── helper: minimal valid envelope ──

function baseEnvelope(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    version: '1.0',
    intent: 'Fix the bug',
    originalGoal: 'Fix authentication',
    contextSummary: 'Working on auth module',
    constraints: [],
    completedWork: [],
    remainingWork: [],
    decisions: [],
    risks: [],
    artifacts: [],
    filesToReadFirst: [],
    commandsToRunFirst: [],
    suggestedTools: [],
    suggestedSkills: [],
    ...overrides
  } as HandoffEnvelope
}

// ── Secret Redaction ──

describe('redactEnvelope — secret redaction', () => {
  test('redacts Anthropic API keys from intent', () => {
    const env = baseEnvelope({ intent: 'Use key sk-ant-abcdefghijklmnopqrstuvwxyz1234' })
    const result = redactEnvelope(env)
    assert.ok(!result.intent.includes('sk-ant-'))
    assert.ok(result.intent.includes('[REDACTED:anthropic-key]'))
  })

  test('redacts OpenAI API keys from originalGoal', () => {
    const env = baseEnvelope({ originalGoal: 'Key is sk-abcdefghijklmnopqrstuvwx' })
    const result = redactEnvelope(env)
    assert.ok(!result.originalGoal.includes('sk-abcdefg'))
    assert.ok(result.originalGoal.includes('[REDACTED:openai-key]'))
  })

  test('redacts GitHub tokens from contextSummary', () => {
    const env = baseEnvelope({
      contextSummary: 'Token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
    })
    const result = redactEnvelope(env)
    assert.ok(result.contextSummary.includes('[REDACTED:github-token]'))
  })

  test('redacts GitHub fine-grained PATs', () => {
    const env = baseEnvelope({
      intent: 'Pat github_pat_ABCDEFGHIJKLMNOPQRSTUVW'
    })
    const result = redactEnvelope(env)
    assert.ok(result.intent.includes('[REDACTED:github-pat]'))
  })

  test('redacts Bearer tokens', () => {
    const env = baseEnvelope({
      contextSummary: 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI'
    })
    const result = redactEnvelope(env)
    assert.ok(result.contextSummary.includes('Bearer [REDACTED]'))
  })

  test('redacts env-style API keys', () => {
    const env = baseEnvelope({
      intent: 'ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz1234'
    })
    const result = redactEnvelope(env)
    assert.ok(result.intent.includes('[REDACTED'))
  })

  test('redacts secrets in constraints array', () => {
    const env = baseEnvelope({
      constraints: ['Do not expose sk-ant-abcdefghijklmnopqrstuvwxyz1234']
    })
    const result = redactEnvelope(env)
    assert.ok(result.constraints[0].includes('[REDACTED'))
  })
})

// ── PII Redaction ──

describe('redactEnvelope — PII redaction', () => {
  test('redacts email addresses', () => {
    const env = baseEnvelope({ intent: 'Contact john@example.com for help' })
    const result = redactEnvelope(env)
    assert.ok(result.intent.includes('[REDACTED:email]'))
    assert.ok(!result.intent.includes('john@example.com'))
  })

  test('redacts phone numbers', () => {
    const env = baseEnvelope({ contextSummary: 'Call 555-123-4567 for support' })
    const result = redactEnvelope(env)
    assert.ok(result.contextSummary.includes('[REDACTED:phone]'))
  })
})

// ── Path Normalization ──

describe('redactEnvelope — path normalization', () => {
  test('normalizes /Users/username paths to ~', () => {
    const env = baseEnvelope({
      filesToReadFirst: ['/Users/john/project/src/index.ts']
    })
    const result = redactEnvelope(env)
    assert.ok(result.filesToReadFirst[0].includes('~'))
    assert.ok(!result.filesToReadFirst[0].includes('/Users/john'))
  })

  test('normalizes /home/username paths to ~', () => {
    const env = baseEnvelope({
      filesToReadFirst: ['/home/dev/app/main.py']
    })
    const result = redactEnvelope(env)
    assert.ok(result.filesToReadFirst[0].includes('~'))
  })

  test('normalizes artifact paths', () => {
    const env = baseEnvelope({
      artifacts: [
        { path: '/Users/john/project/dist/bundle.js', description: 'Build output', type: 'file' }
      ]
    })
    const result = redactEnvelope(env)
    assert.ok(result.artifacts[0].path.includes('~'))
  })
})

// ── Nested Fields ──

describe('redactEnvelope — nested field redaction', () => {
  test('redacts completedWork titles and outcomes', () => {
    const env = baseEnvelope({
      completedWork: [
        {
          title: 'Used sk-ant-abcdefghijklmnopqrstuvwxyz1234',
          outcome: 'Success at /Users/john/project',
          filesModified: ['/Users/john/project/src/auth.ts']
        }
      ]
    })
    const result = redactEnvelope(env)
    assert.ok(result.completedWork[0].title.includes('[REDACTED'))
    assert.ok(result.completedWork[0].filesModified![0].includes('~'))
  })

  test('redacts remainingWork titles and descriptions', () => {
    const env = baseEnvelope({
      remainingWork: [{ title: 'Email john@example.com', description: 'Fix path /Users/dev/app' }]
    })
    const result = redactEnvelope(env)
    assert.ok(result.remainingWork[0].title.includes('[REDACTED:email]'))
    assert.ok(result.remainingWork[0].description.includes('~'))
  })

  test('redacts decisions fields', () => {
    const env = baseEnvelope({
      decisions: [
        {
          what: 'Use key sk-ant-abcdefghijklmnopqrstuvwxyz1234',
          why: 'For auth',
          alternatives: ['Use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij']
        }
      ]
    })
    const result = redactEnvelope(env)
    assert.ok(result.decisions[0].what.includes('[REDACTED'))
    assert.ok(result.decisions[0].alternatives![0].includes('[REDACTED'))
  })

  test('redacts risks', () => {
    const env = baseEnvelope({
      risks: [
        {
          risk: 'Leak sk-ant-abcdefghijklmnopqrstuvwxyz1234',
          mitigation: 'Rotate key',
          severity: 'high'
        }
      ]
    })
    const result = redactEnvelope(env)
    assert.ok(result.risks[0].risk.includes('[REDACTED'))
  })

  test('redacts codeAnchors', () => {
    const env = baseEnvelope({
      codeAnchors: [{ file: '/Users/john/project/src/index.ts', title: 'Main entry', line: 1 }]
    })
    const result = redactEnvelope(env)
    assert.ok(result.codeAnchors![0].file.includes('~'))
  })

  test('redacts suggestedTools and suggestedSkills', () => {
    const env = baseEnvelope({
      suggestedTools: ['Use ANTHROPIC_API_KEY=abc123xyz'],
      suggestedSkills: ['Email admin@corp.com']
    })
    const result = redactEnvelope(env)
    assert.ok(result.suggestedTools[0].includes('[REDACTED'))
    assert.ok(result.suggestedSkills[0].includes('[REDACTED'))
  })

  test('redacts commandsToRunFirst', () => {
    const env = baseEnvelope({
      commandsToRunFirst: ['ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxx npm test']
    })
    const result = redactEnvelope(env)
    assert.ok(result.commandsToRunFirst[0].includes('[REDACTED'))
  })
})

// ── Extensions ──

describe('redactEnvelope — extensions deep redaction', () => {
  test('redacts string values in extensions', () => {
    const env = baseEnvelope({
      extensions: { note: 'Key is sk-ant-abcdefghijklmnopqrstuvwxyz1234' }
    })
    const result = redactEnvelope(env)
    const ext = result.extensions as Record<string, string>
    assert.ok(ext.note.includes('[REDACTED'))
  })

  test('redacts nested object extensions', () => {
    const env = baseEnvelope({
      extensions: { nested: { key: 'sk-ant-abcdefghijklmnopqrstuvwxyz1234' } }
    })
    const result = redactEnvelope(env)
    const ext = result.extensions as Record<string, Record<string, string>>
    assert.ok(ext.nested.key.includes('[REDACTED'))
  })

  test('redacts array extensions', () => {
    const env = baseEnvelope({
      extensions: { items: ['sk-ant-abcdefghijklmnopqrstuvwxyz1234', 'normal text'] }
    })
    const result = redactEnvelope(env)
    const ext = result.extensions as Record<string, string[]>
    assert.ok(ext.items[0].includes('[REDACTED'))
    assert.equal(ext.items[1], 'normal text')
  })

  test('preserves non-string extension values', () => {
    const env = baseEnvelope({
      extensions: { count: 42, flag: true, nothing: null }
    })
    const result = redactEnvelope(env)
    const ext = result.extensions as Record<string, unknown>
    assert.equal(ext.count, 42)
    assert.equal(ext.flag, true)
    assert.equal(ext.nothing, null)
  })

  test('handles undefined extensions gracefully', () => {
    const env = baseEnvelope({ extensions: undefined })
    const result = redactEnvelope(env)
    assert.equal(result.extensions, undefined)
  })
})

// ── No-op for clean text ──

describe('redactEnvelope — clean text passthrough', () => {
  test('clean envelope passes through unchanged', () => {
    const env = baseEnvelope({
      intent: 'Fix the authentication bug',
      originalGoal: 'Improve security',
      contextSummary: 'Working on auth module',
      constraints: ['Must be backward compatible']
    })
    const result = redactEnvelope(env)
    assert.equal(result.intent, 'Fix the authentication bug')
    assert.equal(result.originalGoal, 'Improve security')
    assert.equal(result.contextSummary, 'Working on auth module')
    assert.equal(result.constraints[0], 'Must be backward compatible')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
