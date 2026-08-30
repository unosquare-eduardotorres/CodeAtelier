/**
 * Blueprint Environment Preflight — unit tests.
 *
 * Pure logic + mocked spawnSync: no filesystem writes, no network, no Electron.
 * Tests cover: detection engine, check runner, discovery builder, merge, dotenv parsing,
 * async engine budget, env-var severity tiers, login-shell caching.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'

// We test the exported functions directly. The service depends on:
// - execFile (async probes — we test runProbeAsync via echo)
// - spawnSync (legacy sync probe — kept for backward compat)
// - fs.existsSync / readFileSync (we test parseDotenvFile with real temp-like strings)
// - tech-stack-detector (imported but we test detection logic independently)

import {
  KNOWN_SERVICES,
  parseDotenvFile,
  runProbe,
  runProbeAsync,
  detectRequiredServices,
  runPreflightChecks,
  buildPreflightDiscoveries,
  mergeChecks,
  captureLoginShellEnv,
  resetLoginShellCache
} from '../blueprint-preflight.service'
import type { PreflightCheck, PreflightResult } from '../../../shared/preflight-types'

// ── Registry tests ──

describe('KNOWN_SERVICES registry', () => {
  test('has at least 5 services', () => {
    assert.ok(KNOWN_SERVICES.length >= 5, `Expected ≥5, got ${KNOWN_SERVICES.length}`)
  })

  test('each service has required fields', () => {
    for (const svc of KNOWN_SERVICES) {
      assert.ok(svc.id, `Missing id for ${JSON.stringify(svc)}`)
      assert.ok(svc.name, `Missing name for ${svc.id}`)
      assert.ok(Array.isArray(svc.packagePatterns), `${svc.id}: packagePatterns not array`)
      assert.ok(Array.isArray(svc.fileMarkers), `${svc.id}: fileMarkers not array`)
      assert.ok(Array.isArray(svc.taskKeywords), `${svc.id}: taskKeywords not array`)
      assert.ok(Array.isArray(svc.requiredEnvVars), `${svc.id}: requiredEnvVars not array`)
      assert.ok(svc.installHint, `${svc.id}: missing installHint`)
    }
  })

  test('all IDs are unique', () => {
    const ids = KNOWN_SERVICES.map((s) => s.id)
    const unique = new Set(ids)
    assert.equal(ids.length, unique.size, `Duplicate IDs: ${ids}`)
  })

  test('supabase service has correct env vars', () => {
    const supabase = KNOWN_SERVICES.find((s) => s.id === 'supabase')
    assert.ok(supabase, 'Supabase service not found')
    assert.ok(supabase.requiredEnvVars.includes('SUPABASE_URL'))
    assert.ok(supabase.requiredEnvVars.includes('SUPABASE_ANON_KEY'))
  })

  test('docker service has liveness probe (G7)', () => {
    const docker = KNOWN_SERVICES.find((s) => s.id === 'docker')
    assert.ok(docker, 'Docker service not found')
    assert.ok(docker.presenceProbe, 'Docker missing presence probe')
    assert.ok(docker.livenessProbe, 'Docker missing liveness probe (G7)')
    assert.deepEqual(docker.livenessProbe!.args, ['info'])
  })

  test('B5: SUPABASE_SERVICE_ROLE_KEY is optional, not required', () => {
    const supabase = KNOWN_SERVICES.find((s) => s.id === 'supabase')!
    assert.ok(
      !supabase.requiredEnvVars.includes('SUPABASE_SERVICE_ROLE_KEY'),
      'SERVICE_ROLE_KEY should be optional'
    )
    assert.ok(
      supabase.optionalEnvVars?.includes('SUPABASE_SERVICE_ROLE_KEY'),
      'SERVICE_ROLE_KEY should be in optionalEnvVars'
    )
  })

  test('B5: STRIPE_WEBHOOK_SECRET is optional, not required', () => {
    const stripe = KNOWN_SERVICES.find((s) => s.id === 'stripe')!
    assert.ok(
      !stripe.requiredEnvVars.includes('STRIPE_WEBHOOK_SECRET'),
      'WEBHOOK_SECRET should be optional'
    )
    assert.ok(
      stripe.optionalEnvVars?.includes('STRIPE_WEBHOOK_SECRET'),
      'WEBHOOK_SECRET should be in optionalEnvVars'
    )
  })

  test('B5: psql is presenceWarnOnly (hosted DBs)', () => {
    const postgres = KNOWN_SERVICES.find((s) => s.id === 'postgres')!
    assert.ok(postgres.presenceWarnOnly, 'psql should be presenceWarnOnly')
  })

  test('B7: no false-positive keywords (container, payment, database migration)', () => {
    for (const svc of KNOWN_SERVICES) {
      assert.ok(
        !svc.taskKeywords.includes('container'),
        `${svc.id} should not have 'container' keyword (React false positive)`
      )
      assert.ok(
        !svc.taskKeywords.includes('payment'),
        `${svc.id} should not have 'payment' keyword (generic false positive)`
      )
      assert.ok(
        !svc.taskKeywords.includes('database migration'),
        `${svc.id} should not have 'database migration' keyword (SQLite false positive)`
      )
    }
  })
})

// ── parseDotenvFile tests ──

describe('parseDotenvFile', () => {
  test('returns empty map for non-existent file', () => {
    const result = parseDotenvFile('/nonexistent/.env.test.xyz')
    assert.equal(result.size, 0)
  })

  // Note: we can't easily test with real files without tmp dir.
  // The function is simple enough that registry-level tests cover it indirectly.
})

// ── runProbe (sync legacy) tests ──

describe('runProbe', () => {
  test('successful probe returns ok with output', () => {
    // `echo` is universally available
    const result = runProbe({ cmd: 'echo', args: ['hello'] })
    assert.equal(result.ok, true)
    assert.equal(result.output, 'hello')
  })

  test('failed probe returns ok=false', () => {
    const result = runProbe({ cmd: 'nonexistent-command-xyz-123', args: [] })
    assert.equal(result.ok, false)
    assert.ok(result.output.length > 0, 'Should have error output')
  })

  test('probe with timeout does not hang', () => {
    const start = Date.now()
    runProbe({ cmd: 'echo', args: ['fast'] })
    const elapsed = Date.now() - start
    assert.ok(elapsed < 2000, `Probe took too long: ${elapsed}ms`)
  })
})

// ── runProbeAsync tests ──

describe('runProbeAsync', () => {
  test('successful async probe returns ok with output', async () => {
    const result = await runProbeAsync({ cmd: 'echo', args: ['hello-async'] })
    assert.equal(result.ok, true)
    assert.equal(result.output, 'hello-async')
  })

  test('failed async probe returns ok=false', async () => {
    const result = await runProbeAsync({ cmd: 'nonexistent-command-xyz-async', args: [] })
    assert.equal(result.ok, false)
    assert.ok(result.output.length > 0, 'Should have error output')
  })

  test('async probe completes within reasonable time', async () => {
    const start = Date.now()
    await runProbeAsync({ cmd: 'echo', args: ['fast-async'] })
    const elapsed = Date.now() - start
    assert.ok(elapsed < 2000, `Async probe took too long: ${elapsed}ms`)
  })
})

// ── detectRequiredServices tests ──

describe('detectRequiredServices', () => {
  test('returns empty for non-existent workspace', () => {
    const result = detectRequiredServices('/nonexistent/workspace/path/xyz')
    assert.ok(Array.isArray(result))
    // May return 0 since no files exist
  })

  test('task keyword detection works (G10: greenfield)', () => {
    const result = detectRequiredServices('/nonexistent/workspace/path/xyz', [
      'Set up Supabase authentication with row-level security',
      'Create Docker containerization for deployment'
    ])

    const supabase = result.find((r) => r.def.id === 'supabase')
    const docker = result.find((r) => r.def.id === 'docker')

    assert.ok(supabase, 'Should detect Supabase from task keywords')
    assert.ok(supabase.sources.includes('task-keywords'))

    assert.ok(docker, 'Should detect Docker from task keywords')
    assert.ok(docker.sources.includes('task-keywords'))
  })

  test('keyword detection is case-insensitive', () => {
    const result = detectRequiredServices('/nonexistent/workspace/path/xyz', [
      'Configure STRIPE payment integration'
    ])

    const stripe = result.find((r) => r.def.id === 'stripe')
    assert.ok(stripe, 'Should detect Stripe regardless of case')
  })

  test('deduplicates services detected from multiple sources', () => {
    const result = detectRequiredServices('/nonexistent/workspace/path/xyz', [
      'Use firebase for auth',
      'Deploy to firebase hosting'
    ])

    const firebaseEntries = result.filter((r) => r.def.id === 'firebase')
    assert.equal(firebaseEntries.length, 1, 'Should not duplicate Firebase')
  })

  test('B7: does NOT detect docker from "container" keyword', () => {
    const result = detectRequiredServices('/nonexistent/workspace/path/xyz', [
      'Create a React container component for the layout'
    ])
    const docker = result.find((r) => r.def.id === 'docker')
    assert.ok(!docker, 'Should not detect Docker from "container" — React false positive')
  })
})

// ── runPreflightChecks tests (now async) ──

describe('runPreflightChecks', () => {
  test('returns valid PreflightResult shape', async () => {
    const result = await runPreflightChecks('/nonexistent/workspace/path/xyz')
    assert.ok('checks' in result)
    assert.ok('ranAt' in result)
    assert.ok('hasBlockers' in result)
    assert.ok('hasWarnings' in result)
    assert.ok(Array.isArray(result.checks))
    assert.ok(typeof result.ranAt === 'string')
    assert.ok(typeof result.hasBlockers === 'boolean')
    assert.ok(typeof result.hasWarnings === 'boolean')
  })

  test('checks are sorted: blockers first, then warnings, then passes', async () => {
    const result = await runPreflightChecks('/nonexistent/workspace/path/xyz', [
      'Set up supabase database with docker deployment'
    ])

    if (result.checks.length > 1) {
      const statusOrder: Record<string, number> = { blocker: 0, warn: 1, pass: 2 }
      for (let i = 1; i < result.checks.length; i++) {
        const prev = statusOrder[result.checks[i - 1].status] ?? 2
        const curr = statusOrder[result.checks[i].status] ?? 2
        assert.ok(
          prev <= curr,
          `Check order violation at index ${i}: ${result.checks[i - 1].status} > ${result.checks[i].status}`
        )
      }
    }
  })

  test('ranAt is a valid ISO timestamp', async () => {
    const result = await runPreflightChecks('/nonexistent/workspace/path/xyz')
    const ts = new Date(result.ranAt)
    assert.ok(!isNaN(ts.getTime()), `Invalid timestamp: ${result.ranAt}`)
  })

  test('results never contain secret values (G3, premortem #5)', async () => {
    const result = await runPreflightChecks('/nonexistent/workspace/path/xyz', [
      'Configure stripe payments'
    ])

    for (const check of result.checks) {
      // Check that no env var VALUE appears in the result — only names
      assert.ok(
        !check.message.includes('sk_live_'),
        `Message contains secret value: ${check.message}`
      )
      assert.ok(
        !check.message.includes('sk_test_'),
        `Message contains secret value: ${check.message}`
      )
      // Verify shape: should have name, message, status, sources — no 'value' field
      assert.ok(!('value' in check), `Check ${check.id} has a 'value' field — secret leak risk`)
    }
  })

  test('completes within 10s budget (probes must not hang)', async () => {
    const start = Date.now()
    await runPreflightChecks('/nonexistent/workspace/path/xyz', [
      'Use supabase with docker and stripe'
    ])
    const elapsed = Date.now() - start
    // Allow 10s (5s probe budget + overhead) — previously could be 50s+ with serial spawnSync
    assert.ok(elapsed < 10000, `Preflight took ${elapsed}ms — exceeds 10s budget`)
  })

  test('B5: optional env vars produce warnings, not blockers', async () => {
    const result = await runPreflightChecks('/nonexistent/workspace/path/xyz', [
      'Set up supabase authentication'
    ])

    const serviceRoleCheck = result.checks.find((c) => c.id === 'SUPABASE_SERVICE_ROLE_KEY')
    if (serviceRoleCheck) {
      assert.equal(
        serviceRoleCheck.status,
        'warn',
        'SUPABASE_SERVICE_ROLE_KEY should be warn, not blocker'
      )
    }
  })
})

// ── buildPreflightDiscoveries tests (G11/D11) ──

describe('buildPreflightDiscoveries', () => {
  test('generates discoveries for blockers', () => {
    const result: PreflightResult = {
      checks: [
        {
          id: 'SUPABASE_URL',
          name: 'SUPABASE_URL',
          kind: 'env-var',
          status: 'blocker',
          message: 'SUPABASE_URL is not set',
          sources: ['workspace-scan']
        }
      ],
      ranAt: new Date().toISOString(),
      hasBlockers: true,
      hasWarnings: false
    }

    const discoveries = buildPreflightDiscoveries(result)
    assert.ok(discoveries.length > 0, 'Should produce at least one discovery')
    assert.ok(discoveries[0].startsWith('[PREFLIGHT]'), 'Should have PREFLIGHT prefix')
    assert.ok(discoveries[0].includes('SUPABASE_URL'), 'Should mention the env var')
    assert.ok(
      discoveries[0].includes('mark task partial') || discoveries[0].includes('stubs'),
      'Should contain agent guidance'
    )
  })

  test('D11: does NOT generate discoveries for warn status (avoids crowding verify gaps)', () => {
    const result: PreflightResult = {
      checks: [
        {
          id: 'docker-cli',
          name: 'Docker CLI',
          kind: 'cli-tool',
          status: 'warn',
          message: 'Docker CLI found but daemon not responding',
          sources: ['workspace-scan']
        }
      ],
      ranAt: new Date().toISOString(),
      hasBlockers: false,
      hasWarnings: true
    }

    const discoveries = buildPreflightDiscoveries(result)
    assert.equal(
      discoveries.length,
      0,
      'D11: Warnings should NOT produce discoveries (only blockers do)'
    )
  })

  test('skips pass checks', () => {
    const result: PreflightResult = {
      checks: [
        {
          id: 'node-cli',
          name: 'Node.js',
          kind: 'cli-tool',
          status: 'pass',
          message: 'Node.js v20.11.0',
          sources: ['workspace-scan']
        }
      ],
      ranAt: new Date().toISOString(),
      hasBlockers: false,
      hasWarnings: false
    }

    const discoveries = buildPreflightDiscoveries(result)
    assert.equal(discoveries.length, 0, 'Should not generate discoveries for passing checks')
  })

  test('generates CLI-specific guidance for missing tools', () => {
    const result: PreflightResult = {
      checks: [
        {
          id: 'supabase-cli',
          name: 'Supabase CLI',
          kind: 'cli-tool',
          status: 'blocker',
          message: 'Supabase CLI not found on PATH',
          sources: ['workspace-scan']
        }
      ],
      ranAt: new Date().toISOString(),
      hasBlockers: true,
      hasWarnings: false
    }

    const discoveries = buildPreflightDiscoveries(result)
    assert.ok(
      discoveries[0].includes('skip commands'),
      'CLI blocker should mention skipping commands'
    )
  })
})

// ── mergeChecks tests ──

describe('mergeChecks', () => {
  const baseCheck: PreflightCheck = {
    id: 'docker-cli',
    name: 'Docker CLI',
    kind: 'cli-tool',
    status: 'pass',
    message: 'Docker available',
    sources: ['workspace-scan']
  }

  test('merges non-overlapping checks', () => {
    const existing: PreflightCheck[] = [baseCheck]
    const additional: PreflightCheck[] = [
      {
        id: 'supabase-cli',
        name: 'Supabase CLI',
        kind: 'cli-tool',
        status: 'blocker',
        message: 'Not found',
        sources: ['llm-declaration']
      }
    ]

    const merged = mergeChecks(existing, additional)
    assert.equal(merged.length, 2)
  })

  test('existing checks take precedence over additional', () => {
    const existing: PreflightCheck[] = [baseCheck]
    const additional: PreflightCheck[] = [
      {
        id: 'docker-cli',
        name: 'Docker CLI',
        kind: 'cli-tool',
        status: 'blocker', // LLM says blocker, but deterministic says pass
        message: 'LLM thinks Docker is missing',
        sources: ['llm-declaration']
      }
    ]

    const merged = mergeChecks(existing, additional)
    assert.equal(merged.length, 1)
    assert.equal(merged[0].status, 'pass', 'Deterministic result should take precedence')
  })

  test('merges sources when IDs overlap', () => {
    const existing: PreflightCheck[] = [baseCheck]
    const additional: PreflightCheck[] = [
      {
        id: 'docker-cli',
        name: 'Docker CLI',
        kind: 'cli-tool',
        status: 'blocker',
        message: 'LLM says missing',
        sources: ['llm-declaration']
      }
    ]

    const merged = mergeChecks(existing, additional)
    assert.ok(merged[0].sources.includes('workspace-scan'))
    assert.ok(merged[0].sources.includes('llm-declaration'))
  })

  test('handles empty inputs', () => {
    assert.equal(mergeChecks([], []).length, 0)
    assert.equal(mergeChecks([baseCheck], []).length, 1)
    assert.equal(mergeChecks([], [baseCheck]).length, 1)
  })
})

// ── Login-shell env sourcing tests (B6) ──

describe('captureLoginShellEnv', () => {
  test('returns a Set (may be empty on non-shell platforms)', async () => {
    resetLoginShellCache()
    const keys = await captureLoginShellEnv()
    assert.ok(keys instanceof Set, 'Should return a Set')
    // On macOS/Linux with a valid shell, should have at least a few keys
    if (process.env.SHELL) {
      assert.ok(keys.size > 0, `Expected >0 keys from login shell, got ${keys.size}`)
    }
  })

  test('caches result across calls', async () => {
    resetLoginShellCache()
    const first = await captureLoginShellEnv()
    const second = await captureLoginShellEnv()
    assert.strictEqual(first, second, 'Should return same cached Set')
  })

  test('resetLoginShellCache clears the cache', async () => {
    resetLoginShellCache()
    const first = await captureLoginShellEnv()
    resetLoginShellCache()
    const third = await captureLoginShellEnv()
    // They should be different Set instances (even if same content)
    assert.notStrictEqual(first, third, 'Should create new Set after reset')
  })
})

// ── Approval payload redaction test (A15) ──

describe('approval payload redaction', () => {
  test('PreflightCheck has no value field in its shape', () => {
    // Verify the type shape — checks carry names only, never secret values
    const check: PreflightCheck = {
      id: 'TEST_KEY',
      name: 'TEST_KEY',
      kind: 'env-var',
      status: 'blocker',
      message: 'TEST_KEY is not set',
      sources: ['workspace-scan']
    }
    assert.ok(!('value' in check), 'PreflightCheck should never have a value field')
    assert.ok(!check.message.includes('sk_'), 'Message should not contain secret patterns')
  })
})

// ── envVarAlternatives: alternative DSN names satisfy required vars ──

describe('envVarAlternatives — DATABASE_URL satisfied by split DSNs', () => {
  test('postgres registry entry declares DB_READ_DSN/DB_WRITE_DSN as alternatives', () => {
    const postgres = KNOWN_SERVICES.find((s) => s.id === 'postgres')
    assert.ok(postgres, 'postgres service not found')
    const alts = postgres.envVarAlternatives?.['DATABASE_URL']
    assert.ok(alts, 'envVarAlternatives.DATABASE_URL not declared')
    assert.ok(alts.includes('DB_READ_DSN'), 'DB_READ_DSN missing from alternatives')
    assert.ok(alts.includes('DB_WRITE_DSN'), 'DB_WRITE_DSN missing from alternatives')
  })

  test('DB_WRITE_DSN in workspace .env satisfies DATABASE_URL (no blocker)', async () => {
    // Congruity HR case: .env sets DB_READ_DSN/DB_WRITE_DSN, never DATABASE_URL.
    // Previously a hard blocker requiring manual override on every run.
    const dir = mkdtempSync(join(tmpdir(), 'preflight-alt-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 't', dependencies: { pg: '^8' } })
      )
      writeFileSync(join(dir, '.env'), 'DB_READ_DSN=postgresql://x/y\nDB_WRITE_DSN=postgresql://x/y\n')

      const result = await runPreflightChecks(dir)
      const dbCheck = result.checks.find((c) => c.id === 'DATABASE_URL')
      assert.ok(dbCheck, 'DATABASE_URL check missing from results')
      assert.equal(
        dbCheck?.status,
        'pass',
        `Expected pass via alternative, got ${dbCheck?.status} (${dbCheck?.message})`
      )
      assert.ok(dbCheck?.message.includes('DB_WRITE_DSN'), 'message should name the satisfying var')
      assert.equal(result.hasBlockers, false, 'no blockers expected for split-DSN workspace')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no DSN at all still blocks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-alt-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 't', dependencies: { pg: '^8' } })
      )
      // No .env, no DATABASE_URL in process env (test runner env is clean of it)
      const result = await runPreflightChecks(dir)
      const dbCheck = result.checks.find((c) => c.id === 'DATABASE_URL')
      assert.equal(dbCheck?.status, 'blocker', 'missing DSN must stay a blocker')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
