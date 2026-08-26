/**
 * Jira tickets panel — pure logic behind the panel and its two conversions.
 *
 * Two behaviours carry real risk and are the focus here:
 *   1. Comment bodies. Jira Cloud v3 rejects a plain string and Server/DC v2
 *      cannot parse ADF, so `buildCommentBody` picking the wrong shape means
 *      every comment fails on one deployment. ADF is also the injection
 *      surface — comment text must land as literal text nodes.
 *   2. Conversion briefs. A blueprint created from a ticket only ever sees
 *      `formatIssueBrief`, so anything dropped there is invisible downstream.
 *
 * The network paths (`jira-rest.service`) use Electron's `net.fetch`, which is
 * unavailable under the test stub — same constraint as jira-connection-test.
 *
 * Run: tsx src/main/services/__tests__/jira-tickets.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  SEARCH_FIELDS,
  agileUrl,
  buildAssigneeBody,
  buildBoardsRequest,
  buildCommentBody,
  buildProjectsRequest,
  buildSearchRequest,
  buildSprintsRequest,
  buildTransitionBody,
  extractJiraErrorText,
  flattenAdf,
  formatAttachments,
  formatBoards,
  formatCurrentUser,
  formatProjects,
  formatSearchRows,
  formatSprints,
  formatTransitions,
  issueBrowseUrl
} from '../../mcp-servers/jira-api'
import {
  applyOrderBy,
  applyProjectScope,
  applySprintScope,
  orderByOf,
  readProjectScope,
  readSprintScope,
  stripOrderBy
} from '../../../shared/jira-jql'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ISSUE,
  safeAttachmentFilename,
  selectAttachments
} from '../jira-attachments'
import type { JiraAttachment } from '../../../shared/jira.types'
import {
  buildJiraChatPrompt,
  formatIssueBrief,
  indexBlueprintsByJiraKey,
  mapJiraPriority
} from '../../../shared/jira-format'
import type { JiraIssueDetail } from '../../../shared/jira.types'
import { JIRA_MAX_JQL_CHARS, JIRA_QUICK_FILTERS } from '../../../shared/jira.types'

const CLOUD = 'https://acme.atlassian.net'
const DC = 'https://jira.acme.internal'

function issue(overrides: Partial<JiraIssueDetail> = {}): JiraIssueDetail {
  return {
    key: 'PROJ-42',
    summary: 'Checkout total ignores discounts',
    type: 'Bug',
    status: 'In Progress',
    priority: 'High',
    assignee: 'Jane Doe',
    reporter: 'Sam Reporter',
    labels: ['billing', 'regression'],
    description: 'Totals are computed before discounts are applied.',
    comments: [],
    attachments: [],
    browseUrl: `${CLOUD}/browse/PROJ-42`,
    ...overrides
  }
}

function attachment(overrides: Partial<JiraAttachment> = {}): JiraAttachment {
  return {
    id: '10001',
    filename: 'screenshot.png',
    mimeType: 'image/png',
    size: 1024,
    contentUrl: `${CLOUD}/secure/attachment/10001/screenshot.png`,
    ...overrides
  }
}

// ── Comment bodies ──

describe('jira-api — buildCommentBody', () => {
  test('Server/DC gets a plain string body', () => {
    assert.deepEqual(JSON.parse(buildCommentBody(DC, 'Shipped in v2.1.')), {
      body: 'Shipped in v2.1.'
    })
  })

  test('Cloud gets an ADF document', () => {
    const parsed = JSON.parse(buildCommentBody(CLOUD, 'Shipped in v2.1.'))
    assert.deepEqual(parsed.body, {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Shipped in v2.1.' }] }]
    })
  })

  test('blank lines split ADF paragraphs', () => {
    const parsed = JSON.parse(buildCommentBody(CLOUD, 'First para.\n\n\nSecond para.'))
    assert.equal(parsed.body.content.length, 2)
    assert.equal(parsed.body.content[0].content[0].text, 'First para.')
    assert.equal(parsed.body.content[1].content[0].text, 'Second para.')
  })

  test('single newlines stay inside one paragraph', () => {
    const parsed = JSON.parse(buildCommentBody(CLOUD, 'line one\nline two'))
    assert.equal(parsed.body.content.length, 1)
    assert.equal(parsed.body.content[0].content[0].text, 'line one\nline two')
  })

  test('never emits an ADF paragraph with empty content', () => {
    // An empty `content` array is invalid ADF and Jira answers 400. Whitespace
    // between paragraph breaks must not survive as an empty node.
    const parsed = JSON.parse(buildCommentBody(CLOUD, 'a\n\n   \n\nb'))
    for (const node of parsed.body.content) {
      assert.ok(node.content.length > 0, 'paragraph node must carry content')
    }
  })

  test('whitespace-only text still produces a valid document', () => {
    const parsed = JSON.parse(buildCommentBody(CLOUD, '   \n\n  '))
    assert.ok(Array.isArray(parsed.body.content))
    assert.ok(parsed.body.content.length > 0, 'doc content must never be empty')
  })

  test('markup in the comment stays literal text, not ADF structure', () => {
    const hostile = '{code}rm -rf /{code} <b>bold</b> {"type":"mention"}'
    const parsed = JSON.parse(buildCommentBody(CLOUD, hostile))
    assert.equal(parsed.body.content.length, 1)
    const node = parsed.body.content[0].content[0]
    assert.equal(node.type, 'text')
    assert.equal(node.text, hostile, 'text is passed through verbatim, never parsed')
  })

  test('output is always valid JSON for both deployments', () => {
    const tricky = 'quotes " and \\ backslash\nand — unicode'
    assert.doesNotThrow(() => JSON.parse(buildCommentBody(CLOUD, tricky)))
    assert.doesNotThrow(() => JSON.parse(buildCommentBody(DC, tricky)))
  })
})

describe('jira-api — issueBrowseUrl', () => {
  test('builds a browse link and tolerates trailing slashes', () => {
    assert.equal(issueBrowseUrl(CLOUD, 'PROJ-42'), `${CLOUD}/browse/PROJ-42`)
    assert.equal(issueBrowseUrl(`${DC}///`, 'AB-1'), `${DC}/browse/AB-1`)
  })
})

// ── Priority mapping ──

describe('jira-format — mapJiraPriority', () => {
  test('escalation names map to P1', () => {
    for (const name of ['Highest', 'Blocker', 'Critical', 'P1']) {
      assert.equal(mapJiraPriority(name), 'P1', name)
    }
  })

  test('high-but-not-urgent names map to P2', () => {
    for (const name of ['High', 'Major', 'P2']) {
      assert.equal(mapJiraPriority(name), 'P2', name)
    }
  })

  test('matching is case- and whitespace-insensitive', () => {
    assert.equal(mapJiraPriority('  cRiTiCaL '), 'P1')
  })

  test('unknown, empty and absent priorities fall back to P3', () => {
    assert.equal(mapJiraPriority('Trivial'), 'P3')
    assert.equal(mapJiraPriority(''), 'P3')
    assert.equal(mapJiraPriority(undefined), 'P3')
  })
})

// ── Conversion brief ──

describe('jira-format — formatIssueBrief', () => {
  test('carries key, summary, link and description', () => {
    const brief = formatIssueBrief(issue())
    assert.match(brief, /## PROJ-42: Checkout total ignores discounts/)
    assert.match(brief, /\[PROJ-42\]\(https:\/\/acme\.atlassian\.net\/browse\/PROJ-42\)/)
    assert.match(brief, /Totals are computed before discounts are applied\./)
  })

  test('includes metadata fields that are present', () => {
    const brief = formatIssueBrief(issue())
    assert.match(brief, /\*\*Type:\*\* Bug/)
    assert.match(brief, /\*\*Status:\*\* In Progress/)
    assert.match(brief, /\*\*Priority:\*\* High/)
    assert.match(brief, /\*\*Reporter:\*\* Sam Reporter/)
    assert.match(brief, /\*\*Labels:\*\* billing, regression/)
  })

  test('omits absent metadata rather than printing undefined', () => {
    const brief = formatIssueBrief(
      issue({ type: undefined, status: undefined, priority: undefined, reporter: undefined })
    )
    assert.doesNotMatch(brief, /undefined/)
    assert.doesNotMatch(brief, /\*\*Type:\*\*/)
  })

  test('empty labels produce no Labels row', () => {
    assert.doesNotMatch(formatIssueBrief(issue({ labels: [] })), /\*\*Labels:\*\*/)
  })

  test('an empty description is called out, not left blank', () => {
    assert.match(formatIssueBrief(issue({ description: '' })), /_No description provided\._/)
  })

  test('comments are carried over — acceptance criteria often live there', () => {
    const brief = formatIssueBrief(
      issue({
        comments: [
          { author: 'Jane', created: '2026-01-01', body: 'Must also cover gift cards.' },
          { author: 'Sam', created: '2026-01-02', body: 'Agreed.' }
        ]
      })
    )
    assert.match(brief, /### Recent comments/)
    assert.match(brief, /\*\*Jane:\*\* Must also cover gift cards\./)
    assert.match(brief, /\*\*Sam:\*\* Agreed\./)
  })

  test('no comments means no comments section', () => {
    assert.doesNotMatch(formatIssueBrief(issue({ comments: [] })), /Recent comments/)
  })

  test('attachments are named so image placeholders can be resolved', () => {
    const brief = formatIssueBrief(
      issue({
        attachments: [
          attachment({ filename: 'checkout-total.png' }),
          attachment({ filename: 'server.log' })
        ]
      })
    )
    assert.match(brief, /### Attachments/)
    assert.match(brief, /- checkout-total\.png/)
    assert.match(brief, /- server\.log/)
  })

  test('the credentialed download URL never reaches the brief', () => {
    const brief = formatIssueBrief(
      issue({
        attachments: [attachment({ contentUrl: `${CLOUD}/secure/attachment/10001/shot.png` })]
      })
    )
    assert.doesNotMatch(brief, /secure\/attachment/)
  })

  test('no attachments means no attachments section', () => {
    assert.doesNotMatch(formatIssueBrief(issue({ attachments: [] })), /### Attachments/)
  })
})

// ── Attachments ──

describe('jira-api — flattenAdf media nodes', () => {
  test('an inline image leaves a placeholder instead of vanishing', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Repro steps below.' }] },
        {
          type: 'mediaSingle',
          content: [{ type: 'media', attrs: { id: 'abc-123', type: 'file' } }]
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'See the red banner.' }] }
      ]
    }
    const text = flattenAdf(adf)
    assert.match(text, /Repro steps below\./)
    assert.match(text, /\[image: see attachments\]/)
    assert.match(text, /See the red banner\./)
  })

  test('alt text is preferred when Jira supplies it', () => {
    const text = flattenAdf({ type: 'media', attrs: { alt: 'totals-bug.png' } })
    assert.equal(text, '[image: totals-bug.png]')
  })
})

describe('jira-api — formatAttachments', () => {
  test('shapes the fields the importer needs', () => {
    const shaped = formatAttachments([
      {
        id: 10001,
        filename: 'shot.png',
        mimeType: 'image/png',
        size: 2048,
        content: `${CLOUD}/secure/attachment/10001/shot.png`
      }
    ])
    assert.deepEqual(shaped, [
      {
        id: '10001',
        filename: 'shot.png',
        mimeType: 'image/png',
        size: 2048,
        contentUrl: `${CLOUD}/secure/attachment/10001/shot.png`
      }
    ])
  })

  test('entries without a filename or content URL are dropped, not half-built', () => {
    const shaped = formatAttachments([
      { filename: 'no-url.png' },
      { content: `${CLOUD}/x` },
      null,
      'nonsense'
    ])
    assert.deepEqual(shaped, [])
  })

  test('a missing attachment field is an empty list, not a throw', () => {
    assert.deepEqual(formatAttachments(undefined), [])
  })
})

describe('jira-attachments — safeAttachmentFilename', () => {
  test('traversal sequences cannot escape the managed directory', () => {
    assert.equal(safeAttachmentFilename('../../../etc/passwd'), 'passwd')
    assert.equal(safeAttachmentFilename('..\\..\\windows\\system32\\cmd.exe'), 'cmd.exe')
  })

  test('a name that reduces to nothing gets a fallback', () => {
    assert.equal(safeAttachmentFilename('..'), 'attachment')
    assert.equal(safeAttachmentFilename('/'), 'attachment')
  })

  test('shell-significant and unicode characters are neutralised', () => {
    assert.equal(safeAttachmentFilename('rm -rf $HOME;.png'), 'rm_-rf__HOME_.png')
    assert.doesNotMatch(safeAttachmentFilename('scénario échec.png'), /[^A-Za-z0-9._-]/)
  })

  test('the extension survives clipping of an absurdly long name', () => {
    const clipped = safeAttachmentFilename(`${'a'.repeat(400)}.png`)
    assert.ok(clipped.endsWith('.png'))
    assert.ok(clipped.length <= 120)
  })
})

describe('jira-attachments — selectAttachments', () => {
  test('keeps readable formats and drops the rest', () => {
    const picked = selectAttachments([
      attachment({ filename: 'shot.PNG' }),
      attachment({ filename: 'spec.pdf' }),
      attachment({ filename: 'demo.mp4' }),
      attachment({ filename: 'dump.zip' }),
      attachment({ filename: 'notes' })
    ])
    assert.deepEqual(
      picked.map((a) => a.filename),
      ['shot.PNG', 'spec.pdf']
    )
  })

  test('a file Jira already reports as oversized is not fetched', () => {
    const picked = selectAttachments([
      attachment({ filename: 'huge.png', size: MAX_ATTACHMENT_BYTES + 1 }),
      attachment({ filename: 'fine.png', size: MAX_ATTACHMENT_BYTES })
    ])
    assert.deepEqual(
      picked.map((a) => a.filename),
      ['fine.png']
    )
  })

  test('an unknown size is still fetched — the download enforces the cap', () => {
    const picked = selectAttachments([attachment({ filename: 'shot.png', size: undefined })])
    assert.equal(picked.length, 1)
  })

  test('a ticket with many attachments is capped', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_ISSUE + 5 }, (_, i) =>
      attachment({ filename: `shot-${i}.png` })
    )
    assert.equal(selectAttachments(many).length, MAX_ATTACHMENTS_PER_ISSUE)
  })

  test('no attachments is an empty list', () => {
    assert.deepEqual(selectAttachments([]), [])
  })
})

describe('jira-format — buildJiraChatPrompt', () => {
  test('is the brief plus an explicit instruction', () => {
    const prompt = buildJiraChatPrompt(issue())
    assert.ok(
      prompt.startsWith(formatIssueBrief(issue())),
      'chat prompt must reuse the same brief the blueprint gets'
    )
    assert.match(prompt, /plan how to implement it against this codebase/)
  })
})

// ── Duplicate guard ──

describe('jira-format — indexBlueprintsByJiraKey', () => {
  const bp = (id: string, settingsJson: Record<string, unknown>) => ({ id, settingsJson })

  test('indexes blueprints that came from a ticket', () => {
    const index = indexBlueprintsByJiraKey([
      bp('b1', { jiraIssueKey: 'PROJ-1', jiraUrl: `${CLOUD}/browse/PROJ-1` }),
      bp('b2', { jiraIssueKey: 'PROJ-2' })
    ])
    assert.equal(index.get('PROJ-1'), 'b1')
    assert.equal(index.get('PROJ-2'), 'b2')
    assert.equal(index.size, 2)
  })

  test('blueprints with no Jira origin are ignored, not indexed as undefined', () => {
    const index = indexBlueprintsByJiraKey([
      bp('b1', {}),
      bp('b2', { jiraIssueKey: '' }),
      bp('b3', { jiraIssueKey: 42 })
    ])
    assert.equal(index.size, 0)
  })

  test('a duplicate key resolves to the first entry — callers pass newest first', () => {
    const index = indexBlueprintsByJiraKey([
      bp('newest', { jiraIssueKey: 'PROJ-1' }),
      bp('oldest', { jiraIssueKey: 'PROJ-1' })
    ])
    assert.equal(index.get('PROJ-1'), 'newest')
  })

  test('lookup is exact — the handler normalises the key before asking', () => {
    const index = indexBlueprintsByJiraKey([bp('b1', { jiraIssueKey: 'PROJ-1' })])
    assert.equal(index.get('proj-1'), undefined)
    assert.equal(index.get(' PROJ-1 '.trim().toUpperCase()), 'b1')
  })

  test('an empty workspace produces an empty index', () => {
    assert.equal(indexBlueprintsByJiraKey([]).size, 0)
  })
})

// ── JQL cap ──

describe('jira.types — JIRA_MAX_JQL_CHARS', () => {
  test('every shipped quick filter fits well inside the cap', () => {
    for (const filter of JIRA_QUICK_FILTERS) {
      assert.ok(
        filter.jql.length < JIRA_MAX_JQL_CHARS,
        `${filter.id} (${filter.jql.length} chars) must not be rejected by the search handler`
      )
    }
  })

  test('the cap leaves room for a real hand-written query', () => {
    // Long-but-legitimate: a dozen project clauses plus an ORDER BY.
    const realistic = `project in (${Array.from({ length: 12 }, (_, i) => `PROJ${i}`).join(
      ', '
    )}) AND resolution = Unresolved ORDER BY updated DESC`
    assert.ok(realistic.length < JIRA_MAX_JQL_CHARS)
    assert.ok('x'.repeat(JIRA_MAX_JQL_CHARS + 1).length > JIRA_MAX_JQL_CHARS)
  })
})

// ── JQL rewriting ──

describe('jira-jql — ORDER BY', () => {
  test('applyOrderBy replaces an existing clause rather than appending a second', () => {
    // Every quick-filter chip ships its own ORDER BY, so this path is hit the
    // moment anyone sorts after clicking one. Two ORDER BY clauses is a 400.
    const chip = 'assignee = currentUser() AND sprint in openSprints() ORDER BY rank ASC'
    const next = applyOrderBy(chip, 'priority', 'desc')
    assert.equal(
      next,
      'assignee = currentUser() AND sprint in openSprints() ORDER BY priority DESC'
    )
    assert.equal(next.toLowerCase().split('order by').length - 1, 1)
  })

  test('a query with no ordering gets one appended', () => {
    assert.equal(
      applyOrderBy('project = CHR', 'updated', 'desc'),
      'project = CHR ORDER BY updated DESC'
    )
  })

  test('an empty query yields a bare ORDER BY, which is valid JQL', () => {
    assert.equal(applyOrderBy('', 'key', 'asc'), 'ORDER BY key ASC')
  })

  test('an ORDER BY inside a quoted literal is not mistaken for syntax', () => {
    const jql = 'summary ~ "order by monday" ORDER BY updated DESC'
    assert.equal(stripOrderBy(jql), 'summary ~ "order by monday"')
    assert.equal(orderByOf(jql), 'ORDER BY updated DESC')
  })

  test('"border" does not read as an ORDER BY', () => {
    assert.equal(stripOrderBy('summary ~ border'), 'summary ~ border')
  })

  test('Rank keeps its capital — the JQL field is spelled that way', () => {
    assert.equal(applyOrderBy('project = CHR', 'rank', 'asc'), 'project = CHR ORDER BY Rank ASC')
  })
})

describe('jira-jql — applyProjectScope', () => {
  test('replaces an existing project clause instead of ANDing a second one', () => {
    // `project = CHR AND project = NSLJD` matches nothing at all.
    assert.equal(
      applyProjectScope('project = NSLJD AND resolution = Unresolved ORDER BY updated DESC', 'CHR'),
      'project = "CHR" AND resolution = Unresolved ORDER BY updated DESC'
    )
  })

  test('adds a scope to a query that had none, keeping the ordering', () => {
    assert.equal(
      applyProjectScope('assignee = currentUser() ORDER BY rank ASC', 'CHR'),
      'project = "CHR" AND assignee = currentUser() ORDER BY rank ASC'
    )
  })

  test('null clears the scope and leaves the rest of the query intact', () => {
    assert.equal(
      applyProjectScope('project = CHR AND resolution = Unresolved ORDER BY updated DESC', null),
      'resolution = Unresolved ORDER BY updated DESC'
    )
  })

  test('clearing the only clause leaves a bare ORDER BY rather than an empty string', () => {
    assert.equal(
      applyProjectScope('project = CHR ORDER BY updated DESC', null),
      'ORDER BY updated DESC'
    )
  })

  test('a top-level OR is parenthesised, not dissected', () => {
    // Dropping a branch of an OR silently changes which issues the query means,
    // so the user-s query is preserved whole and narrowed.
    assert.equal(
      applyProjectScope('labels = urgent OR assignee = currentUser()', 'CHR'),
      'project = "CHR" AND (labels = urgent OR assignee = currentUser())'
    )
  })

  test('the key is sanitised, so the dropdown cannot smuggle in a clause', () => {
    assert.equal(
      applyProjectScope('resolution = Unresolved', 'CHR" OR key = "X-1'),
      'project = "CHRORKEYX1" AND resolution = Unresolved'
    )
  })

  test('readProjectScope reports what the query actually carries', () => {
    assert.equal(readProjectScope('project = "CHR" AND resolution = Unresolved'), 'CHR')
    assert.equal(readProjectScope('project = CHR ORDER BY updated DESC'), 'CHR')
    // Two projects is not one project, and the dropdown must not claim otherwise.
    assert.equal(readProjectScope('project in (CHR, NSLJD)'), null)
    assert.equal(readProjectScope('resolution = Unresolved'), null)
  })
})

describe('jira-jql — applySprintScope', () => {
  test('replaces `sprint in openSprints()` from the shipped chip', () => {
    // ANDing a sprint id onto openSprints() returns nothing whenever the sprint
    // is not the currently open one.
    assert.equal(
      applySprintScope(
        'assignee = currentUser() AND sprint in openSprints() ORDER BY rank ASC',
        42
      ),
      'sprint = 42 AND assignee = currentUser() ORDER BY rank ASC'
    )
  })

  test('null clears any sprint constraint', () => {
    assert.equal(applySprintScope('sprint = 42 AND project = "CHR"', null), 'project = "CHR"')
  })

  test('only digits survive, so the id cannot carry syntax', () => {
    assert.equal(
      applySprintScope('project = "CHR"', '42) OR (key = X-1'),
      'sprint = 421 AND project = "CHR"'
    )
  })

  test('readSprintScope round-trips a single-value clause', () => {
    assert.equal(readSprintScope(applySprintScope('project = "CHR"', 42)), '42')
    assert.equal(readSprintScope('sprint in openSprints()'), null)
  })
})

// ── Search request + pagination ──

describe('jira-api — buildSearchRequest cursor plumbing', () => {
  test('Cloud puts an opaque nextPageToken in the query string', () => {
    const request = buildSearchRequest(CLOUD, 'project = CHR', 50, 'opaque-token-abc')
    assert.equal(request.method, 'GET')
    assert.ok(request.url.includes('search/jql'))
    assert.ok(new URL(request.url).searchParams.get('nextPageToken') === 'opaque-token-abc')
    assert.equal(request.body, undefined)
  })

  test('Cloud omits the token entirely on the first page', () => {
    const request = buildSearchRequest(CLOUD, 'project = CHR', 50)
    assert.equal(new URL(request.url).searchParams.get('nextPageToken'), null)
  })

  test('Server/DC puts the cursor in the POST body as a numeric startAt', () => {
    const request = buildSearchRequest(DC, 'project = CHR', 50, '100')
    assert.equal(request.method, 'POST')
    assert.equal(JSON.parse(request.body!).startAt, 100)
  })

  test('Server/DC starts at 0 when there is no cursor, and never at NaN', () => {
    assert.equal(JSON.parse(buildSearchRequest(DC, 'x', 50).body!).startAt, 0)
    assert.equal(JSON.parse(buildSearchRequest(DC, 'x', 50, 'garbage').body!).startAt, 0)
  })

  test('the requested fields include what the list sorts and renders by', () => {
    // A priority sort against rows that never carried a priority always reports
    // "unknown", which looks like a broken sort rather than a missing field.
    for (const field of [
      'summary',
      'status',
      'issuetype',
      'assignee',
      'priority',
      'parent',
      'updated',
      'created'
    ]) {
      assert.ok(SEARCH_FIELDS.split(',').includes(field), `${field} must be requested`)
    }
  })
})

describe('jira-api — formatSearchRows', () => {
  const issue = {
    key: 'CHR-40',
    fields: {
      summary: 'Checkout total ignores discounts',
      status: { name: 'In Progress' },
      issuetype: { name: 'Bug' },
      assignee: { displayName: 'Josh Lane' },
      priority: { name: 'Highest' },
      parent: { key: 'CHR-1' },
      updated: '2026-06-01T00:00:00.000Z',
      created: '2026-01-01T00:00:00.000Z'
    }
  }

  test('carries priority, parentKey and created onto the row', () => {
    const shaped = formatSearchRows({ issues: [issue] })
    assert.equal(shaped.issues[0].priority, 'Highest')
    assert.equal(shaped.issues[0].parentKey, 'CHR-1')
    assert.equal(shaped.issues[0].created, '2026-01-01T00:00:00.000Z')
  })

  test('a missing priority or parent is undefined, not "undefined"', () => {
    const shaped = formatSearchRows({ issues: [{ key: 'CHR-2', fields: { summary: 's' } }] })
    assert.equal(shaped.issues[0].priority, undefined)
    assert.equal(shaped.issues[0].parentKey, undefined)
    assert.equal(shaped.issues[0].assignee, 'Unassigned')
  })

  test('Cloud: nextPageToken becomes the cursor and total stays absent', () => {
    const shaped = formatSearchRows({ issues: [issue], nextPageToken: 'tok' })
    assert.equal(shaped.nextCursor, 'tok')
    assert.equal(shaped.hasMore, true)
    assert.equal(shaped.total, undefined)
  })

  test('Cloud: isLast true means no cursor', () => {
    const shaped = formatSearchRows({ issues: [issue], isLast: true })
    assert.equal(shaped.hasMore, false)
    assert.equal(shaped.nextCursor, undefined)
  })

  test('Server/DC: the next cursor is startAt + page length', () => {
    const shaped = formatSearchRows({ issues: [issue], startAt: 50, total: 1240 })
    assert.equal(shaped.nextCursor, '51')
    assert.equal(shaped.hasMore, true)
    assert.equal(shaped.total, 1240)
  })

  test('Server/DC: the last page reports no cursor', () => {
    const shaped = formatSearchRows({ issues: [issue], startAt: 9, total: 10 })
    assert.equal(shaped.nextCursor, undefined)
    assert.equal(shaped.hasMore, false)
  })

  test('a null or malformed response does not throw', () => {
    assert.equal(formatSearchRows(null).count, 0)
    assert.equal(formatSearchRows(undefined).count, 0)
    assert.equal(formatSearchRows({}).count, 0)
  })
})

// ── Projects, boards and sprints ──

describe('jira-api — projects', () => {
  test('Cloud uses the paginated project/search ordered by activity', () => {
    const request = buildProjectsRequest(CLOUD)
    assert.ok(request.url.includes('/rest/api/3/project/search'))
    assert.equal(new URL(request.url).searchParams.get('orderBy'), 'lastIssueUpdatedTime')
  })

  test('Server/DC uses the plain unpaginated project endpoint', () => {
    const request = buildProjectsRequest(DC)
    assert.equal(request.url, `${DC}/rest/api/2/project`)
  })

  test('formatProjects reads Cloud-s { values } wrapper', () => {
    const projects = formatProjects({ values: [{ id: '1', key: 'CHR', name: 'Chronicle' }] })
    assert.deepEqual(projects, [{ id: '1', key: 'CHR', name: 'Chronicle' }])
  })

  test('formatProjects reads Server/DC-s bare array', () => {
    const projects = formatProjects([{ id: 7, key: 'NSLJD', name: 'Nightshade' }])
    assert.deepEqual(projects, [{ id: '7', key: 'NSLJD', name: 'Nightshade' }])
  })

  test('entries without a key are dropped, and a missing name falls back to the key', () => {
    const projects = formatProjects([{ id: '1' }, { key: 'CHR' }, null, 'nonsense'])
    assert.deepEqual(projects, [{ id: 'CHR', key: 'CHR', name: 'CHR' }])
  })

  test('an unexpected shape yields an empty list rather than throwing', () => {
    assert.deepEqual(formatProjects(null), [])
    assert.deepEqual(formatProjects({ nope: true }), [])
  })
})

describe('jira-api — boards and sprints', () => {
  test('the Agile API is unversioned and identical on both deployments', () => {
    // Deliberately bypasses apiUrl-s v2/v3 selection.
    assert.equal(agileUrl(CLOUD, 'board'), `${CLOUD}/rest/agile/1.0/board`)
    assert.equal(agileUrl(DC, 'board'), `${DC}/rest/agile/1.0/board`)
  })

  test('boards are always scoped to a project', () => {
    const request = buildBoardsRequest(CLOUD, 'CHR')
    assert.equal(new URL(request.url).searchParams.get('projectKeyOrId'), 'CHR')
  })

  test('sprints ask only for active and future — closed sprints are not work to pick up', () => {
    const request = buildSprintsRequest(CLOUD, 12)
    assert.ok(request.url.includes('/board/12/sprint'))
    assert.equal(new URL(request.url).searchParams.get('state'), 'active,future')
  })

  test('a non-numeric board id cannot escape into the path', () => {
    assert.ok(buildSprintsRequest(CLOUD, '12/../../issue').url.includes('/board/12/sprint'))
  })

  test('formatBoards and formatSprints drop entries with no numeric id', () => {
    assert.deepEqual(
      formatBoards({ values: [{ id: 1, name: 'CHR board', type: 'scrum' }, { name: 'x' }] }),
      [{ id: 1, name: 'CHR board', type: 'scrum' }]
    )
    assert.deepEqual(
      formatSprints({ values: [{ id: 5, name: 'Sprint 5', state: 'active' }, {}] }),
      [{ id: 5, name: 'Sprint 5', state: 'active' }]
    )
    assert.deepEqual(formatBoards(null), [])
    assert.deepEqual(formatSprints({}), [])
  })
})

// ── Writes ──

describe('jira-api — assignee and transitions', () => {
  test('Cloud identifies the assignee by accountId, Server/DC by name', () => {
    // Sending the wrong one is a 400 on every write, and it survives testing
    // against a single Jira instance.
    assert.deepEqual(JSON.parse(buildAssigneeBody(CLOUD, { accountId: 'abc', name: 'jlane' })), {
      accountId: 'abc'
    })
    assert.deepEqual(JSON.parse(buildAssigneeBody(DC, { accountId: 'abc', name: 'jlane' })), {
      name: 'jlane'
    })
  })

  test('an unknown identity sends null rather than the string "undefined"', () => {
    assert.deepEqual(JSON.parse(buildAssigneeBody(CLOUD, {})), { accountId: null })
  })

  test('formatCurrentUser handles both Cloud accountId and DC key/name', () => {
    assert.deepEqual(formatCurrentUser({ displayName: 'Josh Lane', accountId: 'abc' }), {
      displayName: 'Josh Lane',
      accountId: 'abc'
    })
    assert.deepEqual(formatCurrentUser({ name: 'jlane', key: 'jlane' }), {
      displayName: 'jlane',
      accountId: 'jlane',
      name: 'jlane'
    })
    assert.equal(formatCurrentUser(null).displayName, 'your account')
  })

  test('transitions are shaped with their target status, never a bare id', () => {
    const transitions = formatTransitions({
      transitions: [{ id: 21, name: 'Start work', to: { name: 'In Progress' } }, { name: 'no id' }]
    })
    assert.deepEqual(transitions, [{ id: '21', name: 'Start work', toStatus: 'In Progress' }])
  })

  test('the transition body wraps the id the way Jira expects', () => {
    assert.deepEqual(JSON.parse(buildTransitionBody('21')), { transition: { id: '21' } })
  })
})

// ── Error text ──

describe('jira-api — extractJiraErrorText', () => {
  test('surfaces the JQL clause Jira rejected', () => {
    // Without this a syntax error reads as a bare "Jira returned HTTP 400."
    assert.equal(
      extractJiraErrorText({
        errorMessages: ["Error in the JQL Query: The character '#' is a reserved JQL character."]
      }),
      "Error in the JQL Query: The character '#' is a reserved JQL character."
    )
  })

  test('field-keyed errors are labelled with their field', () => {
    assert.equal(
      extractJiraErrorText({ errors: { project: 'No project could be found.' } }),
      'project: No project could be found.'
    )
  })

  test('falls back to a bare message, and to null when there is nothing to say', () => {
    assert.equal(extractJiraErrorText({ message: 'Boom' }), 'Boom')
    assert.equal(extractJiraErrorText({}), null)
    assert.equal(extractJiraErrorText(null), null)
    assert.equal(extractJiraErrorText('<html>login</html>'), null)
  })

  test('long bodies are truncated — this text goes straight into the UI', () => {
    const long = extractJiraErrorText({ errorMessages: ['x'.repeat(2000)] })
    assert.ok(long !== null && long.length <= 501)
  })
})

// summaryAsync() calls process.exit() — only run it as the entry point, or the
// shared runner is terminated mid-list.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
