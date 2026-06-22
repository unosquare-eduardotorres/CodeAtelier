/**
 * Unit tests for specialist-builder-handlers.ts — pure-logic helpers
 * extracted from SpecialistBuilderService.
 *
 * Covers:
 * - fingerprintTechStack: determinism, sort invariance, empty list, collision avoidance
 * - formatEnabledSkillsList: full list, truncation, empty list, description omission
 * - buildSlotValues: all slots populated, missing fields
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  fingerprintTechStack,
  formatEnabledSkillsList,
  buildSlotValues
} from '../specialist-builder-handlers'

// ── fingerprintTechStack ──

describe('fingerprintTechStack', () => {
  test('produces deterministic output for same input', () => {
    const hash1 = fingerprintTechStack(['react', 'typescript', 'node'])
    const hash2 = fingerprintTechStack(['react', 'typescript', 'node'])
    assert.equal(hash1, hash2)
  })

  test('is sort-invariant — different order produces same hash', () => {
    const hash1 = fingerprintTechStack(['react', 'typescript', 'node'])
    const hash2 = fingerprintTechStack(['node', 'react', 'typescript'])
    assert.equal(hash1, hash2)
  })

  test('returns 16-char hex string', () => {
    const hash = fingerprintTechStack(['python', 'django'])
    assert.equal(hash.length, 16)
    assert.match(hash, /^[a-f0-9]{16}$/)
  })

  test('empty tech list produces a valid hash', () => {
    const hash = fingerprintTechStack([])
    assert.equal(hash.length, 16)
    assert.match(hash, /^[a-f0-9]{16}$/)
  })

  test('different tech lists produce different hashes', () => {
    const hash1 = fingerprintTechStack(['react', 'typescript'])
    const hash2 = fingerprintTechStack(['vue', 'javascript'])
    assert.notEqual(hash1, hash2)
  })

  test('does not mutate the input array', () => {
    const techs = ['zebra', 'alpha', 'middle']
    const copy = [...techs]
    fingerprintTechStack(techs)
    assert.deepEqual(techs, copy)
  })
})

// ── formatEnabledSkillsList ──

describe('formatEnabledSkillsList', () => {
  test('formats skills as bullet list with bold names', () => {
    const skills = [
      { name: 'react-pro', description: 'React expert skill' },
      { name: 'typescript-lint', description: 'TypeScript linting' }
    ]
    const result = formatEnabledSkillsList(skills)
    assert.ok(result.includes('- **react-pro** — React expert skill'))
    assert.ok(result.includes('- **typescript-lint** — TypeScript linting'))
  })

  test('omits description when null', () => {
    const skills = [{ name: 'bare-skill', description: null }]
    const result = formatEnabledSkillsList(skills)
    assert.equal(result, '- **bare-skill**')
    assert.ok(!result.includes('—'))
  })

  test('returns fallback message for empty skill list', () => {
    const result = formatEnabledSkillsList([])
    assert.equal(result, '(no skills enabled yet — enable from the Skills tab)')
  })

  test('truncates at budget and shows omission notice', () => {
    const skills = Array.from({ length: 20 }, (_, i) => ({
      name: `skill-${String(i).padStart(3, '0')}`,
      description: 'A skill that does something very useful and takes some space in the budget'
    }))
    // Use a tiny budget so truncation occurs early
    const result = formatEnabledSkillsList(skills, 200)
    assert.ok(result.includes('more skills omitted — budget cap reached'))
    // Should not include all 20 skills
    const lineCount = result.split('\n').length
    assert.ok(lineCount < 20, `Expected < 20 lines, got ${lineCount}`)
  })

  test('includes all skills when within budget', () => {
    const skills = [
      { name: 'a', description: 'short' },
      { name: 'b', description: 'short' }
    ]
    const result = formatEnabledSkillsList(skills, 4000)
    assert.ok(!result.includes('omitted'))
    assert.equal(result.split('\n').length, 2)
  })

  test('handles mix of null and non-null descriptions', () => {
    const skills = [
      { name: 'with-desc', description: 'Has a description' },
      { name: 'without-desc', description: null },
      { name: 'also-with', description: 'Another description' }
    ]
    const result = formatEnabledSkillsList(skills)
    const lines = result.split('\n')
    assert.ok(lines[0].includes('—'))
    assert.ok(!lines[1].includes('—'))
    assert.ok(lines[2].includes('—'))
  })
})

// ── buildSlotValues ──

describe('buildSlotValues', () => {
  test('returns correct shape with all slots populated', () => {
    const result = buildSlotValues('my-workspace', '- **skill-a** — description')
    assert.equal(result.workspaceName, 'my-workspace')
    assert.equal(result.enabledSkills, '- **skill-a** — description')
  })

  test('handles empty workspace name', () => {
    const result = buildSlotValues('', '(no skills enabled)')
    assert.equal(result.workspaceName, '')
    assert.equal(result.enabledSkills, '(no skills enabled)')
  })

  test('handles empty enabled skills', () => {
    const result = buildSlotValues('workspace', '')
    assert.equal(result.enabledSkills, '')
  })
})

// ── Standalone runner ──
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
