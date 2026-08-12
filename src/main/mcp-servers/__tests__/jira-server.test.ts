/**
 * Jira MCP server — pure helper coverage (src/main/mcp-servers/jira-api.ts).
 *
 * Covers issue-key validation, Cloud vs Data Center API selection, auth header
 * construction per mode, ADF→text flattening, error mapping and response shaping.
 *
 * Run: tsx src/main/mcp-servers/__tests__/jira-server.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  ISSUE_KEY_RE,
  apiUrl,
  apiVersion,
  buildAuthHeader,
  buildHeaders,
  buildSearchRequest,
  flattenAdf,
  formatIssue,
  formatSearchRows,
  isCloudHost,
  jiraConfigFromEnv,
  mapHttpStatus,
  mapNetworkError,
  normalizeBaseUrl,
  type JiraConfig
} from '../jira-api'

const CLOUD = 'https://acme.atlassian.net'
const DC = 'https://jira.acme.internal'

// ── Issue key validation ──

describe('jira-api — ISSUE_KEY_RE', () => {
  test('accepts standard keys', () => {
    assert.ok(ISSUE_KEY_RE.test('PROJ-123'))
    assert.ok(ISSUE_KEY_RE.test('AB-1'))
    assert.ok(ISSUE_KEY_RE.test('A1B2_C-4567'))
  })

  test('rejects lowercase and malformed keys', () => {
    assert.equal(ISSUE_KEY_RE.test('proj-123'), false)
    assert.equal(ISSUE_KEY_RE.test('PROJ123'), false)
    assert.equal(ISSUE_KEY_RE.test('P-123'), false, 'single-letter project keys are invalid')
    assert.equal(ISSUE_KEY_RE.test('PROJ-'), false)
  })

  test('rejects path traversal and injection attempts', () => {
    assert.equal(ISSUE_KEY_RE.test('PROJ-1/../../admin'), false)
    assert.equal(ISSUE_KEY_RE.test('PROJ-1?expand=all'), false)
    assert.equal(ISSUE_KEY_RE.test('PROJ-1 OR 1=1'), false)
  })
})

// ── Deployment detection + URL building ──

describe('jira-api — deployment detection', () => {
  test('normalizeBaseUrl strips trailing slashes and whitespace', () => {
    assert.equal(normalizeBaseUrl('  https://acme.atlassian.net///  '), CLOUD)
  })

  test('*.atlassian.net → Cloud → API v3', () => {
    assert.equal(isCloudHost(CLOUD), true)
    assert.equal(apiVersion(CLOUD), '3')
  })

  test('on-prem host → Server/DC → API v2', () => {
    assert.equal(isCloudHost(DC), false)
    assert.equal(apiVersion(DC), '2')
  })

  test('malformed URL is treated as on-prem rather than throwing', () => {
    assert.equal(isCloudHost('not a url'), false)
    assert.equal(apiVersion('not a url'), '2')
  })

  test('apiUrl joins without double slashes', () => {
    assert.equal(apiUrl(`${CLOUD}/`, 'myself'), `${CLOUD}/rest/api/3/myself`)
    assert.equal(apiUrl(DC, 'issue/PROJ-1'), `${DC}/rest/api/2/issue/PROJ-1`)
  })
})

// ── Auth headers ──

describe('jira-api — buildAuthHeader', () => {
  const base = { baseUrl: CLOUD, apiToken: 'tok123' }

  test('cloud-token → Basic base64(email:token)', () => {
    const header = buildAuthHeader({
      ...base,
      authMode: 'cloud-token',
      email: 'jane@acme.com'
    } as JiraConfig)
    assert.equal(header, `Basic ${Buffer.from('jane@acme.com:tok123').toString('base64')}`)
  })

  test('pat → Bearer token', () => {
    assert.equal(buildAuthHeader({ ...base, authMode: 'pat' } as JiraConfig), 'Bearer tok123')
  })

  test('basic → Basic base64(username:token)', () => {
    const header = buildAuthHeader({ ...base, authMode: 'basic', username: 'jdoe' } as JiraConfig)
    assert.equal(header, `Basic ${Buffer.from('jdoe:tok123').toString('base64')}`)
  })

  test('buildHeaders carries only auth + content negotiation', () => {
    const headers = buildHeaders({ ...base, authMode: 'pat' } as JiraConfig)
    assert.deepEqual(Object.keys(headers).sort(), ['Accept', 'Authorization', 'Content-Type'])
  })
})

// ── Env parsing ──

describe('jira-api — jiraConfigFromEnv', () => {
  test('returns null when URL or token is missing', () => {
    assert.equal(jiraConfigFromEnv({ JIRA_BASE_URL: CLOUD }), null)
    assert.equal(jiraConfigFromEnv({ JIRA_API_TOKEN: 'x' }), null)
  })

  test('unknown auth mode falls back to cloud-token', () => {
    const cfg = jiraConfigFromEnv({
      JIRA_BASE_URL: CLOUD,
      JIRA_API_TOKEN: 'x',
      JIRA_AUTH_MODE: 'nonsense'
    })
    assert.equal(cfg?.authMode, 'cloud-token')
  })

  test('pat mode is preserved and base URL normalised', () => {
    const cfg = jiraConfigFromEnv({
      JIRA_BASE_URL: `${DC}/`,
      JIRA_API_TOKEN: 'x',
      JIRA_AUTH_MODE: 'pat'
    })
    assert.equal(cfg?.authMode, 'pat')
    assert.equal(cfg?.baseUrl, DC)
  })
})

// ── Error mapping ──

describe('jira-api — error mapping', () => {
  test('2xx → ok', () => {
    assert.equal(mapHttpStatus(200, CLOUD).code, 'ok')
  })

  test('401/403 → auth-failed with deployment-specific hint', () => {
    assert.equal(mapHttpStatus(401, CLOUD).code, 'auth-failed')
    assert.equal(mapHttpStatus(403, DC).code, 'auth-failed')
    assert.ok(mapHttpStatus(401, CLOUD).message.includes('API token'))
    assert.ok(mapHttpStatus(401, DC).message.includes('Personal Access Token'))
  })

  test('404 → not-found', () => {
    assert.equal(mapHttpStatus(404, CLOUD).code, 'not-found')
  })

  test('other statuses → network', () => {
    assert.equal(mapHttpStatus(500, CLOUD).code, 'network')
    assert.equal(mapHttpStatus(429, CLOUD).code, 'network')
  })

  test('abort/timeout errors → timeout', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    assert.equal(mapNetworkError(abort).code, 'timeout')
    assert.equal(mapNetworkError(new Error('connect ETIMEDOUT')).code, 'timeout')
  })

  test('certificate errors → cert', () => {
    assert.equal(mapNetworkError(new Error('SELF_SIGNED_CERT_IN_CHAIN')).code, 'cert')
    assert.equal(mapNetworkError(new Error('ERR_CERT_AUTHORITY_INVALID')).code, 'cert')
  })

  test('dns/proxy errors → proxy', () => {
    assert.equal(mapNetworkError(new Error('getaddrinfo ENOTFOUND jira.acme')).code, 'proxy')
    assert.equal(mapNetworkError(new Error('ERR_PROXY_CONNECTION_FAILED')).code, 'proxy')
  })

  test('unknown errors → network', () => {
    assert.equal(mapNetworkError(new Error('socket hang up')).code, 'network')
  })

  test('never echoes the token back in the message', () => {
    const message = mapHttpStatus(401, CLOUD).message
    assert.equal(message.includes('tok123'), false)
  })
})

// ── ADF flattening ──

describe('jira-api — flattenAdf', () => {
  test('plain string (Data Center wiki markup) passes through', () => {
    assert.equal(flattenAdf('h1. Title\nsome text'), 'h1. Title\nsome text')
  })

  test('null/undefined → empty string', () => {
    assert.equal(flattenAdf(null), '')
    assert.equal(flattenAdf(undefined), '')
  })

  test('nested ADF document is flattened to text with paragraph breaks', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] }
      ]
    }
    assert.equal(flattenAdf(doc), 'First line\nSecond line\n')
  })

  test('hardBreak becomes a newline', () => {
    const doc = {
      type: 'paragraph',
      content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }]
    }
    assert.equal(flattenAdf(doc), 'a\nb\n')
  })

  test('bullet lists keep one item per line', () => {
    const doc = {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'text', text: 'one' }] },
        { type: 'listItem', content: [{ type: 'text', text: 'two' }] }
      ]
    }
    assert.equal(flattenAdf(doc), 'one\ntwo\n\n')
  })

  test('unknown node types still yield their inner text', () => {
    const doc = { type: 'mysteryPanel', content: [{ type: 'text', text: 'kept' }] }
    assert.equal(flattenAdf(doc), 'kept')
  })
})

// ── Response shaping ──

describe('jira-api — formatIssue', () => {
  const raw = {
    key: 'PROJ-7',
    fields: {
      summary: 'Fix the thing',
      status: { name: 'In Progress' },
      issuetype: { name: 'Bug' },
      priority: { name: 'High' },
      assignee: { displayName: 'Jane Doe' },
      reporter: { displayName: 'John Roe' },
      labels: ['backend'],
      parent: { key: 'PROJ-1' },
      description: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Details' }] }]
      },
      comment: {
        comments: [
          { author: { displayName: 'A' }, created: '2026-01-01', body: 'first' },
          { author: { displayName: 'B' }, created: '2026-01-02', body: 'second' }
        ]
      }
    }
  }

  test('maps nested objects onto flat display names', () => {
    const out = formatIssue(raw)
    assert.equal(out.key, 'PROJ-7')
    assert.equal(out.status, 'In Progress')
    assert.equal(out.assignee, 'Jane Doe')
    assert.equal(out.parent, 'PROJ-1')
    assert.equal(out.description, 'Details')
  })

  test('missing assignee reads as Unassigned', () => {
    const out = formatIssue({ key: 'X-1', fields: { summary: 's' } })
    assert.equal(out.assignee, 'Unassigned')
    assert.deepEqual(out.labels, [])
  })

  test('keeps only the most recent comments', () => {
    const out = formatIssue(raw, { maxComments: 1 })
    const comments = out.comments as { author: string }[]
    assert.equal(comments.length, 1)
    assert.equal(comments[0].author, 'B', 'should keep the newest, not the oldest')
  })

  test('long descriptions are truncated with a marker', () => {
    const long = { key: 'X-1', fields: { description: 'x'.repeat(200) } }
    const out = formatIssue(long, { maxDescriptionChars: 50 })
    assert.ok(String(out.description).includes('description truncated'))
  })

  test('empty issue does not throw', () => {
    const out = formatIssue({})
    assert.equal(out.key, undefined)
    assert.deepEqual(out.comments, [])
  })
})

describe('jira-api — formatSearchRows', () => {
  test('maps issues to compact rows', () => {
    const out = formatSearchRows({
      total: 42,
      issues: [{ key: 'A-1', fields: { summary: 's', status: { name: 'Done' } } }]
    })
    assert.equal(out.total, 42)
    assert.equal(out.count, 1)
    assert.equal(out.issues[0].status, 'Done')
  })

  test('missing/empty payload → zeroed result, no invented total', () => {
    assert.deepEqual(formatSearchRows(null), { count: 0, issues: [] })
    assert.deepEqual(formatSearchRows({}), { count: 0, issues: [] })
  })

  test('Cloud /search/jql response → total omitted, hasMore from nextPageToken', () => {
    const out = formatSearchRows({
      issues: [{ key: 'A-1' }, { key: 'A-2' }],
      nextPageToken: 'abc'
    })
    assert.equal(out.total, undefined, 'page size must not masquerade as the result total')
    assert.equal(out.count, 2)
    assert.equal(out.hasMore, true)
  })

  test('Cloud last page → hasMore false via isLast', () => {
    const out = formatSearchRows({ issues: [{ key: 'A-1' }], isLast: true })
    assert.equal(out.hasMore, false)
    assert.equal(out.total, undefined)
  })

  test('Data Center response → total preserved, hasMore absent', () => {
    const out = formatSearchRows({ total: 42, issues: [{ key: 'A-1' }] })
    assert.equal(out.total, 42)
    assert.equal(out.hasMore, undefined)
  })
})

// ── Search endpoint selection ──

describe('jira-api — buildSearchRequest', () => {
  test('Cloud uses GET /search/jql (POST /search was removed in 2025)', () => {
    const req = buildSearchRequest(CLOUD, 'project = PROJ', 10)
    assert.equal(req.method, 'GET')
    assert.ok(req.url.startsWith(`${CLOUD}/rest/api/3/search/jql?`))
    assert.ok(req.url.includes('jql=project+%3D+PROJ'))
    assert.equal(req.body, undefined)
  })

  test('Data Center uses POST /search with a JSON body', () => {
    const req = buildSearchRequest(DC, 'project = PROJ', 10)
    assert.equal(req.method, 'POST')
    assert.equal(req.url, `${DC}/rest/api/2/search`)
    assert.equal(JSON.parse(req.body!).jql, 'project = PROJ')
  })

  test('maxResults is clamped to 1..50', () => {
    assert.ok(buildSearchRequest(CLOUD, 'x', 500).url.includes('maxResults=50'))
    assert.ok(buildSearchRequest(CLOUD, 'x', 0).url.includes('maxResults=1'))
    assert.equal(JSON.parse(buildSearchRequest(DC, 'x', 999).body!).maxResults, 50)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
