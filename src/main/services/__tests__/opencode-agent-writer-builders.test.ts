/**
 * Unit tests for opencode-agent-writer-builders.ts — pure template builder functions.
 *
 * Covers: buildPermissionBlock, calculateAgentTurns, buildProviderOptions,
 * buildDaVinciContent, buildSpecialistContent.
 *
 * Phase 4A — ~20 tests. All pure logic, no FS dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  buildPermissionBlock,
  calculateAgentTurns,
  buildProviderOptions,
  buildDaVinciContent,
  buildSpecialistContent
} from '../opencode-agent-writer-builders'

// ── buildPermissionBlock ──

describe('buildPermissionBlock', () => {
  test('build mode → full allow with task: allow', () => {
    const result = buildPermissionBlock('build')
    assert.ok(result.includes('Write: allow'))
    assert.ok(result.includes('Edit: allow'))
    assert.ok(result.includes('Bash: allow'))
    assert.ok(result.includes('task: allow'))
  })

  test('plan mode → ask + task: deny', () => {
    const result = buildPermissionBlock('plan')
    assert.ok(result.includes('Write: ask'))
    assert.ok(result.includes('Edit: ask'))
    assert.ok(result.includes('Bash: ask'))
    assert.ok(result.includes('task: deny'))
  })

  test('danger mode → full allow (same as build)', () => {
    const result = buildPermissionBlock('danger')
    assert.ok(result.includes('Write: allow'))
    assert.ok(result.includes('task: allow'))
  })
})

// ── calculateAgentTurns ──

describe('calculateAgentTurns', () => {
  test('build mode with no explicit maxTurns → defaults to 50/50', () => {
    const result = calculateAgentTurns(undefined, 'build')
    assert.equal(result.maxTurns, 50)
    assert.equal(result.steps, 50)
  })

  test('plan mode with no explicit maxTurns → defaults to 30/30', () => {
    const result = calculateAgentTurns(undefined, 'plan')
    assert.equal(result.maxTurns, 30)
    assert.equal(result.steps, 30)
  })

  test('explicit maxTurns in build mode → both maxTurns and steps equal', () => {
    const result = calculateAgentTurns(80, 'build')
    assert.equal(result.maxTurns, 80)
    assert.equal(result.steps, 80)
  })

  test('explicit large maxTurns in plan mode → steps capped at 30', () => {
    const result = calculateAgentTurns(100, 'plan')
    assert.equal(result.maxTurns, 100)
    assert.equal(result.steps, 30)
  })

  test('explicit small maxTurns in plan mode → steps equal to maxTurns', () => {
    const result = calculateAgentTurns(10, 'plan')
    assert.equal(result.maxTurns, 10)
    assert.equal(result.steps, 10)
  })
})

// ── buildProviderOptions ──

describe('buildProviderOptions', () => {
  test('anthropic + plan → budgetTokens 16000', () => {
    const result = buildProviderOptions('anthropic', 'plan')
    assert.ok(result.includes('thinking:'), 'should include thinking block')
    assert.ok(result.includes('type: enabled'), 'should enable thinking')
    assert.ok(result.includes('budgetTokens: 16000'), 'plan mode → 16K budget')
  })

  test('anthropic + build → budgetTokens 32000', () => {
    const result = buildProviderOptions('anthropic', 'build')
    assert.ok(result.includes('budgetTokens: 32000'), 'build mode → 32K budget')
  })

  test('anthropic + danger → budgetTokens 32000 (same as build)', () => {
    const result = buildProviderOptions('anthropic', 'danger')
    assert.ok(result.includes('budgetTokens: 32000'), 'danger mode → 32K budget')
  })

  test('openai + plan → reasoningEffort medium', () => {
    const result = buildProviderOptions('openai', 'plan')
    assert.ok(result.includes('reasoningEffort: medium'))
  })

  test('openai + build → reasoningEffort high', () => {
    const result = buildProviderOptions('openai', 'build')
    assert.ok(result.includes('reasoningEffort: high'))
  })

  // 0.6, not 0.5 -- opencode-agent-writer-builders.ts:76. It has been 0.6 since
  // the line was introduced; the 0.5 these asserted never shipped.
  test('ollama → temperature 0.6', () => {
    const result = buildProviderOptions('ollama', 'build')
    assert.ok(result.includes('temperature: 0.6'))
  })

  test('omlx → temperature 0.6', () => {
    const result = buildProviderOptions('omlx', 'plan')
    assert.ok(result.includes('temperature: 0.6'))
  })

  test('unknown provider → no provider-specific lines but still has tool restrictions', () => {
    const result = buildProviderOptions('google', 'build')
    assert.ok(result.includes('tools:'))
    assert.ok(result.includes('question: false'))
    assert.ok(!result.includes('thinking:'))
    assert.ok(!result.includes('reasoningEffort:'))
    assert.ok(!result.includes('temperature:'))
  })

  test('all providers include tools question: false', () => {
    for (const provider of ['anthropic', 'openai', 'ollama', 'omlx', 'google']) {
      const result = buildProviderOptions(provider, 'build')
      assert.ok(
        result.includes('tools:') && result.includes('question: false'),
        `${provider} should disable question tool`
      )
    }
  })
})

// ── buildDaVinciContent ──

describe('buildDaVinciContent', () => {
  const baseOpts = {
    provider: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' } as any,
    mode: 'build' as const
  }

  test('contains YAML frontmatter with model string', () => {
    const content = buildDaVinciContent(baseOpts)
    assert.ok(content.startsWith('---\n'))
    assert.ok(content.includes('model: anthropic/claude-sonnet-4-6'))
    assert.ok(content.includes('name: davinci'))
  })

  test('contains maxTurns and steps interpolation', () => {
    const content = buildDaVinciContent({ ...baseOpts, maxTurns: 75 })
    assert.ok(content.includes('max_turns: 75'))
    assert.ok(content.includes('steps: 75'))
  })

  test('contains subagent section (GAP-18)', () => {
    const content = buildDaVinciContent(baseOpts)
    assert.ok(content.includes('Built-in Subagents'))
    assert.ok(content.includes('Scout'))
    assert.ok(content.includes('Explore'))
    assert.ok(content.includes('General'))
  })

  test('plan mode applies correct permission + steps cap', () => {
    const content = buildDaVinciContent({ ...baseOpts, mode: 'plan' })
    assert.ok(content.includes('Write: ask'))
    assert.ok(content.includes('task: deny'))
    assert.ok(content.includes('steps: 30'))
    assert.ok(content.includes('max_turns: 30'))
  })
})

// ── buildSpecialistContent ──

describe('buildSpecialistContent', () => {
  const baseOpts = {
    provider: { providerId: 'openai', modelId: 'gpt-5' } as any,
    mode: 'build' as const,
    specialistSystemPrompt: 'You are a React expert.',
    specialistName: 'React Expert'
  }

  test('includes specialist name in frontmatter and heading', () => {
    const content = buildSpecialistContent(baseOpts)
    assert.ok(content.includes('name: React Expert'))
    assert.ok(content.includes('# React Expert'))
  })

  test('falls back to "Project Specialist" when name is not provided', () => {
    const content = buildSpecialistContent({
      ...baseOpts,
      specialistName: undefined
    })
    assert.ok(content.includes('name: Project Specialist'))
    assert.ok(content.includes('# Project Specialist'))
  })

  test('injects specialistSystemPrompt into content', () => {
    const content = buildSpecialistContent(baseOpts)
    assert.ok(content.includes('You are a React expert.'))
  })

  test('falls back to default text when specialistSystemPrompt is undefined', () => {
    const content = buildSpecialistContent({
      ...baseOpts,
      specialistSystemPrompt: undefined
    })
    assert.ok(content.includes('No specialization prompt available.'))
  })

  test('has correct frontmatter shape (color, model, mode)', () => {
    const content = buildSpecialistContent(baseOpts)
    assert.ok(content.includes('model: openai/gpt-5'))
    assert.ok(content.includes('color: "#FF6B35"'))
    assert.ok(content.includes('mode: primary'))
  })

  test('contains tool constraints section', () => {
    const content = buildSpecialistContent(baseOpts)
    assert.ok(content.includes('Tool Usage Constraints'))
    assert.ok(content.includes('Read'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
