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
  buildCommentBody,
  flattenAdf,
  formatAttachments,
  issueBrowseUrl
} from '../../mcp-servers/jira-api'
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

// summaryAsync() calls process.exit() — only run it as the entry point, or the
// shared runner is terminated mid-list.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
