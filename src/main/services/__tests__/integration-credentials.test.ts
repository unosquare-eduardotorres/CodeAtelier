/**
 * Integration credential plumbing — settings-key derivation, conditional-field
 * validation, and env resolution for external MCP integrations.
 *
 * Covers the registry-derived pure helpers, the encrypted round-trip through
 * the workspace settings blob, and the env resolution used by every MCP mount
 * point (including the process.env fallback that preserves the pre-existing
 * Maestro behaviour).
 *
 * Run: tsx src/main/services/__tests__/integration-credentials.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, beforeEach, summaryAsync } from './test-harness'
import { setupFullMock, getMockRepo, evictFromCache } from './setup-full-mock'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../../shared/constants'
import type { CredentialFieldDef } from '../../../shared/integration-credentials.types'
import {
  settingsKeyFor,
  listSecretSettingsKeys,
  isFieldVisible,
  missingRequiredFields
} from '../../../shared/integration-credentials.types'

setupFullMock()

/** In-memory stand-in for the workspace settings_json blob. */
let settingsStore: Record<string, unknown> = {}

function wireSettingsStore(): void {
  const repo = getMockRepo('workspace')
  repo.getSettings.mockImplementation(() => ({ ...settingsStore }))
  repo.updateSettings.mockImplementation((_id: string, next: Record<string, unknown>) => {
    settingsStore = { ...next }
    return undefined
  })
}

const jira = EXTERNAL_MCP_INTEGRATIONS.find((i) => i.id === 'jira')!
const maestro = EXTERNAL_MCP_INTEGRATIONS.find((i) => i.id === 'maestro')!

// ── Settings key derivation ──

describe('integration-credentials — settings keys', () => {
  test('key is namespaced by integration id', () => {
    assert.equal(settingsKeyFor('jira', 'apiToken'), 'jira.apiToken')
  })

  test('secret keys are derived from the registry, not hardcoded', () => {
    const keys = listSecretSettingsKeys()
    assert.ok(keys.includes('jira.apiToken'), 'jira secret must be listed')
    assert.equal(keys.includes('jira.baseUrl'), false, 'non-secret fields must not be listed')
    assert.equal(keys.includes('jira.email'), false)
  })

  test('every declared secret field appears exactly once', () => {
    const keys = listSecretSettingsKeys()
    assert.equal(new Set(keys).size, keys.length)
    const declared = EXTERNAL_MCP_INTEGRATIONS.flatMap((i) =>
      (i.credentialFields ?? []).filter((f) => f.secret)
    )
    assert.equal(keys.length, declared.length)
  })
})

// ── Conditional visibility ──

describe('integration-credentials — isFieldVisible', () => {
  const emailField = jira.credentialFields!.find((f) => f.key === 'email')!
  const usernameField = jira.credentialFields!.find((f) => f.key === 'username')!
  const tokenField = jira.credentialFields!.find((f) => f.key === 'apiToken')!

  test('field without showWhen is always visible', () => {
    assert.equal(isFieldVisible(tokenField, {}), true)
  })

  test('email only shows for cloud-token', () => {
    assert.equal(isFieldVisible(emailField, { authMode: 'cloud-token' }), true)
    assert.equal(isFieldVisible(emailField, { authMode: 'pat' }), false)
    assert.equal(isFieldVisible(emailField, {}), false, 'unset discriminator hides the field')
  })

  test('username only shows for basic', () => {
    assert.equal(isFieldVisible(usernameField, { authMode: 'basic' }), true)
    assert.equal(isFieldVisible(usernameField, { authMode: 'cloud-token' }), false)
  })

  test('multi-condition showWhen requires every condition to match', () => {
    const field: CredentialFieldDef = {
      key: 'x',
      label: 'X',
      type: 'text',
      envVar: 'X',
      showWhen: { authMode: ['pat'], region: ['eu'] }
    }
    assert.equal(isFieldVisible(field, { authMode: 'pat', region: 'eu' }), true)
    assert.equal(isFieldVisible(field, { authMode: 'pat', region: 'us' }), false)
  })
})

// ── Required-field validation ──

describe('integration-credentials — missingRequiredFields', () => {
  const fields = jira.credentialFields!

  test('empty values → every visible required field is missing', () => {
    const missing = missingRequiredFields(fields, {})
    assert.deepEqual(missing.sort(), ['apiToken', 'authMode', 'baseUrl'])
    assert.equal(missing.includes('email'), false, 'hidden fields must not be required')
  })

  test('cloud-token requires email but not username', () => {
    const missing = missingRequiredFields(fields, {
      authMode: 'cloud-token',
      baseUrl: 'https://acme.atlassian.net',
      apiToken: 'tok'
    })
    assert.deepEqual(missing, ['email'])
  })

  test('pat mode needs neither email nor username', () => {
    const missing = missingRequiredFields(fields, {
      authMode: 'pat',
      baseUrl: 'https://jira.acme.internal',
      apiToken: 'tok'
    })
    assert.deepEqual(missing, [])
  })

  test('basic mode requires username', () => {
    const missing = missingRequiredFields(fields, {
      authMode: 'basic',
      baseUrl: 'https://jira.acme.internal',
      apiToken: 'tok'
    })
    assert.deepEqual(missing, ['username'])
  })

  test('integrations without credential fields are never blocked', () => {
    assert.deepEqual(missingRequiredFields(maestro.credentialFields, {}), [])
    assert.deepEqual(missingRequiredFields(undefined, {}), [])
  })
})

// ── Env resolution ──

type CredModule = typeof import('../integration-credentials')
// An earlier file in the shared run may have cached this module bound to the
// real repositories; evict it so it re-binds to the mock loader.
evictFromCache('services/integration-credentials')

const credentials: CredModule = require('../integration-credentials')
const {
  resolveIntegrationEnv,
  missingCredentials,
  resolveActiveIntegrationEnvs,
  saveIntegrationCredentials,
  clearIntegrationCredentials,
  getCredentialStatus,
  readCredentialValues
} = credentials

const WS = 'ws-1'

// ── Storage round-trip ──

describe('integration-credentials — storage', () => {
  beforeEach(wireSettingsStore)

  test('secrets are encrypted at rest with a companion flag', () => {
    settingsStore = {}
    saveIntegrationCredentials(WS, 'jira', {
      authMode: 'pat',
      baseUrl: 'https://jira.acme.internal',
      apiToken: 'super-secret'
    })

    assert.equal(settingsStore['jira.baseUrl'], 'https://jira.acme.internal')
    assert.equal(settingsStore['jira.apiTokenEncrypted'], true)
    assert.notEqual(settingsStore['jira.apiToken'], 'super-secret')
    assert.equal(
      String(settingsStore['jira.apiToken']).includes('super-secret'),
      false,
      'plaintext token must never be stored'
    )
  })

  test('stored secrets decrypt back to plaintext for the main process', () => {
    const values = readCredentialValues(WS, jira)
    assert.equal(values.apiToken, 'super-secret')
    assert.equal(values.authMode, 'pat')
  })

  test('blank secret on re-save leaves the stored value untouched', () => {
    saveIntegrationCredentials(WS, 'jira', { baseUrl: 'https://jira2.acme.internal', apiToken: '' })
    const values = readCredentialValues(WS, jira)
    assert.equal(values.apiToken, 'super-secret', 'blank means "leave unchanged"')
    assert.equal(values.baseUrl, 'https://jira2.acme.internal')
  })

  test('replacing a secret re-encrypts rather than double-encrypting', () => {
    saveIntegrationCredentials(WS, 'jira', { apiToken: 'rotated' })
    assert.equal(readCredentialValues(WS, jira).apiToken, 'rotated')
  })

  test('getCredentialStatus never returns secret values', () => {
    const status = getCredentialStatus(WS, 'jira')
    assert.equal(status.configured, true)
    assert.ok(status.filledKeys.includes('apiToken'))
    assert.equal(status.values.apiToken, undefined, 'secret must be omitted')
    assert.equal(status.values.baseUrl, 'https://jira2.acme.internal')
    assert.equal(
      JSON.stringify(status).includes('rotated'),
      false,
      'no secret may appear anywhere in the renderer payload'
    )
  })

  test('status reports the missing field when a required value is absent', () => {
    settingsStore = {}
    saveIntegrationCredentials(WS, 'jira', {
      authMode: 'cloud-token',
      baseUrl: 'https://acme.atlassian.net',
      apiToken: 'tok'
    })
    const status = getCredentialStatus(WS, 'jira')
    assert.deepEqual(status.missingKeys, ['email'])
    assert.equal(status.configured, false)
  })

  test('clear removes both the value and its encrypted flag', () => {
    clearIntegrationCredentials(WS, 'jira')
    assert.equal(settingsStore['jira.apiToken'], undefined)
    assert.equal(settingsStore['jira.apiTokenEncrypted'], undefined)
    assert.deepEqual(readCredentialValues(WS, jira), {})
  })

  test('clear also disables the integration for the workspace', () => {
    settingsStore = { jiraAvailable: true }
    saveIntegrationCredentials(WS, 'jira', {
      authMode: 'pat',
      baseUrl: 'https://jira.acme.internal',
      apiToken: 'tok'
    })
    clearIntegrationCredentials(WS, 'jira')
    assert.equal(
      settingsStore.jiraAvailable,
      false,
      'an enabled integration with no credentials is a silent no-op at mount time'
    )
  })
})

// ── Shell-environment configuration ──

describe('integration-credentials — shell env satisfies the gate', () => {
  beforeEach(wireSettingsStore)

  /** Set JIRA_* in the shell for the duration of `fn`. */
  function withShellEnv(vars: Record<string, string>, fn: () => void): void {
    for (const [k, v] of Object.entries(vars)) process.env[k] = v
    try {
      fn()
    } finally {
      for (const k of Object.keys(vars)) delete process.env[k]
    }
  }

  test('fully shell-configured jira passes the mount gate with no workspace', () => {
    withShellEnv(
      {
        JIRA_BASE_URL: 'https://jira.acme.internal',
        JIRA_AUTH_MODE: 'pat',
        JIRA_API_TOKEN: 'shell-tok'
      },
      () => {
        assert.deepEqual(missingCredentials(jira, null), [])
        const envs = resolveActiveIntegrationEnvs({ jira: true }, null)
        assert.ok(envs.jira, 'the mount gate must honour the shell fallback it implements')
        assert.equal(envs.jira.JIRA_API_TOKEN, 'shell-tok')
      }
    )
  })

  test('shell-provided authMode keeps its dependent field visible', () => {
    withShellEnv(
      {
        JIRA_BASE_URL: 'https://acme.atlassian.net',
        JIRA_AUTH_MODE: 'cloud-token',
        JIRA_EMAIL: 'jane@acme.com',
        JIRA_API_TOKEN: 'shell-tok'
      },
      () => {
        const env = resolveIntegrationEnv(jira, null)
        assert.equal(env.JIRA_EMAIL, 'jane@acme.com', 'email must survive a shell-set authMode')
        assert.deepEqual(missingCredentials(jira, null), [])
      }
    )
  })

  test('shell env still leaves a genuinely missing field reported', () => {
    withShellEnv(
      { JIRA_BASE_URL: 'https://acme.atlassian.net', JIRA_AUTH_MODE: 'cloud-token' },
      () => {
        assert.deepEqual(missingCredentials(jira, null).sort(), ['apiToken', 'email'])
      }
    )
  })

  test('a shell value outside a select’s options is rejected, not treated as set', () => {
    // JIRA_AUTH_MODE=PAT (wrong case) is the obvious guess from the UI label.
    // Counting it as “set” would hide `email` (its showWhen no longer matches),
    // pass the gate, and hand the server an unrecognised mode that silently
    // falls back to cloud-token — Basic auth with an empty email, i.e. a 401
    // blamed on the token.
    withShellEnv(
      {
        JIRA_BASE_URL: 'https://acme.atlassian.net',
        JIRA_AUTH_MODE: 'PAT',
        JIRA_API_TOKEN: 'shell-tok'
      },
      () => {
        assert.deepEqual(
          missingCredentials(jira, null),
          ['authMode'],
          'the gate must name the field the user has to fix'
        )
        assert.equal(resolveActiveIntegrationEnvs({ jira: true }, null).jira, undefined)
      }
    )
  })

  test('a valid select value from the shell still passes', () => {
    withShellEnv(
      {
        JIRA_BASE_URL: 'https://jira.acme.internal',
        JIRA_AUTH_MODE: 'pat',
        JIRA_API_TOKEN: 'shell-tok'
      },
      () => {
        assert.deepEqual(missingCredentials(jira, null), [])
        assert.equal(resolveIntegrationEnv(jira, null).JIRA_AUTH_MODE, 'pat')
      }
    )
  })

  test('free-text shell fields are not option-validated', () => {
    // Only `select` has a closed value space; a baseUrl of any shape must still
    // count as supplied, otherwise the validation would reject real config.
    withShellEnv(
      {
        JIRA_BASE_URL: 'not-really-a-url',
        JIRA_AUTH_MODE: 'pat',
        JIRA_API_TOKEN: 'shell-tok'
      },
      () => {
        assert.deepEqual(missingCredentials(jira, null), [])
      }
    )
  })

  test('status reports configured when the shell supplies the missing pieces', () => {
    settingsStore = {}
    saveIntegrationCredentials(WS, 'jira', {
      authMode: 'pat',
      baseUrl: 'https://jira.acme.internal'
    })
    assert.equal(getCredentialStatus(WS, 'jira').configured, false)

    withShellEnv({ JIRA_API_TOKEN: 'shell-tok' }, () => {
      const status = getCredentialStatus(WS, 'jira')
      assert.equal(status.configured, true, 'UI gate must agree with the mount gate')
      assert.deepEqual(status.missingKeys, [])
      assert.equal(
        status.filledKeys.includes('apiToken'),
        false,
        'filledKeys stays stored-only — a shell value is not something Clear can remove'
      )
    })
  })
})

// ── Env resolution ──

describe('integration-credentials — resolveIntegrationEnv', () => {
  beforeEach(wireSettingsStore)

  test('stored credentials map onto their declared env vars', () => {
    settingsStore = {}
    saveIntegrationCredentials(WS, 'jira', {
      authMode: 'pat',
      baseUrl: 'https://jira.acme.internal',
      apiToken: 'tok'
    })
    const env = resolveIntegrationEnv(jira, WS)
    assert.equal(env.JIRA_BASE_URL, 'https://jira.acme.internal')
    assert.equal(env.JIRA_AUTH_MODE, 'pat')
    assert.equal(env.JIRA_API_TOKEN, 'tok')
  })

  test('stored credentials win over shell env', () => {
    process.env.JIRA_API_TOKEN = 'from-shell'
    try {
      assert.equal(resolveIntegrationEnv(jira, WS).JIRA_API_TOKEN, 'tok')
    } finally {
      delete process.env.JIRA_API_TOKEN
    }
  })

  test('hidden fields are not leaked into the child env', () => {
    settingsStore = {}
    saveIntegrationCredentials(WS, 'jira', {
      authMode: 'cloud-token',
      baseUrl: 'https://acme.atlassian.net',
      email: 'jane@acme.com',
      username: 'stale-user',
      apiToken: 'tok'
    })
    const env = resolveIntegrationEnv(jira, WS)
    assert.equal(env.JIRA_EMAIL, 'jane@acme.com')
    assert.equal(env.JIRA_USERNAME, undefined, 'username is hidden in cloud-token mode')
  })

  test('configured workspace passes the mount gate', () => {
    assert.deepEqual(missingCredentials(jira, WS), [])
    assert.ok(resolveActiveIntegrationEnvs({ jira: true }, WS).jira)
  })

  test('falls back to process.env for declared env keys (legacy shell behaviour)', () => {
    process.env.JIRA_BASE_URL = 'https://shell.atlassian.net'
    try {
      const env = resolveIntegrationEnv(jira, null)
      assert.equal(env.JIRA_BASE_URL, 'https://shell.atlassian.net')
    } finally {
      delete process.env.JIRA_BASE_URL
    }
  })

  test('proxy / CA env vars are forwarded to the child process', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp:8080'
    try {
      assert.equal(resolveIntegrationEnv(jira, null).HTTPS_PROXY, 'http://proxy.corp:8080')
    } finally {
      delete process.env.HTTPS_PROXY
    }
  })

  test('undeclared env vars are never forwarded', () => {
    process.env.SOME_UNRELATED_SECRET = 'nope'
    try {
      const env = resolveIntegrationEnv(jira, null)
      assert.equal(env.SOME_UNRELATED_SECRET, undefined)
    } finally {
      delete process.env.SOME_UNRELATED_SECRET
    }
  })

  test('performanceEnv is always overlaid', () => {
    assert.equal(resolveIntegrationEnv(maestro, null).MAESTRO_WAIT_TIMEOUT, '0')
    assert.equal(resolveIntegrationEnv(jira, null).NODE_USE_ENV_PROXY, '1')
  })

  test('performanceEnv wins over a conflicting shell value', () => {
    process.env.MAESTRO_WAIT_TIMEOUT = '9999'
    try {
      assert.equal(resolveIntegrationEnv(maestro, null).MAESTRO_WAIT_TIMEOUT, '0')
    } finally {
      delete process.env.MAESTRO_WAIT_TIMEOUT
    }
  })

  test('no workspace + no shell env → jira reports missing credentials', () => {
    assert.deepEqual(missingCredentials(jira, null).sort(), ['apiToken', 'authMode', 'baseUrl'])
  })

  test('integrations without credential fields are never reported missing', () => {
    assert.deepEqual(missingCredentials(maestro, null), [])
  })

  test('resolveActiveIntegrationEnvs omits integrations with incomplete credentials', () => {
    const envs = resolveActiveIntegrationEnvs({ jira: true, maestro: true }, null)
    assert.equal(envs.jira, undefined, 'jira must not be mounted without credentials')
    assert.ok(envs.maestro, 'maestro has no required credentials and stays mountable')
  })

  test('inactive integrations are skipped entirely', () => {
    assert.deepEqual(resolveActiveIntegrationEnvs({ maestro: false }, null), {})
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
