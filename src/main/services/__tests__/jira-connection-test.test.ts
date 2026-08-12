/**
 * Jira connection test — field-value mapping and pre-flight validation.
 *
 * The network path uses Electron's `net.fetch` (system proxy + OS cert store),
 * which is not available under the test stub, so these tests cover the
 * validation branches that run before any request plus the field-key → config
 * mapping shared with the credential form.
 *
 * Run: tsx src/main/services/__tests__/jira-connection-test.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

const { jiraConfigFromFieldValues, testJiraConnection } =
  require('../jira-connection-test') as typeof import('../jira-connection-test')

describe('jira-connection-test — jiraConfigFromFieldValues', () => {
  test('maps registry field keys onto the Jira config shape', () => {
    const config = jiraConfigFromFieldValues({
      authMode: 'cloud-token',
      baseUrl: 'https://acme.atlassian.net',
      email: 'jane@acme.com',
      apiToken: 'tok'
    })
    assert.deepEqual(config, {
      baseUrl: 'https://acme.atlassian.net',
      authMode: 'cloud-token',
      email: 'jane@acme.com',
      username: undefined,
      apiToken: 'tok'
    })
  })

  test('pat and basic modes are preserved', () => {
    assert.equal(jiraConfigFromFieldValues({ authMode: 'pat' }).authMode, 'pat')
    assert.equal(jiraConfigFromFieldValues({ authMode: 'basic' }).authMode, 'basic')
  })

  test('unknown or absent mode defaults to cloud-token', () => {
    assert.equal(jiraConfigFromFieldValues({}).authMode, 'cloud-token')
    assert.equal(jiraConfigFromFieldValues({ authMode: 'weird' }).authMode, 'cloud-token')
  })

  test('absent values become empty strings, never undefined URLs', () => {
    const config = jiraConfigFromFieldValues({})
    assert.equal(config.baseUrl, '')
    assert.equal(config.apiToken, '')
  })
})

describe('jira-connection-test — pre-flight validation', () => {
  test('missing URL → missing-fields, no request attempted', async () => {
    const result = await testJiraConnection(jiraConfigFromFieldValues({ apiToken: 'tok' }))
    assert.equal(result.ok, false)
    assert.equal(result.code, 'missing-fields')
  })

  test('missing token → missing-fields', async () => {
    const result = await testJiraConnection(
      jiraConfigFromFieldValues({ baseUrl: 'https://acme.atlassian.net' })
    )
    assert.equal(result.ok, false)
    assert.equal(result.code, 'missing-fields')
  })

  test('cloud-token without email is rejected with an actionable message', async () => {
    const result = await testJiraConnection(
      jiraConfigFromFieldValues({
        authMode: 'cloud-token',
        baseUrl: 'https://acme.atlassian.net',
        apiToken: 'tok'
      })
    )
    assert.equal(result.code, 'missing-fields')
    assert.ok(result.message.toLowerCase().includes('email'))
  })

  test('basic mode without username is rejected', async () => {
    const result = await testJiraConnection(
      jiraConfigFromFieldValues({
        authMode: 'basic',
        baseUrl: 'https://jira.acme.internal',
        apiToken: 'tok'
      })
    )
    assert.equal(result.code, 'missing-fields')
    assert.ok(result.message.toLowerCase().includes('username'))
  })

  test('pat mode needs neither email nor username to pass validation', async () => {
    // No `net` under the stub, so this reaches the request and fails there —
    // the point is that it gets past the missing-fields guards.
    const result = await testJiraConnection(
      jiraConfigFromFieldValues({
        authMode: 'pat',
        baseUrl: 'https://jira.acme.internal',
        apiToken: 'tok'
      })
    )
    assert.notEqual(result.code, 'missing-fields')
  })

  test('failure results never echo the token back', async () => {
    const result = await testJiraConnection(
      jiraConfigFromFieldValues({
        authMode: 'pat',
        baseUrl: 'https://jira.acme.internal',
        apiToken: 'super-secret-token'
      })
    )
    assert.equal(JSON.stringify(result).includes('super-secret-token'), false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
