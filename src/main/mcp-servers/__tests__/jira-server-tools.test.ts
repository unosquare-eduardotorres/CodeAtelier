/**
 * jira-server.ts — real tool-handler coverage.
 *
 * The registered jira-server.test only exercises jira-api helpers; the server
 * module itself sat at 0%. These tests capture the module-scope
 * McpServer.tool registrations and drive the real handlers against a mocked
 * global fetch — covering validation, HTTP status mapping, the 204/no-JSON
 * branches and the unconfigured-config path.
 *
 * Run: tsx src/main/mcp-servers/__tests__/jira-server-tools.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from '../../services/__tests__/test-harness'
import { setupElectronStub } from '../../services/__tests__/electron-stub'
import { patchToolCapture, invokeTool } from './mcp-tool-capture'

setupElectronStub()

// jiraConfigFromEnv() runs at module scope — configure before the require.
const ENV = {
  JIRA_BASE_URL: 'https://test.atlassian.net',
  JIRA_AUTH_MODE: 'cloud-token',
  JIRA_EMAIL: 'dev@example.com',
  JIRA_API_TOKEN: 'token-123'
}
const savedEnv: Record<string, string | undefined> = {}
for (const [k, v] of Object.entries(ENV)) {
  savedEnv[k] = process.env[k]
  process.env[k] = v
}

const jiraPath = require.resolve('../jira-server')

const capture = patchToolCapture()
try {
  delete require.cache[jiraPath]
  require('../jira-server')
} finally {
  capture.restore()
}

// ── fetch mock ───────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch
const fetchCalls: Array<{ url: string; init: any }> = []

function mockFetch(responder: (url: string, init: any) => Response | Promise<Response>): void {
  fetchCalls.length = 0
  globalThis.fetch = (async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init })
    return responder(String(url), init)
  }) as never
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as never
}

function textOf(result: any): string {
  assert.ok(result?.content?.[0]?.type === 'text', 'tool result must carry text content')
  return result.content[0].text as string
}

const ISSUE = {
  key: 'PROJ-123',
  fields: {
    summary: 'Fix login loop',
    status: { name: 'In Progress' },
    assignee: { displayName: 'Dana' },
    priority: { name: 'High' },
    labels: ['auth'],
    description: 'Users loop forever after SSO',
    comment: { comments: [{ body: 'Reproduced', author: { displayName: 'Sam' } }] }
  }
}

describe('jira-server — tool registration', () => {
  test('five tools register (two read, three write)', () => {
    assert.deepEqual(capture.names, [
      'get_issue',
      'search_issues',
      'add_comment',
      'assign_issue',
      'transition_issue'
    ])
  })
})

describe('jira-server — get_issue', () => {
  test('rejects a malformed key before any HTTP call', async () => {
    await runExclusive(async () => {
      mockFetch(() => jsonResponse({}))
      const out = textOf(await invokeTool(capture, 'get_issue', { issueKey: 'nope!!' }))
      assert.ok(out.includes('Invalid issue key'), out)
      assert.equal(fetchCalls.length, 0)
    })
  })

  test('fetches the issue and renders it', async () => {
    await runExclusive(async () => {
      mockFetch(() => jsonResponse(ISSUE))
      const out = textOf(await invokeTool(capture, 'get_issue', { issueKey: 'proj-123' }))
      assert.ok(out.includes('Fix login loop'), out)
      assert.ok(fetchCalls[0].url.includes('/rest/api/3/issue/PROJ-123'), fetchCalls[0].url)
      assert.equal(fetchCalls[0].init.method, 'GET')
    })
  })

  test('maps a 404 to a user-facing message without the token', async () => {
    await runExclusive(async () => {
      mockFetch(() => jsonResponse({ errorMessages: ['nope'] }, 404))
      const out = textOf(await invokeTool(capture, 'get_issue', { issueKey: 'PROJ-404' }))
      assert.ok(!out.includes('token-123'), out)
      assert.ok(out.length > 0)
    })
  })

  test('a non-JSON body is reported as a proxy/SSO problem', async () => {
    await runExclusive(async () => {
      mockFetch(
        () =>
          ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token') } }) as never
      )
      const out = textOf(await invokeTool(capture, 'get_issue', { issueKey: 'PROJ-1' }))
      assert.ok(out.includes('not JSON'), out)
    })
  })

  test('a network failure is mapped, not leaked', async () => {
    await runExclusive(async () => {
      mockFetch(() => Promise.reject(new TypeError('fetch failed')))
      const out = textOf(await invokeTool(capture, 'get_issue', { issueKey: 'PROJ-1' }))
      assert.ok(out.length > 0)
      assert.ok(!out.includes('TypeError'))
    })
  })
})

describe('jira-server — search_issues', () => {
  test('issues the JQL search and renders compact rows', async () => {
    await runExclusive(async () => {
      mockFetch(() =>
        jsonResponse({ issues: [{ key: 'PROJ-9', fields: { summary: 'Nil guard', status: { name: 'Open' }, assignee: null } }] })
      )
      const out = textOf(
        await invokeTool(capture, 'search_issues', { jql: 'project = PROJ', maxResults: 5 })
      )
      assert.ok(out.includes('PROJ-9'), out)
      assert.equal(fetchCalls[0].init.method, 'GET')
    })
  })
})

describe('jira-server — add_comment', () => {
  test('refuses an empty comment', async () => {
    await runExclusive(async () => {
      mockFetch(() => jsonResponse(null, 204))
      const out = textOf(await invokeTool(capture, 'add_comment', { issueKey: 'PROJ-1', body: '   ' }))
      assert.ok(out.includes('empty'), out)
      assert.equal(fetchCalls.length, 0)
    })
  })

  test('posts and confirms with the browse URL', async () => {
    await runExclusive(async () => {
      mockFetch(() => jsonResponse(null, 204))
      const out = textOf(
        await invokeTool(capture, 'add_comment', { issueKey: 'PROJ-1', body: 'Implemented in #42' })
      )
      assert.ok(out.includes('Comment posted on PROJ-1'), out)
      assert.ok(out.includes('https://test.atlassian.net/browse/PROJ-1'), out)
      assert.equal(fetchCalls.length, 1)
    })
  })
})

describe('jira-server — assign_issue', () => {
  test('reads /myself then PUTs the assignee', async () => {
    await runExclusive(async () => {
      mockFetch((url) =>
        url.endsWith('/myself')
          ? jsonResponse({ displayName: 'Dana Doe', accountId: 'acct-1' })
          : jsonResponse(null, 204)
      )
      const out = textOf(await invokeTool(capture, 'assign_issue', { issueKey: 'PROJ-7' }))
      assert.ok(out.includes('assigned to Dana Doe'), out)
      assert.equal(fetchCalls.length, 2)
      assert.ok(fetchCalls[1].url.includes('/assignee'))
      assert.equal(fetchCalls[1].init.method, 'PUT')
    })
  })
})

describe('jira-server — transition_issue', () => {
  const TRANSITIONS = {
    transitions: [
      { id: '11', name: 'In Progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
      { id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }
    ]
  }

  test('no transition argument lists the available options', async () => {
    await runExclusive(async () => {
      mockFetch(() => jsonResponse(TRANSITIONS))
      const out = textOf(await invokeTool(capture, 'transition_issue', { issueKey: 'PROJ-1' }))
      assert.ok(out.includes('In Progress') && out.includes('Done'), out)
      assert.equal(fetchCalls.length, 1) // listing only — no POST
    })
  })

  test('a matching transition is executed', async () => {
    await runExclusive(async () => {
      mockFetch((url, init) => (init?.method === 'POST' ? jsonResponse(null, 204) : jsonResponse(TRANSITIONS)))
      const out = textOf(
        await invokeTool(capture, 'transition_issue', { issueKey: 'PROJ-1', transition: 'done' })
      )
      assert.ok(out.includes('moved via "Done"'), out)
      assert.equal(fetchCalls.length, 2)
      assert.equal(fetchCalls[1].init.method, 'POST')
    })
  })

  test('an unknown transition names the available ones', async () => {
    await runExclusive(async () => {
      mockFetch(() => jsonResponse(TRANSITIONS))
      const out = textOf(
        await invokeTool(capture, 'transition_issue', { issueKey: 'PROJ-1', transition: 'Blocked' })
      )
      assert.ok(out.includes('No transition named "Blocked"'), out)
    })
  })

  test('an empty transitions payload explains the workflow dead-end', async () => {
    await runExclusive(async () => {
      mockFetch(() => jsonResponse({ transitions: [] }))
      const out = textOf(await invokeTool(capture, 'transition_issue', { issueKey: 'PROJ-1' }))
      assert.ok(out.includes('no transitions available'), out)
    })
  })
})

describe('jira-server — unconfigured', () => {
  test('handlers explain that Jira is not configured (no env)', async () => {
    await runExclusive(async () => {
      // Reload the module with the Jira env vars unset — jiraConfigFromEnv()
      // runs at module scope, so a fresh instance sees an empty environment.
      mockFetch(() => jsonResponse({}))
      for (const k of Object.keys(ENV)) delete process.env[k]
      const unconfigured = patchToolCapture()
      try {
        delete require.cache[jiraPath]
        require('../jira-server')
      } finally {
        unconfigured.restore()
        // Leave the CONFIGURED instance cached for any later unified-run file.
        for (const [k, v] of Object.entries(ENV)) process.env[k] = v
        delete require.cache[jiraPath]
        require('../jira-server')
      }
      const out = textOf(await invokeTool(unconfigured, 'get_issue', { issueKey: 'PROJ-1' }))
      assert.ok(out.includes('Jira is not configured'), out)
      assert.equal(fetchCalls.length, 0, 'no HTTP call without config')
    })
  })
})

// The fetch mock must be restored before any LATER unified-run file makes
// network calls. runExclusive bodies execute in registration order, so this
// trailing body — registered last — runs last and restores the real fetch
// while this file's drain window is still open.
test('fetch is restored for later files', async () => {
  await runExclusive(async () => {
    globalThis.fetch = realFetch
    assert.equal(globalThis.fetch, realFetch)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
