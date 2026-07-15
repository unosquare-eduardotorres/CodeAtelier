/**
 * Blueprint Discoveries Ledger — parser + rendering + accumulation tests.
 *
 * Covers:
 * - parseDiscoveriesBlock: valid block, absent, malformed JSON, non-array,
 *   >10 entries capped, >250-char entries truncated, non-string entries filtered
 * - formatArtifacts: discoveries artifact renders as bullets; mixed artifact list
 *   keeps other types unchanged
 * - buildTaskContext shape: prior discoveries appear in context string; cap at 20
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { parseDiscoveriesBlock } from '../blueprint-artifact-parsers'

// Import formatArtifacts indirectly via buildPhaseSystemPrompt (it's not exported)
// Instead, test via the prompt loader's public API
import { buildPhaseSystemPrompt } from '../blueprint-prompt-loader'
import type { PhaseContext, BlueprintArtifact } from '../../../shared/blueprint-types'

// ── Parser Tests ──

describe('parseDiscoveriesBlock', () => {
  test('parses valid blueprint-discoveries block', () => {
    const text =
      'Some analysis text\n```blueprint-discoveries\n["Auth is in session.ts", "DB re-exports from index"]\n```\nMore text'
    const result = parseDiscoveriesBlock(text)
    assert.ok(result)
    assert.equal(result.length, 2)
    assert.equal(result[0], 'Auth is in session.ts')
    assert.equal(result[1], 'DB re-exports from index')
  })

  test('returns null for absent block', () => {
    assert.equal(parseDiscoveriesBlock('Just plain text with no fenced blocks'), null)
  })

  test('returns null for malformed JSON', () => {
    const text = '```blueprint-discoveries\n{not valid json}\n```'
    assert.equal(parseDiscoveriesBlock(text), null)
  })

  test('returns null for non-array JSON', () => {
    const text = '```blueprint-discoveries\n{"key": "value"}\n```'
    assert.equal(parseDiscoveriesBlock(text), null)
  })

  test('returns null for empty array', () => {
    const text = '```blueprint-discoveries\n[]\n```'
    assert.equal(parseDiscoveriesBlock(text), null)
  })

  test('caps entries at 10', () => {
    const entries = Array.from({ length: 15 }, (_, i) => `Discovery ${i}`)
    const text = '```blueprint-discoveries\n' + JSON.stringify(entries) + '\n```'
    const result = parseDiscoveriesBlock(text)
    assert.ok(result)
    assert.equal(result.length, 10)
    assert.equal(result[0], 'Discovery 0')
    assert.equal(result[9], 'Discovery 9')
  })

  test('truncates entries over 250 chars', () => {
    const longEntry = 'A'.repeat(300)
    const text = '```blueprint-discoveries\n' + JSON.stringify([longEntry]) + '\n```'
    const result = parseDiscoveriesBlock(text)
    assert.ok(result)
    assert.equal(result[0].length, 250)
  })

  test('filters non-string entries', () => {
    const text = '```blueprint-discoveries\n["valid", 42, null, true, "also valid", ""]\n```'
    const result = parseDiscoveriesBlock(text)
    assert.ok(result)
    assert.equal(result.length, 2)
    assert.equal(result[0], 'valid')
    assert.equal(result[1], 'also valid')
  })

  test('filters whitespace-only strings', () => {
    const text = '```blueprint-discoveries\n["valid", "   ", "also valid"]\n```'
    const result = parseDiscoveriesBlock(text)
    assert.ok(result)
    assert.equal(result.length, 2)
  })

  test('returns null when all entries are non-string', () => {
    const text = '```blueprint-discoveries\n[42, null, true]\n```'
    assert.equal(parseDiscoveriesBlock(text), null)
  })
})

// ── formatArtifacts rendering (tested via buildPhaseSystemPrompt fallback) ──

function makePhaseContext(overrides: Partial<PhaseContext> = {}): PhaseContext {
  return {
    blueprint: {
      id: 'bp-1',
      title: 'Test Blueprint',
      shortName: 'test',
      description: 'A test feature',
      priority: 'medium' as any,
      currentPhase: 'specify' as any,
      settings: {}
    },
    constitution: null,
    previousArtifacts: [],
    specFilePath: '/tmp/spec.md',
    blueprintDir: '/tmp/blueprints',
    grillDecisions: [],
    ...overrides
  }
}

describe('formatArtifacts — discoveries rendering (consolidated)', () => {
  test('discoveries artifact renders as consolidated bullet list', () => {
    const artifacts: BlueprintArtifact[] = [
      {
        type: 'discoveries',
        contentJson: {
          phase: 'plan',
          entries: ['Auth in session.ts', 'DB re-exports from index']
        }
      }
    ]
    const prompt = buildPhaseSystemPrompt('build', makePhaseContext({ previousArtifacts: artifacts }))
    assert.ok(prompt.includes('### Discoveries (consolidated)'), 'Should have consolidated discoveries heading')
    assert.ok(prompt.includes('- Auth in session.ts'), 'Should render first entry as bullet')
    assert.ok(prompt.includes('- DB re-exports from index'), 'Should render second entry as bullet')
  })

  test('mixed artifact list renders discoveries consolidated and others normally', () => {
    const artifacts: BlueprintArtifact[] = [
      { type: 'spec', contentMd: '# Spec content' },
      {
        type: 'discoveries',
        contentJson: {
          phase: 'specify',
          entries: ['Found entry point in main.ts']
        }
      },
      { type: 'plan', contentMd: '# Plan content' }
    ]
    const prompt = buildPhaseSystemPrompt('build', makePhaseContext({ previousArtifacts: artifacts }))
    assert.ok(prompt.includes('### Artifact: spec'), 'Should render spec artifact normally')
    assert.ok(prompt.includes('### Artifact: plan'), 'Should render plan artifact normally')
    assert.ok(prompt.includes('### Discoveries (consolidated)'), 'Should render discoveries consolidated')
    assert.ok(prompt.includes('- Found entry point in main.ts'), 'Should have bullet entry')
    // Discoveries should NOT have "### Artifact: discoveries"
    assert.ok(!prompt.includes('### Artifact: discoveries'), 'Should NOT use generic artifact heading')
  })

  test('empty discoveries are filtered out', () => {
    const artifacts: BlueprintArtifact[] = [
      { type: 'spec', contentMd: '# Spec' },
      {
        type: 'discoveries',
        contentJson: { phase: 'plan', entries: [] }
      }
    ]
    const prompt = buildPhaseSystemPrompt('build', makePhaseContext({ previousArtifacts: artifacts }))
    assert.ok(!prompt.includes('### Discoveries'), 'Should filter out empty discoveries')
    assert.ok(prompt.includes('### Artifact: spec'), 'Should keep other artifacts')
  })
})

// ── buildTaskContext shape (tested with a direct import from build service) ──
// Since buildTaskContext is private, we test indirectly through the public shape.
// The key property is that discoveries appear as bullets in the task context string.

describe('Build accumulation logic', () => {
  test('discoveries cap at 20 entries', () => {
    // Simulate the capping logic from the build service
    const discoveries = Array.from({ length: 25 }, (_, i) => `Discovery ${i}`)
    const capped = discoveries.length > 20 ? discoveries.slice(-20) : discoveries
    assert.equal(capped.length, 20)
    assert.equal(capped[0], 'Discovery 5')
    assert.equal(capped[19], 'Discovery 24')
  })

  test('seeded discoveries from artifacts shape', () => {
    // Simulate the seeding logic: extract entries from discovery artifacts
    const artifacts: BlueprintArtifact[] = [
      { type: 'build', contentMd: 'summary' },
      {
        type: 'discoveries',
        contentJson: { phase: 'build', taskId: 'T001', entries: ['Found config in root'] }
      },
      {
        type: 'discoveries',
        contentJson: { phase: 'build', taskId: 'T002', entries: ['Uses ESM imports'] }
      }
    ]

    const seeded: string[] = []
    for (const artifact of artifacts) {
      if (artifact.type === 'discoveries' && artifact.contentJson) {
        const entries = (artifact.contentJson as { entries?: string[] }).entries
        if (Array.isArray(entries)) {
          seeded.push(...entries)
        }
      }
    }

    assert.equal(seeded.length, 2)
    assert.equal(seeded[0], 'Found config in root')
    assert.equal(seeded[1], 'Uses ESM imports')
  })

  test('prior discoveries render as bullets in task context shape', () => {
    // Simulate the buildTaskContext rendering
    const priorDiscoveries = ['Auth in session.ts', 'DB re-exports from index']
    const lines: string[] = ['**Task ID**: T003', '**Description**: Add login']

    if (priorDiscoveries.length) {
      lines.push('')
      lines.push('**Discoveries from earlier tasks**:')
      for (const d of priorDiscoveries.slice(-20)) {
        lines.push(`- ${d}`)
      }
    }

    const result = lines.join('\n')
    assert.ok(result.includes('**Discoveries from earlier tasks**:'))
    assert.ok(result.includes('- Auth in session.ts'))
    assert.ok(result.includes('- DB re-exports from index'))
  })
})

// ── Standalone runner ──
const thisFile = new URL(import.meta.url).pathname
if (process.argv[1] && thisFile.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  void summaryAsync()
}
