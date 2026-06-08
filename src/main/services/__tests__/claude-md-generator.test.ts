/**
 * Unit tests for claude-md-generator — tests the template fallback path
 * (the 0-decisions early return) which is deterministic and requires no CLI.
 *
 * The live LLM path (runOneShotClaude) is NOT tested here — the CLI is a real
 * binary and can't be easily stubbed at import-time. The goal-decomposer test
 * takes the monkey-patch-instance approach for its service class; this module
 * only exports top-level functions with a direct import of runOneShotClaude.
 *
 * All template-generation paths are fully covered through the 0-decision route.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { generateClaudeMd } from '../claude-md-generator'

describe('generateClaudeMd — template fallback (0 decisions)', () => {
  test('returns template with project name and description', () =>
    runExclusive(async () => {
      const result = await generateClaudeMd({
        projectName: 'TestProject',
        description: 'A test project for demonstration',
        grillDecisions: [],
        trackScores: []
      })
      assert.ok(result.includes('# Project: TestProject'))
      assert.ok(result.includes('A test project for demonstration'))
    }))

  test('template includes all standard sections', () =>
    runExclusive(async () => {
      const result = await generateClaudeMd({
        projectName: 'FullTemplate',
        description: 'Description here',
        grillDecisions: [],
        trackScores: []
      })
      assert.ok(result.includes('## Overview'))
      assert.ok(result.includes('## Tech Stack'))
      assert.ok(result.includes('## Conventions'))
      assert.ok(result.includes('## What NOT to do'))
      assert.ok(result.includes('## Key Commands'))
      // Conventions should include standard recommendations
      assert.ok(result.includes('TypeScript strict mode'))
      assert.ok(result.includes('ESLint'))
    }))

  test('empty description produces fallback text', () =>
    runExclusive(async () => {
      const result = await generateClaudeMd({
        projectName: 'EmptyDesc',
        description: '',
        grillDecisions: [],
        trackScores: []
      })
      assert.ok(result.includes('No description provided'))
    }))

  test('tech stack is TBD when no decisions provided', () =>
    runExclusive(async () => {
      const result = await generateClaudeMd({
        projectName: 'NoStack',
        description: 'Plain project',
        grillDecisions: [],
        trackScores: []
      })
      assert.ok(result.includes('TBD'))
    }))

  test('What NOT to do section includes security guidance', () =>
    runExclusive(async () => {
      const result = await generateClaudeMd({
        projectName: 'SecurityCheck',
        description: 'Check security',
        grillDecisions: [],
        trackScores: []
      })
      assert.ok(result.includes('Do not commit secrets'))
      assert.ok(result.includes('Do not skip error handling'))
    }))

  test('no Key Decisions section when decisions are empty', () =>
    runExclusive(async () => {
      const result = await generateClaudeMd({
        projectName: 'NoDecisions',
        description: 'Desc',
        grillDecisions: [],
        trackScores: []
      })
      assert.ok(!result.includes('Key Decisions'))
    }))
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
