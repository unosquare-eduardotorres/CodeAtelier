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
  resetLoginShellCache,
  resolveConnectivityTarget,
  probeTcpAsync
} from '../blueprint-preflight.service'
import {
  parseDsnTarget,
  verificationDepthPreflightCheck,
  type PreflightCheck,
  type PreflightResult,
  type PreflightServiceDef
} from '../../../shared/preflight-types'
import { createServer } from 'node:net'

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
    // Budget is "did not hang", not "fast": in the shared runner this test
    // competes with hundreds of concurrently-draining async tests for the
    // event loop, and a 2s budget flaked at 2.6s under load.
    assert.ok(elapsed < 10_000, `Async probe took too long: ${elapsed}ms`)
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

// ── G2: infrastructure reachability ──

describe('parseDsnTarget', () => {
  test('strips_credentials_from_a_full_dsn', () => {
    // The whole reason this returns a struct instead of a string: the password
    // must be gone before anything downstream can put the value in a message.
    const t = parseDsnTarget('postgresql://admin:hunter2@db.internal:6543/app', 5432)
    assert.deepEqual(t, { host: 'db.internal', port: 6543 })
    assert.ok(!JSON.stringify(t).includes('hunter2'), 'no credential may survive parsing')
    assert.ok(!JSON.stringify(t).includes('admin'))
  })

  test('falls_back_to_the_default_port', () => {
    assert.deepEqual(parseDsnTarget('postgres://user@db.internal/app', 5432), {
      host: 'db.internal',
      port: 5432
    })
  })

  test('accepts_a_bare_host_port', () => {
    // REDIS_URL=cache.internal:6379 is a shape people really write.
    assert.deepEqual(parseDsnTarget('cache.internal:6379', 6379), {
      host: 'cache.internal',
      port: 6379
    })
  })

  test('accepts_a_bare_host', () => {
    assert.deepEqual(parseDsnTarget('cache.internal', 6379), { host: 'cache.internal', port: 6379 })
  })

  test('drops_credentials_from_a_schemeless_dsn', () => {
    const t = parseDsnTarget('user:hunter2@db.internal:3306', 3306)
    assert.deepEqual(t, { host: 'db.internal', port: 3306 })
    assert.ok(!JSON.stringify(t).includes('hunter2'))
  })

  test('mongodb_srv_is_never_probed', () => {
    // The real hosts come from a DNS SRV lookup, so probing the seed name on
    // 27017 would report an outage that does not exist.
    assert.equal(parseDsnTarget('mongodb+srv://u:p@cluster0.abcd.mongodb.net/app', 27017), null)
  })

  test('ipv6_literals_keep_their_host', () => {
    assert.deepEqual(parseDsnTarget('postgres://[::1]:5433/app', 5432), { host: '::1', port: 5433 })
  })

  test('unusable_values_yield_null_rather_than_throwing', () => {
    // An unparseable connection string is a reason to skip the probe, not to
    // fail preflight.
    for (const bad of [
      '',
      '   ',
      'postgres://:99999/app',
      'host:0',
      'host:not-a-port',
      // Prose is not a hostname. Without this guard the bare-host branch would
      // accept it and report the resulting DNS failure as an outage.
      'not a dsn at all!!',
      'TODO: set me'
    ]) {
      assert.equal(parseDsnTarget(bad, 5432), null, `expected null for ${JSON.stringify(bad)}`)
    }
  })

  test('a_unix_socket_path_is_skipped', () => {
    assert.equal(parseDsnTarget('postgres:///var/run/postgresql', 5432), null)
  })
})

describe('resolveConnectivityTarget', () => {
  const def = KNOWN_SERVICES.find((s) => s.id === 'postgres') as PreflightServiceDef

  test('postgres_redis_mongo_and_mysql_all_declare_a_probe', () => {
    for (const id of ['postgres', 'redis', 'mongodb', 'mysql']) {
      const svc = KNOWN_SERVICES.find((s) => s.id === id)
      assert.ok(svc, `${id} missing from the registry`)
      assert.ok(svc.connectivityProbe, `${id} has no connectivity probe`)
      assert.ok(svc.connectivityProbe.defaultPort > 0)
    }
  })

  test('uses_the_first_declared_var_that_parses', () => {
    const resolved = resolveConnectivityTarget(
      def,
      new Map([
        ['DATABASE_URL', 'postgres://u:p@primary.internal:5432/app'],
        ['DB_READ_DSN', 'postgres://u:p@replica.internal:5432/app']
      ])
    )
    assert.equal(resolved?.envVar, 'DATABASE_URL')
    assert.equal(resolved?.target.host, 'primary.internal')
  })

  test('skips_a_var_whose_value_cannot_be_parsed', () => {
    const resolved = resolveConnectivityTarget(
      def,
      new Map([
        ['DATABASE_URL', 'not a dsn at all!!'],
        ['DB_WRITE_DSN', 'postgres://u:p@fallback.internal:5432/app']
      ])
    )
    assert.equal(
      resolved?.envVar,
      'DB_WRITE_DSN',
      'an unusable first value must not end the search'
    )
  })

  test('no_dsn_means_no_probe', () => {
    assert.equal(resolveConnectivityTarget(def, new Map()), null)
  })

  test('a_service_without_a_probe_declaration_is_never_probed', () => {
    const stripe = KNOWN_SERVICES.find((s) => s.id === 'stripe') as PreflightServiceDef
    assert.equal(resolveConnectivityTarget(stripe, new Map([['DATABASE_URL', 'x:1']])), null)
  })
})

describe('probeTcpAsync', () => {
  test('a_listening_port_is_reachable', async () => {
    const server = createServer()
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port)
      })
    })
    try {
      const result = await probeTcpAsync({ host: '127.0.0.1', port })
      assert.equal(result.reachable, true)
    } finally {
      server.close()
    }
  })

  test('a_closed_port_is_unreachable_and_names_the_reason', async () => {
    // Bind then immediately release, so the port is almost certainly free.
    const server = createServer()
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port)
      })
    })
    await new Promise<void>((resolve) => server.close(() => resolve()))

    const result = await probeTcpAsync({ host: '127.0.0.1', port })
    assert.equal(result.reachable, false)
    assert.ok(result.error, 'a failure must say why')
  })

  test('an_unroutable_host_settles_within_its_own_timeout', async () => {
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): guaranteed non-routable, so the SYN
    // is dropped rather than refused. Without the explicit cap this would hang
    // for the OS default of over a minute.
    const started = Date.now()
    const result = await probeTcpAsync({ host: '192.0.2.1', port: 5432 }, 300)
    const elapsed = Date.now() - started

    assert.equal(result.reachable, false)
    assert.ok(elapsed < 3000, `probe took ${elapsed}ms — the timeout did not hold`)
  })

  test('an_unresolvable_hostname_is_unreachable_not_a_throw', async () => {
    const result = await probeTcpAsync(
      { host: 'preflight-nonexistent-host.invalid', port: 5432 },
      1000
    )
    assert.equal(result.reachable, false)
  })
})

describe('connectivity verdicts stay warnings', () => {
  test('a_dead_database_warns_and_never_blocks', async () => {
    // The doctrine this pins: a service may legitimately be provisioned during
    // BUILD, so an unreachable host is information, not a veto.
    const dir = mkdtempSync(join(tmpdir(), 'preflight-conn-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 't', dependencies: { pg: '^8' } })
      )
      writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://u:p@192.0.2.1:5432/app\n')

      const result = await runPreflightChecks(dir)
      const conn = result.checks.find((c) => c.id === 'postgres-reachable')
      assert.ok(conn, 'a declared DSN must produce a reachability check')
      assert.equal(conn.status, 'warn', 'connectivity failure is never a blocker')
      assert.equal(conn.kind, 'service')
      assert.ok(conn.message.includes('192.0.2.1:5432'), 'the message must name the target')
      assert.ok(!conn.message.includes('hunter'), 'sanity: no credential text')
      assert.ok(!conn.message.includes(':p@'), 'credentials must never reach the message')
      assert.equal(result.hasBlockers, false, 'a dead host alone must not block the gate')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no_dsn_means_no_reachability_check_at_all', async () => {
    // Fabricating "unreachable" for a workspace that never named a host would be
    // noise, not evidence.
    const dir = mkdtempSync(join(tmpdir(), 'preflight-noconn-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 't', dependencies: { pg: '^8' } })
      )
      const result = await runPreflightChecks(dir)
      assert.equal(
        result.checks.find((c) => c.id === 'postgres-reachable'),
        undefined
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the_whole_phase_stays_inside_its_budget_with_dead_hosts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-budget-'))
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 't', dependencies: { pg: '^8', ioredis: '^5', mongoose: '^8' } })
      )
      writeFileSync(
        join(dir, '.env'),
        'DATABASE_URL=postgres://192.0.2.1:5432/app\n' +
          'REDIS_URL=redis://192.0.2.2:6379\n' +
          'MONGODB_URI=mongodb://192.0.2.3:27017/app\n'
      )

      const started = Date.now()
      await runPreflightChecks(dir)
      const elapsed = Date.now() - started

      // Three black-hole hosts probed in parallel, not in series.
      assert.ok(elapsed < 15000, `preflight took ${elapsed}ms with three dead hosts`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── G1: verification-depth readiness ──

describe('verificationDepthPreflightCheck', () => {
  test('e2e_depth_without_an_e2e_command_is_a_blocker', () => {
    // The user asked for the strongest proof and the pipeline has no way to
    // produce ANY. `blocker` re-labels Approve as "Build Anyway" — loud at the
    // last human decision point, but still not a hard stop.
    const check = verificationDepthPreflightCheck('e2e', { smoke: true, e2e: false })
    assert.equal(check?.id, 'verification-depth-e2e')
    assert.equal(check?.status, 'blocker')
    assert.ok(check?.remediation, 'a blocker without a next step is just an obstacle')
  })

  test('missing_smoke_command_stays_a_warning', () => {
    // The stronger e2e gate may still exercise the boot path, so this one is not
    // fully known here the way the e2e case is.
    const check = verificationDepthPreflightCheck('integration', { smoke: false, e2e: false })
    assert.equal(check?.id, 'verification-depth-smoke')
    assert.equal(check?.status, 'warn')
  })

  test('e2e_gap_outranks_the_smoke_gap', () => {
    const check = verificationDepthPreflightCheck('e2e', { smoke: false, e2e: false })
    assert.equal(check?.id, 'verification-depth-e2e', 'report the strongest missing proof first')
  })

  test('standard_depth_never_complains', () => {
    assert.equal(verificationDepthPreflightCheck('standard', { smoke: false, e2e: false }), null)
  })

  test('satisfied_depth_produces_no_check', () => {
    assert.equal(verificationDepthPreflightCheck('e2e', { smoke: true, e2e: true }), null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
