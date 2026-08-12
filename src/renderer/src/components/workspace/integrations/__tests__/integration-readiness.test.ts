/**
 * integration-readiness — the single status the collapsed integration row shows.
 *
 * Two rules here are load-bearing. `checking` must win over `setup-required`
 * while a probe is still in flight: the card paints before the CLI check and
 * the credential-status IPC resolve, and flashing "Setup required" at a user
 * whose integration is already configured is what made the old three-badge
 * status row untrustworthy. And `isToggleBlocked` must stay narrower than the
 * displayed readiness — locking an already-enabled integration would leave no
 * way to turn it back off.
 *
 * Run: tsx src/renderer/src/components/workspace/integrations/__tests__/integration-readiness.test.ts
 */
import assert from 'node:assert/strict'
import {
  test,
  describe,
  summaryAsync
} from '../../../../../../main/services/__tests__/test-harness'
import { deriveReadiness, isToggleBlocked, READINESS_META } from '../integration-readiness'
import type { ReadinessInput } from '../integration-readiness'
import type { IntegrationCredentialStatus } from '../../../../../../shared/integration-credentials.types'

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Maestro-shaped: resolved from PATH, no credential form. */
const cliIntegration = { bundledServerEntry: undefined, credentialFields: undefined }

/** Jira-shaped: bundled server, credential form. */
const bundledWithCreds = {
  bundledServerEntry: 'jira-server',
  credentialFields: [
    { key: 'apiToken', label: 'Token', type: 'password' as const, envVar: 'JIRA_API_TOKEN' }
  ]
}

const UNCHECKED = { checked: false, found: false }
const FOUND = { checked: true, found: true, path: '/usr/local/bin/maestro' }
const MISSING = { checked: true, found: false }

const status = (configured: boolean): IntegrationCredentialStatus => ({
  configured,
  filledKeys: configured ? ['apiToken'] : [],
  values: {},
  missingKeys: configured ? [] : ['apiToken']
})

const readiness = (over: Partial<ReadinessInput>): ReturnType<typeof deriveReadiness> =>
  deriveReadiness({
    integration: cliIntegration,
    cliStatus: FOUND,
    workspaceId: 'ws-1',
    ...over
  })

// ── deriveReadiness ─────────────────────────────────────────────────────────

describe('deriveReadiness › CLI-backed integrations', () => {
  test('reports checking until the PATH probe resolves', () => {
    assert.equal(readiness({ cliStatus: UNCHECKED }), 'checking')
  })

  test('reports cli-missing when the command is not on PATH', () => {
    assert.equal(readiness({ cliStatus: MISSING }), 'cli-missing')
  })

  test('reports ready once the CLI is found', () => {
    assert.equal(readiness({ cliStatus: FOUND }), 'ready')
  })

  test('needs no workspace when there are no credentials to store', () => {
    assert.equal(readiness({ workspaceId: null }), 'ready')
  })
})

describe('deriveReadiness › bundled integrations', () => {
  test('never waits on a PATH probe — nothing to look up', () => {
    assert.equal(
      deriveReadiness({
        integration: { bundledServerEntry: 'jira-server', credentialFields: undefined },
        cliStatus: UNCHECKED,
        workspaceId: 'ws-1'
      }),
      'ready'
    )
  })

  test('ignores a missing CLI entirely', () => {
    assert.equal(
      deriveReadiness({
        integration: { bundledServerEntry: 'jira-server', credentialFields: undefined },
        cliStatus: MISSING,
        workspaceId: 'ws-1'
      }),
      'ready'
    )
  })
})

describe('deriveReadiness › credential gating', () => {
  const base = { integration: bundledWithCreds, cliStatus: UNCHECKED }

  test('reports checking while the credential status is still loading', () => {
    assert.equal(deriveReadiness({ ...base, workspaceId: 'ws-1' }), 'checking')
  })

  test('reports setup-required once the status says unconfigured', () => {
    assert.equal(
      deriveReadiness({ ...base, workspaceId: 'ws-1', credentialStatus: status(false) }),
      'setup-required'
    )
  })

  test('reports ready once credentials are configured', () => {
    assert.equal(
      deriveReadiness({ ...base, workspaceId: 'ws-1', credentialStatus: status(true) }),
      'ready'
    )
  })

  test('reports setup-required with no workspace, without waiting on a status', () => {
    assert.equal(deriveReadiness({ ...base, workspaceId: null }), 'setup-required')
  })
})

describe('deriveReadiness › precedence', () => {
  test('a missing CLI outranks missing credentials — the form would not help', () => {
    assert.equal(
      deriveReadiness({
        integration: {
          bundledServerEntry: undefined,
          credentialFields: bundledWithCreds.credentialFields
        },
        cliStatus: MISSING,
        workspaceId: 'ws-1',
        credentialStatus: status(false)
      }),
      'cli-missing'
    )
  })
})

// ── isToggleBlocked ─────────────────────────────────────────────────────────

describe('isToggleBlocked', () => {
  test('never blocks an integration that needs no credentials', () => {
    assert.equal(
      isToggleBlocked({
        integration: cliIntegration,
        workspaceId: null,
        available: false
      }),
      false
    )
  })

  test('blocks when credentials are required and no workspace is open', () => {
    assert.equal(
      isToggleBlocked({ integration: bundledWithCreds, workspaceId: null, available: false }),
      true
    )
  })

  test('does not block on first paint, before the status has loaded', () => {
    assert.equal(
      isToggleBlocked({ integration: bundledWithCreds, workspaceId: 'ws-1', available: false }),
      false
    )
  })

  test('blocks once the status confirms credentials are unset', () => {
    assert.equal(
      isToggleBlocked({
        integration: bundledWithCreds,
        workspaceId: 'ws-1',
        credentialStatus: status(false),
        available: false
      }),
      true
    )
  })

  test('does not block when credentials are configured', () => {
    assert.equal(
      isToggleBlocked({
        integration: bundledWithCreds,
        workspaceId: 'ws-1',
        credentialStatus: status(true),
        available: false
      }),
      false
    )
  })

  test('never traps an already-enabled integration, even with credentials cleared', () => {
    assert.equal(
      isToggleBlocked({
        integration: bundledWithCreds,
        workspaceId: 'ws-1',
        credentialStatus: status(false),
        available: true
      }),
      false
    )
  })
})

// ── Presentation contract ───────────────────────────────────────────────────

describe('READINESS_META', () => {
  test('every readiness value has a label and tone', () => {
    for (const key of ['ready', 'setup-required', 'cli-missing', 'checking'] as const) {
      assert.ok(READINESS_META[key].label.length > 0, `${key} has a label`)
      assert.ok(READINESS_META[key].tone.length > 0, `${key} has a tone`)
    }
  })

  test('only `ready` is a success tone — the rest must draw attention or stay neutral', () => {
    assert.equal(READINESS_META.ready.tone, 'success')
    assert.equal(READINESS_META['setup-required'].tone, 'warning')
    assert.equal(READINESS_META['cli-missing'].tone, 'warning')
    assert.equal(READINESS_META.checking.tone, 'neutral')
  })
})

// ── Standalone runner ─────────────────────────────────────────────
// summaryAsync calls process.exit — unguarded it kills the whole suite when
// this file is imported by a runner, taking every later test file with it.
if (process.argv[1]?.includes('integration-readiness')) {
  void summaryAsync()
}
