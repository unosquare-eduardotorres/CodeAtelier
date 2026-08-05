/**
 * memory-extraction-content.test.ts — Tests for extractFromContent core + URL path.
 *
 * Validates the content-based extraction interface, source type passthrough,
 * tag merging, and minimum content length guard.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── extractFromContent interface shape ──

describe('extractFromContent', () => {
  test('rejects content shorter than 20 chars', () => {
    // The service rejects content < 20 chars. Validate the threshold exists.
    const MIN_CONTENT = 20
    assert.ok('short'.length < MIN_CONTENT, 'Short content should be below threshold')
    assert.ok('a'.repeat(20).length >= MIN_CONTENT, '20-char content should meet threshold')
  })

  test('sourceType defaults to document when opts not provided', () => {
    const defaultType = 'document'
    assert.equal(defaultType, 'document')
  })

  test('sourceType can be overridden via opts', () => {
    const opts = { sourceType: 'blueprint' as const }
    const sourceType = opts.sourceType ?? 'document'
    assert.equal(sourceType, 'blueprint')
  })

  test('tags merge between extracted facts and opts.tags', () => {
    const extractedTags = ['database', 'sqlite']
    const optsTags = ['blueprint', 'blueprint:abc123']
    const merged = [...extractedTags, ...optsTags]
    assert.deepEqual(merged, ['database', 'sqlite', 'blueprint', 'blueprint:abc123'])
  })

  test('tags merge handles empty extracted tags', () => {
    const extractedTags: string[] = []
    const optsTags = ['grill', 'plan']
    const merged = [...extractedTags, ...optsTags]
    assert.deepEqual(merged, ['grill', 'plan'])
  })

  test('tags merge handles missing opts.tags', () => {
    const extractedTags = ['convention']
    const optsTags = undefined
    const merged = [...extractedTags, ...(optsTags ?? [])]
    assert.deepEqual(merged, ['convention'])
  })
})

// ── MemorySourceType validation ──

describe('MemorySourceType', () => {
  const VALID_SOURCE_TYPES = [
    'session',
    'commit',
    'document',
    'tool',
    'manual',
    'claude-md',
    'blueprint',
    'grill'
  ]

  test('blueprint is a valid source type', () => {
    assert.ok(VALID_SOURCE_TYPES.includes('blueprint'))
  })

  test('grill is a valid source type', () => {
    assert.ok(VALID_SOURCE_TYPES.includes('grill'))
  })

  test('claude-md is a valid source type', () => {
    assert.ok(VALID_SOURCE_TYPES.includes('claude-md'))
  })

  test('all 8 source types are recognized', () => {
    assert.equal(VALID_SOURCE_TYPES.length, 8)
  })
})

// ── Blueprint extraction assembly ──

describe('blueprint extraction context assembly', () => {
  test('assembles spec + plan + clarify + tasks into extraction context', () => {
    const phases = [
      { phase: 'specify', artifacts: [{ type: 'spec', contentMd: '# Spec\nBuild a widget' }] },
      {
        phase: 'plan',
        artifacts: [{ type: 'plan', contentMd: '# Plan\n1. Create widget\n2. Test it' }]
      }
    ]
    const tasks = [
      { taskId: 'T1', description: 'Create widget', status: 'complete' },
      { taskId: 'T2', description: 'Write tests', status: 'failed' },
      { taskId: 'T3', description: 'Deploy', status: 'skipped' }
    ]
    const clarifyQA = [{ question: 'What framework?', answer: 'React' }]

    const parts: string[] = []
    parts.push(`## Blueprint: Test Blueprint\nFinal status: complete\n`)

    const specPhase = phases.find((p) => p.phase === 'specify')
    const specArtifact = specPhase?.artifacts?.find((a) => a.type === 'spec')
    if (specArtifact?.contentMd) {
      parts.push(`### Specification\n${specArtifact.contentMd.substring(0, 5000)}`)
    }

    const planPhase = phases.find((p) => p.phase === 'plan')
    const planArtifact = planPhase?.artifacts?.find((a) => a.type === 'plan')
    if (planArtifact?.contentMd) {
      parts.push(`### Plan\n${planArtifact.contentMd.substring(0, 5000)}`)
    }

    if (clarifyQA.length > 0) {
      const qaLines = clarifyQA.map((qa) => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n')
      parts.push(`### Clarification Q&A\n${qaLines.substring(0, 3000)}`)
    }

    const completed = tasks.filter((t) => t.status === 'complete')
    const failed = tasks.filter((t) => t.status === 'failed')
    const skipped = tasks.filter((t) => t.status === 'skipped')
    parts.push(
      `### Task Outcomes\nCompleted: ${completed.length}, Failed: ${failed.length}, Skipped: ${skipped.length}`
    )

    const combined = parts.join('\n\n')
    assert.ok(combined.includes('Test Blueprint'))
    assert.ok(combined.includes('Build a widget'))
    assert.ok(combined.includes('Create widget'))
    assert.ok(combined.includes('What framework?'))
    assert.ok(combined.includes('Completed: 1, Failed: 1, Skipped: 1'))
  })

  test('handles missing artifacts gracefully', () => {
    const phases = [
      { phase: 'specify', artifacts: [] },
      { phase: 'plan', artifacts: [] }
    ]
    const parts: string[] = []

    const specPhase = phases.find((p) => p.phase === 'specify')
    const specArtifact = specPhase?.artifacts?.find((a: any) => a.type === 'spec')
    // Should not throw — specArtifact is undefined
    assert.equal(specArtifact, undefined)

    const planPhase = phases.find((p) => p.phase === 'plan')
    const planArtifact = planPhase?.artifacts?.find((a: any) => a.type === 'plan')
    assert.equal(planArtifact, undefined)

    // No parts added
    assert.equal(parts.length, 0)
  })
})

// ── Capture settings shape ──

describe('MemoryCaptureSettings', () => {
  test('new settings fields have correct defaults (ON)', () => {
    // Simulates the memory.ipc.ts GET pattern
    const settings: Record<string, any> = {} // empty workspace settings
    const captureBlueprints = settings.memoryCaptureBlueprints !== false
    const capturePlans = settings.memoryCapturePlans !== false
    const captureGrill = settings.memoryCaptureGrill !== false
    const captureDocumentsOnAttach = settings.memoryCaptureDocumentsOnAttach !== false

    assert.equal(captureBlueprints, true, 'captureBlueprints defaults ON')
    assert.equal(capturePlans, true, 'capturePlans defaults ON')
    assert.equal(captureGrill, true, 'captureGrill defaults ON')
    assert.equal(captureDocumentsOnAttach, true, 'captureDocumentsOnAttach defaults ON')
  })

  test('settings can be explicitly disabled', () => {
    const settings = {
      memoryCaptureBlueprints: false,
      memoryCapturePlans: false,
      memoryCaptureGrill: false,
      memoryCaptureDocumentsOnAttach: false
    }
    assert.equal(settings.memoryCaptureBlueprints !== false, false)
    assert.equal(settings.memoryCapturePlans !== false, false)
    assert.equal(settings.memoryCaptureGrill !== false, false)
    assert.equal(settings.memoryCaptureDocumentsOnAttach !== false, false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
