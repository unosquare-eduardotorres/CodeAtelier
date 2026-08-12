/**
 * integrations.ipc.ts — the four credential handlers.
 *
 * The security property under test is one-way secrets: the renderer may write a
 * token and ask whether a field is filled, but no handler response may ever
 * carry the plaintext back. Also covers argument validation (undeclared keys are
 * dropped, not persisted) and the stored/unsaved merge used by Test Connection.
 *
 * The connection test never reaches the network here: every case is shaped so
 * `testJiraConnection` short-circuits on its missing-field guards.
 *
 * Every test body runs through `runExclusive` and seeds its own store — the
 * harness starts async tests concurrently, so the shared settings blob would
 * otherwise be clobbered mid-test.
 *
 * Run: tsx src/main/services/__tests__/ipc-integrations-handlers.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, runExclusive, summaryAsync } from './test-harness'
import {
  setupFullMock,
  getMockRepo,
  getHandlers,
  mockEvent,
  evictFromCache
} from './setup-full-mock'
import { IPC_CHANNELS } from '../../../shared/constants'
import type { IntegrationCredentialStatus } from '../../../shared/integration-credentials.types'

setupFullMock()

/** In-memory stand-in for the workspace settings_json blob. */
let settingsStore: Record<string, unknown> = {}

const repo = getMockRepo('workspace')
repo.getSettings.mockImplementation(() => ({ ...settingsStore }))
repo.updateSettings.mockImplementation((_id: string, next: Record<string, unknown>) => {
  settingsStore = { ...next }
  return undefined
})

evictFromCache('services/integration-credentials')
evictFromCache('ipc/integrations.ipc')

const { registerIntegrationsIpc } =
  require('../../ipc/integrations.ipc') as typeof import('../../ipc/integrations.ipc')

registerIntegrationsIpc()

const SAVE = IPC_CHANNELS.INTEGRATION_SAVE_CREDENTIALS
const STATUS = IPC_CHANNELS.INTEGRATION_GET_CREDENTIAL_STATUS
const CLEAR = IPC_CHANNELS.INTEGRATION_CLEAR_CREDENTIALS
const TEST = IPC_CHANNELS.INTEGRATION_TEST_CONNECTION

const WS = 'ws-1'

async function invoke(channel: string, args: unknown): Promise<any> {
  const handler = getHandlers().get(channel)
  assert.ok(handler, `no handler registered for ${channel}`)
  return handler(mockEvent, args)
}

/** Run a test body with an empty settings blob, serialized against the others. */
function isolated(fn: () => Promise<void>): () => Promise<void> {
  return () =>
    runExclusive(async () => {
      settingsStore = {}
      await fn()
    })
}

const JIRA_PAT = {
  authMode: 'pat',
  baseUrl: 'https://jira.acme.internal',
  apiToken: 'super-secret'
}

// ── Registration ──

describe('integrations.ipc — registration', () => {
  test('all four credential channels are registered', () => {
    for (const channel of [SAVE, STATUS, CLEAR, TEST]) {
      assert.ok(getHandlers().has(channel), `${channel} not registered`)
    }
  })
})

// ── Save + status ──

describe('integrations.ipc — save and status', () => {
  test(
    'save persists values and returns a secret-free status',
    isolated(async () => {
      const status: IntegrationCredentialStatus = await invoke(SAVE, {
        workspaceId: WS,
        integrationId: 'jira',
        values: JIRA_PAT
      })

      assert.equal(status.configured, true)
      assert.ok(status.filledKeys.includes('apiToken'))
      assert.equal(
        JSON.stringify(status).includes('super-secret'),
        false,
        'the plaintext token must never cross back over IPC'
      )
      assert.equal(settingsStore['jira.apiTokenEncrypted'], true)
      assert.equal(
        String(settingsStore['jira.apiToken']).includes('super-secret'),
        false,
        'the token must be encrypted at rest'
      )
    })
  )

  test(
    'status handler is equally secret-free',
    isolated(async () => {
      await invoke(SAVE, { workspaceId: WS, integrationId: 'jira', values: JIRA_PAT })

      const status: IntegrationCredentialStatus = await invoke(STATUS, {
        workspaceId: WS,
        integrationId: 'jira'
      })
      assert.equal(JSON.stringify(status).includes('super-secret'), false)
      assert.equal(status.values.baseUrl, 'https://jira.acme.internal')
      assert.equal(status.values.apiToken, undefined)
    })
  )

  test(
    'status reports the missing field for a half-filled integration',
    isolated(async () => {
      const status: IntegrationCredentialStatus = await invoke(SAVE, {
        workspaceId: WS,
        integrationId: 'jira',
        values: { authMode: 'cloud-token', baseUrl: 'https://acme.atlassian.net', apiToken: 'tok' }
      })
      assert.deepEqual(status.missingKeys, ['email'])
      assert.equal(status.configured, false)
    })
  )

  test(
    'undeclared keys are dropped rather than persisted',
    isolated(async () => {
      await invoke(SAVE, {
        workspaceId: WS,
        integrationId: 'jira',
        values: { apiToken: 'tok', evilKey: 'pwned' }
      })
      assert.equal(
        Object.keys(settingsStore).some((k) => k.includes('evilKey')),
        false
      )
    })
  )

  test('missing workspaceId is rejected', async () => {
    await assert.rejects(() => invoke(SAVE, { integrationId: 'jira', values: {} }))
  })

  test('non-object args are rejected', async () => {
    await assert.rejects(() => invoke(SAVE, 'not-an-object'))
    await assert.rejects(() => invoke(STATUS, null))
  })

  test('non-object `values` is rejected', async () => {
    await assert.rejects(() =>
      invoke(SAVE, { workspaceId: WS, integrationId: 'jira', values: ['a'] })
    )
  })

  test('non-string field value is rejected', async () => {
    await assert.rejects(() =>
      invoke(SAVE, { workspaceId: WS, integrationId: 'jira', values: { apiToken: 42 } })
    )
  })

  test('unknown integration id is rejected', async () => {
    await assert.rejects(() =>
      invoke(SAVE, { workspaceId: WS, integrationId: 'nope', values: { a: 'b' } })
    )
  })
})

// ── Clear ──

describe('integrations.ipc — clear', () => {
  test(
    'clear wipes stored values and disables the integration',
    isolated(async () => {
      await invoke(SAVE, { workspaceId: WS, integrationId: 'jira', values: JIRA_PAT })
      settingsStore.jiraAvailable = true

      const result = await invoke(CLEAR, { workspaceId: WS, integrationId: 'jira' })

      assert.deepEqual(result, { success: true })
      assert.equal(settingsStore['jira.apiToken'], undefined)
      assert.equal(
        settingsStore.jiraAvailable,
        false,
        'leaving it enabled would show an active pill for a server that never mounts'
      )
    })
  )

  test('clear validates its arguments', async () => {
    await assert.rejects(() => invoke(CLEAR, { integrationId: 'jira' }))
  })
})

// ── Test connection ──

describe('integrations.ipc — test connection', () => {
  test(
    'integrations without connection-test support are reported as such',
    isolated(async () => {
      const result = await invoke(TEST, { workspaceId: WS, integrationId: 'maestro' })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'missing-fields')
      assert.match(result.message, /does not support connection testing/)
    })
  )

  test(
    'nothing stored and nothing typed → missing fields, no network call',
    isolated(async () => {
      const result = await invoke(TEST, { workspaceId: WS, integrationId: 'jira', values: {} })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'missing-fields')
      assert.match(result.message, /URL and an API token/)
    })
  )

  test(
    'unsaved form values are used before anything is stored',
    isolated(async () => {
      const result = await invoke(TEST, {
        workspaceId: WS,
        integrationId: 'jira',
        values: { authMode: 'cloud-token', baseUrl: 'https://acme.atlassian.net', apiToken: 'tok' }
      })
      // Reached the cloud-token branch → the typed values made it into the config.
      assert.equal(result.code, 'missing-fields')
      assert.match(result.message, /email/i)
    })
  )

  test(
    'blank form fields fall back to the stored credentials',
    isolated(async () => {
      await invoke(SAVE, {
        workspaceId: WS,
        integrationId: 'jira',
        values: { authMode: 'basic', baseUrl: 'https://jira.acme.internal', apiToken: 'stored-tok' }
      })

      const result = await invoke(TEST, {
        workspaceId: WS,
        integrationId: 'jira',
        values: { apiToken: '   ' }
      })
      // Stored baseUrl + token cleared the first guard; `basic` then demands a username.
      assert.equal(result.code, 'missing-fields')
      assert.match(result.message, /username/i)
    })
  )

  test(
    'shell-provided credentials are honoured, matching the card’s “Configured” badge',
    isolated(async () => {
      // Nothing stored: the whole configuration lives in the shell, exactly the
      // state in which `getCredentialStatus` reports configured and the server
      // mounts. Test Connection must not be the one surface that disagrees.
      const shell = {
        JIRA_BASE_URL: 'https://jira.acme.internal',
        JIRA_AUTH_MODE: 'basic',
        JIRA_API_TOKEN: 'shell-tok'
      }
      for (const [k, v] of Object.entries(shell)) process.env[k] = v
      try {
        const result = await invoke(TEST, { workspaceId: WS, integrationId: 'jira', values: {} })
        // Reaching the `basic` username guard proves the shell URL + token got
        // through; before the fix this stopped at “Enter the Jira URL”.
        assert.equal(result.code, 'missing-fields')
        assert.match(result.message, /username/i)
      } finally {
        for (const k of Object.keys(shell)) delete process.env[k]
      }
    })
  )
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
