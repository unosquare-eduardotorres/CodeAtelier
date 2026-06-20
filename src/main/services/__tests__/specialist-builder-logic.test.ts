/**
 * Unit tests for SpecialistBuilderService — pure-logic methods.
 *
 * Covers:
 * - buildMetaPrompt: prompt assembly with tech stack, verbosity, skeleton
 *
 * The service itself (buildProjectSpecialist, runBuild) requires DB access,
 * so we only test the public pure methods.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { SpecialistBuilderService } from '../specialist-builder.service'

const builder = new SpecialistBuilderService()

// ── buildMetaPrompt ──

describe('SpecialistBuilderService.buildMetaPrompt', () => {
  test('includes workspace name', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'MyProject',
      detectedTechs: ['TypeScript', 'React'],
      claudeMdReference: 'some reference content',
      skeleton: 'skeleton content'
    })
    assert.ok(result.includes('MyProject'), 'should include workspace name')
  })

  test('includes detected tech stack', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'TestProject',
      detectedTechs: ['TypeScript', 'React', 'Node.js'],
      claudeMdReference: '',
      skeleton: ''
    })
    assert.ok(result.includes('TypeScript, React, Node.js'), 'should include tech list')
  })

  test('handles empty tech list with "(none detected)"', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'EmptyProject',
      detectedTechs: [],
      claudeMdReference: '',
      skeleton: ''
    })
    assert.ok(result.includes('(none detected)'), 'should show fallback for empty tech list')
  })

  test('includes CLAUDE.md reference content', () => {
    const reference = 'This is the CLAUDE.md content for the project.'
    const result = builder.buildMetaPrompt({
      workspaceName: 'Project',
      detectedTechs: ['Python'],
      claudeMdReference: reference,
      skeleton: ''
    })
    assert.ok(result.includes(reference), 'should include reference content')
  })

  test('includes skeleton content', () => {
    const skeleton = 'This is the skeleton template prompt.'
    const result = builder.buildMetaPrompt({
      workspaceName: 'Project',
      detectedTechs: ['Rust'],
      claudeMdReference: '',
      skeleton
    })
    assert.ok(result.includes(skeleton), 'should include skeleton content')
  })

  test('verbosity=lean sets 250 word limit', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'Project',
      detectedTechs: ['Go'],
      claudeMdReference: '',
      skeleton: '',
      verbosity: 'lean'
    })
    assert.ok(result.includes('250'), 'lean verbosity should mention 250 word limit')
  })

  test('verbosity=full sets 400 word limit', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'Project',
      detectedTechs: ['Go'],
      claudeMdReference: '',
      skeleton: '',
      verbosity: 'full'
    })
    assert.ok(result.includes('400'), 'full verbosity should mention 400 word limit')
  })

  test('default verbosity (undefined) uses 400 word limit', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'Project',
      detectedTechs: ['Go'],
      claudeMdReference: '',
      skeleton: ''
    })
    assert.ok(result.includes('400'), 'default should use 400 word limit')
  })

  test('includes required section headings', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'Project',
      detectedTechs: ['TypeScript'],
      claudeMdReference: '',
      skeleton: ''
    })
    assert.ok(result.includes('## Your identity'), 'should include identity section')
    assert.ok(result.includes('## Decision heuristics'), 'should include heuristics section')
    assert.ok(result.includes('## Architecture instincts'), 'should include architecture section')
    assert.ok(result.includes('## Output style'), 'should include output style section')
    assert.ok(result.includes('## Tool usage'), 'should include tool usage section')
  })

  test('includes HARD RULES', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'Project',
      detectedTechs: [],
      claudeMdReference: '',
      skeleton: ''
    })
    assert.ok(result.includes('HARD RULES'), 'should include hard rules section')
    assert.ok(result.includes('DO NOT list technologies'), 'should include anti-pattern rule')
  })

  test('includes DETECTED STACK label', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'Project',
      detectedTechs: ['Python', 'Django'],
      claudeMdReference: '',
      skeleton: ''
    })
    assert.ok(result.includes('DETECTED STACK:'), 'should have DETECTED STACK label')
  })

  test('includes CRITICAL LAYERING CONTEXT', () => {
    const result = builder.buildMetaPrompt({
      workspaceName: 'Project',
      detectedTechs: [],
      claudeMdReference: '',
      skeleton: ''
    })
    assert.ok(result.includes('CRITICAL LAYERING CONTEXT'), 'should include layering context')
  })
})

// ── BuildResult type shape ──

describe('SpecialistBuilderService — exports', () => {
  test('SpecialistBuilderService is constructable', () => {
    const instance = new SpecialistBuilderService()
    assert.ok(instance)
    assert.equal(typeof instance.buildMetaPrompt, 'function')
    assert.equal(typeof instance.buildProjectSpecialist, 'function')
    assert.equal(typeof instance.rebuildPrompt, 'function')
    assert.equal(typeof instance.rebuildSkills, 'function')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
