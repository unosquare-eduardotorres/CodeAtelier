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
import { buildCommentBody, issueBrowseUrl } from '../../mcp-servers/jira-api'
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
    browseUrl: `${CLOUD}/browse/PROJ-42`,
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

void summaryAsync()
