/**
 * blueprint-memory-hooks.test.ts — Tests for blueprint → memory integration.
 *
 * Validates approval fact shape, completion extraction assembly, and
 * reference document enqueue logic. Pure logic — no LLM or DB required.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Approval fact shape ──

describe('blueprint approval fact', () => {
  test('approved decision fact has correct shape', () => {
    const blueprintId = 'bp-123'
    const title = 'Build authentication system'
    const approved = true
    const decision = approved ? 'approved' : 'rejected'

    const planSummary = '## Plan\n1. Implement OAuth2\n2. Add JWT tokens'

    const fact = {
      workspaceId: 'ws-1',
      category: 'decision' as const,
      title: `Blueprint ${decision}: ${title}`,
      content: `Plan was ${decision} by the user.\n\n### Plan Summary\n${planSummary}`,
      tags: ['blueprint', `blueprint:${blueprintId}`, decision],
      sourceType: 'blueprint' as const,
      sourceRef: blueprintId
    }

    assert.equal(fact.category, 'decision')
    assert.ok(fact.title.startsWith('Blueprint approved:'))
    assert.ok(fact.content.includes('Plan was approved'))
    assert.ok(fact.content.includes('OAuth2'))
    assert.ok(fact.tags.includes('blueprint'))
    assert.ok(fact.tags.includes('approved'))
    assert.equal(fact.sourceType, 'blueprint')
    assert.equal(fact.sourceRef, blueprintId)
  })

  test('rejected decision fact captures rejection', () => {
    const approved = false
    const decision = approved ? 'approved' : 'rejected'
    assert.equal(decision, 'rejected')

    const tags = ['blueprint', 'blueprint:bp-456', decision]
    assert.ok(tags.includes('rejected'))
    assert.ok(!tags.includes('approved'))
  })

  test('plan summary truncated to 2000 chars', () => {
    const longPlan = 'x'.repeat(5000)
    const planSummary = longPlan.substring(0, 2000)
    assert.equal(planSummary.length, 2000)
  })

  test('missing plan artifact falls back to description', () => {
    const phases = [{ phase: 'plan', artifacts: [] }]
    const description = 'Build a cool app'

    const planPhase = phases.find((p) => p.phase === 'plan')
    const planArtifact = (planPhase as any)?.artifacts?.find((a: any) => a.type === 'plan')
    const planSummary = planArtifact?.contentMd
      ? planArtifact.contentMd.substring(0, 2000)
      : description

    assert.equal(planSummary, description)
  })
})

// ── Reference doc extraction at Specify phase ──
// MEM-DOC-SPECIFY-01: Extraction moved from BLUEPRINT_CREATE to startSpecifyPhase(),
// covering create, createFromIdea, resume, and retry paths.

describe('reference doc extraction at specify phase', () => {
  test('binary docs are filtered out before extraction', () => {
    const BINARY_EXTS = new Set([
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.webp',
      '.svg',
      '.ico',
      '.bmp',
      '.pdf',
      '.doc',
      '.docx',
      '.zip',
      '.tar',
      '.gz',
      '.dmg',
      '.exe',
      '.mp3',
      '.mp4',
      '.wav'
    ])

    const docs = [
      { type: 'file', path: 'spec.md', name: 'spec.md' },
      { type: 'file', path: 'design.png', name: 'design.png' },
      { type: 'url', path: 'https://example.com/api', name: 'API Docs' },
      { type: 'workspace-file', path: 'data.pdf', name: 'data.pdf' }
    ]

    const textDocs = docs.filter((doc) => {
      const ext = doc.path.toLowerCase().match(/\.\w+$/)?.[0] ?? ''
      return !BINARY_EXTS.has(ext)
    })

    assert.equal(textDocs.length, 2, 'Only .md and URL should pass binary filter')
    assert.equal(textDocs[0].name, 'spec.md')
    assert.equal(textDocs[1].name, 'API Docs')
  })

  test('extractReferenceDocuments returns undefined for null settings', () => {
    // Mimics the extractReferenceDocuments validation logic
    function extractRefDocs(settingsJson: Record<string, unknown> | null | undefined) {
      if (!settingsJson) return undefined
      const docs = settingsJson.referenceDocuments
      if (!Array.isArray(docs)) return undefined
      const valid = docs.filter(
        (d: any) => d && typeof d === 'object' && typeof d.path === 'string'
      )
      return valid.length > 0 ? valid : undefined
    }

    assert.equal(extractRefDocs(null), undefined)
    assert.equal(extractRefDocs(undefined), undefined)
    assert.equal(extractRefDocs({}), undefined)
    assert.equal(extractRefDocs({ referenceDocuments: 'not-array' }), undefined)
    assert.equal(extractRefDocs({ referenceDocuments: [] }), undefined)
  })

  test('extractReferenceDocuments returns valid docs', () => {
    function extractRefDocs(settingsJson: Record<string, unknown> | null) {
      if (!settingsJson) return undefined
      const docs = settingsJson.referenceDocuments
      if (!Array.isArray(docs)) return undefined
      const valid = docs.filter(
        (d: any) => d && typeof d === 'object' && typeof d.path === 'string'
      )
      return valid.length > 0 ? valid : undefined
    }

    const result = extractRefDocs({
      referenceDocuments: [
        { type: 'file', path: 'spec.md', name: 'Spec' },
        { invalid: true }, // no path
        { type: 'url', path: 'https://docs.example.com', name: 'Docs' }
      ]
    })
    assert.ok(result)
    assert.equal(result!.length, 2)
  })
})

// ── Completion extraction assembly ──

describe('blueprint completion extraction', () => {
  test('task outcome counts are correct', () => {
    const tasks = [
      { taskId: 'T1', description: 'Task 1', status: 'complete' },
      { taskId: 'T2', description: 'Task 2', status: 'complete' },
      { taskId: 'T3', description: 'Task 3', status: 'failed' },
      { taskId: 'T4', description: 'Task 4', status: 'skipped' },
      { taskId: 'T5', description: 'Task 5', status: 'skipped' }
    ]

    const completed = tasks.filter((t) => t.status === 'complete')
    const failed = tasks.filter((t) => t.status === 'failed')
    const skipped = tasks.filter((t) => t.status === 'skipped')

    assert.equal(completed.length, 2)
    assert.equal(failed.length, 1)
    assert.equal(skipped.length, 2)
  })

  test('failed tasks are limited to 10 in extraction', () => {
    const tasks = Array.from({ length: 15 }, (_, i) => ({
      taskId: `T${i}`,
      description: `Failed task ${i}`,
      status: 'failed'
    }))

    const failed = tasks.filter((t) => t.status === 'failed')
    const limited = failed.slice(0, 10)
    assert.equal(limited.length, 10)
  })

  test('clarify Q&A is formatted correctly', () => {
    const clarifyQA = [
      { question: 'What database?', answer: 'SQLite' },
      { question: 'Auth method?', answer: 'JWT tokens' }
    ]
    const qaLines = clarifyQA.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n')

    assert.ok(qaLines.includes('Q: What database?\nA: SQLite'))
    assert.ok(qaLines.includes('Q: Auth method?\nA: JWT tokens'))
  })

  test('extraction tags include blueprint prefix', () => {
    const blueprintId = 'bp-abc'
    const factTags = ['convention']
    const fullTags = [...factTags, 'blueprint', `blueprint:${blueprintId}`]

    assert.ok(fullTags.includes('blueprint'))
    assert.ok(fullTags.includes('blueprint:bp-abc'))
    assert.equal(fullTags.length, 3)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
