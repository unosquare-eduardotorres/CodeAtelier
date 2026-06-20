/**
 * Unit tests for services/skill-prompt-composer.ts — skill filtering,
 * relevance scoring, section extraction, and content budgeting.
 *
 * filterAssignedSkills is fully pure. buildSkillContent uses synthetic Skill[]
 * objects. Private methods tested via (any) cast.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { SkillPromptComposer } from '../skill-prompt-composer'
import type { Skill } from '../../../shared/types'

const composer = new SkillPromptComposer()

function makeSkill(overrides: Partial<Skill> & { id: string; name: string }): Skill {
  return {
    filename: overrides.name.toLowerCase().replace(/\s/g, '-') + '.md',
    filePath: `/skills/${overrides.name.toLowerCase()}/SKILL.md`,
    isActive: true,
    tier1Json: null,
    tier2Instructions: null,
    ...overrides
  } as Skill
}

// ── filterAssignedSkills ──

describe('SkillPromptComposer.filterAssignedSkills', () => {
  const skills: Skill[] = [
    makeSkill({ id: 'react-hooks', name: 'React Hooks' }),
    makeSkill({ id: 'electron-ipc', name: 'Electron IPC' }),
    makeSkill({ id: 'tailwind-css', name: 'Tailwind CSS' })
  ]

  test('no overrides → returns all skills (passthrough)', () => {
    const result = composer.filterAssignedSkills(skills)
    assert.equal(result.length, 3)
  })

  test('undefined overrides → passthrough', () => {
    const result = composer.filterAssignedSkills(skills, undefined)
    assert.equal(result.length, 3)
  })

  test('empty overrides → empty result', () => {
    const result = composer.filterAssignedSkills(skills, [])
    assert.equal(result.length, 0)
  })

  test('filters by skill id (case-insensitive)', () => {
    const result = composer.filterAssignedSkills(skills, ['React-Hooks'])
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'react-hooks')
  })

  test('filters by skill name (case-insensitive)', () => {
    const result = composer.filterAssignedSkills(skills, ['electron ipc'])
    assert.equal(result.length, 1)
    assert.equal(result[0].name, 'Electron IPC')
  })

  test('filters by skill filename (case-insensitive)', () => {
    const result = composer.filterAssignedSkills(skills, ['tailwind-css.md'])
    assert.equal(result.length, 1)
    assert.equal(result[0].id, 'tailwind-css')
  })

  test('multiple overrides match multiple skills', () => {
    const result = composer.filterAssignedSkills(skills, ['react-hooks', 'tailwind-css'])
    assert.equal(result.length, 2)
  })

  test('trims whitespace in overrides', () => {
    const result = composer.filterAssignedSkills(skills, ['  react-hooks  '])
    assert.equal(result.length, 1)
  })

  test('empty strings in overrides are ignored', () => {
    const result = composer.filterAssignedSkills(skills, ['', '  ', 'react-hooks'])
    assert.equal(result.length, 1)
  })
})

// ── skillRelevanceScore (private, via any) ──

describe('SkillPromptComposer.skillRelevanceScore (private)', () => {
  test('returns 0 when no keywords match', () => {
    const skill = makeSkill({ id: 'react', name: 'React Hooks' })
    const score = (composer as any).skillRelevanceScore(skill, 'database migration')
    assert.equal(score, 0)
  })

  test('returns >0 when name-derived keywords match', () => {
    const skill = makeSkill({ id: 'react', name: 'React Hooks' })
    const score = (composer as any).skillRelevanceScore(skill, 'implement react hooks pattern')
    assert.ok(score > 0)
  })

  test('uses tier1Json keywords when available', () => {
    const skill = makeSkill({
      id: 'electron',
      name: 'Electron',
      tier1Json: JSON.stringify({ keywords: ['ipc', 'main-process', 'preload'] })
    })
    const score = (composer as any).skillRelevanceScore(skill, 'fix the ipc handler in main-process')
    assert.ok(score >= 2, `expected score >= 2 for two keyword matches, got ${score}`)
  })

  test('malformed tier1Json falls back to empty keywords', () => {
    const skill = makeSkill({
      id: 'broken',
      name: 'Broken',
      tier1Json: 'not valid json'
    })
    const score = (composer as any).skillRelevanceScore(skill, 'anything')
    assert.equal(score, 0)
  })
})

// ── extractSkillSections (private, via any) ──

describe('SkillPromptComposer.extractSkillSections (private)', () => {
  test('preserves complete sections within budget', () => {
    const content = `Preamble text.\n\n## Section A\nContent A\n\n## Section B\nContent B`
    const result = (composer as any).extractSkillSections(content, 5000)
    assert.ok(result.includes('Section A'))
    assert.ok(result.includes('Section B'))
  })

  test('truncates when content exceeds budget', () => {
    const content = `## Short\nBrief.\n\n## Long\n${'x'.repeat(500)}`
    const result = (composer as any).extractSkillSections(content, 100)
    assert.ok(result.includes('Short'))
    // Should have a truncation marker
    assert.ok(result.includes('[...'))
  })

  test('no sections → raw substring + truncated', () => {
    const content = 'Just plain text without any headings, ' + 'y'.repeat(200)
    const result = (composer as any).extractSkillSections(content, 50)
    assert.ok(result.length <= 80) // budget + truncation marker
    assert.ok(result.includes('[... truncated]'))
  })

  test('preserves preamble before first heading', () => {
    const content = `Intro paragraph.\n\n## Heading\nBody.`
    const result = (composer as any).extractSkillSections(content, 5000)
    assert.ok(result.includes('Intro paragraph'))
    assert.ok(result.includes('Heading'))
  })
})

// ── buildSkillContent ──

describe('SkillPromptComposer.buildSkillContent', () => {
  test('all inactive skills → empty string', () => {
    const skills = [makeSkill({ id: 'a', name: 'A', isActive: false })]
    const result = composer.buildSkillContent(skills)
    assert.equal(result, '')
  })

  test('empty skills array → empty string', () => {
    assert.equal(composer.buildSkillContent([]), '')
  })

  test('with taskContext and no matching skills → empty string', () => {
    const skills = [
      makeSkill({
        id: 'react',
        name: 'React Hooks',
        tier1Json: JSON.stringify({ keywords: ['react', 'hooks'] })
      })
    ]
    const result = composer.buildSkillContent(skills, 'standard', 'deploy kubernetes cluster')
    assert.equal(result, '')
  })

  test('minimal budget uses tier2Instructions when available', () => {
    const skills = [
      makeSkill({
        id: 'ts',
        name: 'TypeScript',
        tier2Instructions: 'Use strict mode. Prefer interfaces over types.'
      })
    ]
    const result = composer.buildSkillContent(skills, 'minimal')
    assert.ok(result.includes('TypeScript'))
    assert.ok(result.includes('Use strict mode'))
  })

  test('hard cap at 4000 chars', () => {
    const skills = [
      makeSkill({
        id: 'big',
        name: 'Big Skill',
        tier2Instructions: 'x'.repeat(5000)
      })
    ]
    const result = composer.buildSkillContent(skills, 'full')
    assert.ok(result.length <= 4100, `expected <= 4100 chars, got ${result.length}`)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
