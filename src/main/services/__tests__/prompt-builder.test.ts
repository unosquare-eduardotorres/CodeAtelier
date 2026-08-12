/**
 * Unit tests for services/prompt-builder.ts — pure static/instance methods
 * that don't require filesystem or DB access.
 *
 * Covers:
 *  - getGeneralistBudgetTierForTurn (turn→budget mapping)
 *  - getGeneralistConditionalSections (regex trigger classification)
 *  - PromptBuilder.estimateTokens (static, ~chars/3.5)
 *  - PromptBuilder.checkPromptSize (ok/warn/exceed for model budgets)
 *  - TOKEN_BUDGETS structure
 *  - buildLocalPlanDirective (tool budgets per context tier)
 *  - extractEssentialSections (private, access via any)
 *  - buildClaudeMdLayer with empty workspacePath → ''
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { PromptBuilder } from '../prompt-builder'

const builder = new PromptBuilder()

// ── getGeneralistBudgetTierForTurn ──

describe('PromptBuilder.getGeneralistBudgetTierForTurn', () => {
  test('turn 0 → full', () => {
    assert.equal(builder.getGeneralistBudgetTierForTurn(0), 'full')
  })

  test('turn 1 → full', () => {
    assert.equal(builder.getGeneralistBudgetTierForTurn(1), 'full')
  })

  test('turn 2 → standard', () => {
    assert.equal(builder.getGeneralistBudgetTierForTurn(2), 'standard')
  })

  test('turn 4 → standard', () => {
    assert.equal(builder.getGeneralistBudgetTierForTurn(4), 'standard')
  })

  test('turn 5 → minimal', () => {
    assert.equal(builder.getGeneralistBudgetTierForTurn(5), 'minimal')
  })

  test('turn 100 → minimal', () => {
    assert.equal(builder.getGeneralistBudgetTierForTurn(100), 'minimal')
  })
})

// ── getGeneralistConditionalSections ──

describe('PromptBuilder.getGeneralistConditionalSections', () => {
  test('question pattern triggers includeAskQuestionPrompt (full verbosity)', () => {
    const s = builder.getGeneralistConditionalSections('which option should I pick?', false, 'full')
    assert.equal(s.includeAskQuestionPrompt, true)
  })

  test('lean verbosity requires explicit option phrasing', () => {
    // "which" alone won't trigger in lean mode
    const s = builder.getGeneralistConditionalSections('which one works?', false, 'lean')
    assert.equal(s.includeAskQuestionPrompt, false)

    const s2 = builder.getGeneralistConditionalSections('what are my options here?', false, 'lean')
    assert.equal(s2.includeAskQuestionPrompt, true)
  })

  test('memory keywords trigger includeMemoryProtocolPrompt', () => {
    const s = builder.getGeneralistConditionalSections('remember that I prefer tabs', false)
    assert.equal(s.includeMemoryProtocolPrompt, true)
  })

  test('no memory keywords → includeMemoryProtocolPrompt false', () => {
    const s = builder.getGeneralistConditionalSections('what is 2+2?', false)
    assert.equal(s.includeMemoryProtocolPrompt, false)
  })

  test('hasImages → includeImageAttachmentsPrompt true', () => {
    const s = builder.getGeneralistConditionalSections('look at this', true)
    assert.equal(s.includeImageAttachmentsPrompt, true)
  })

  test('no images → includeImageAttachmentsPrompt false', () => {
    const s = builder.getGeneralistConditionalSections('look at this', false)
    assert.equal(s.includeImageAttachmentsPrompt, false)
  })

  test('short question triggers includeDirectAnswerBoost', () => {
    const s = builder.getGeneralistConditionalSections('what is the tech stack?', false)
    assert.equal(s.includeDirectAnswerBoost, true)
  })

  test('mutation request suppresses includeDirectAnswerBoost', () => {
    const s = builder.getGeneralistConditionalSections('implement a new login page', false)
    assert.equal(s.includeDirectAnswerBoost, false)
  })

  test('long messages (>=300 chars) suppress includeDirectAnswerBoost', () => {
    const longMsg = 'what is the purpose of ' + 'x'.repeat(300)
    const s = builder.getGeneralistConditionalSections(longMsg, false)
    assert.equal(s.includeDirectAnswerBoost, false)
  })

  test('non-question non-mutation → includeDirectAnswerBoost false', () => {
    const s = builder.getGeneralistConditionalSections('hello there', false)
    assert.equal(s.includeDirectAnswerBoost, false)
  })
})

// ── estimateTokens ──

describe('PromptBuilder.estimateTokens (static)', () => {
  test('estimates based on chars/3.5', () => {
    const text = 'a'.repeat(350) // 350/3.5 = 100
    assert.equal(PromptBuilder.estimateTokens(text), 100)
  })

  test('returns ceiling (conservative estimate)', () => {
    const text = 'ab' // 2/3.5 = 0.571 → ceil = 1
    assert.equal(PromptBuilder.estimateTokens(text), 1)
  })

  test('empty string → 0', () => {
    assert.equal(PromptBuilder.estimateTokens(''), 0)
  })
})

// ── TOKEN_BUDGETS ──

describe('PromptBuilder.TOKEN_BUDGETS', () => {
  test('haiku budget exists with warn < max', () => {
    const b = PromptBuilder.TOKEN_BUDGETS.haiku
    assert.ok(b)
    assert.ok(b.warn < b.max)
  })

  test('sonnet budget exists', () => {
    assert.ok(PromptBuilder.TOKEN_BUDGETS.sonnet)
  })

  test('opus budget exists with highest max', () => {
    const opus = PromptBuilder.TOKEN_BUDGETS.opus
    const haiku = PromptBuilder.TOKEN_BUDGETS.haiku
    assert.ok(opus.max > haiku.max)
  })
})

// ── checkPromptSize ──

describe('PromptBuilder.checkPromptSize (static)', () => {
  test('small prompt returns ok=true, no warning', () => {
    const result = PromptBuilder.checkPromptSize('hello', 'world', 'sonnet')
    assert.equal(result.ok, true)
    assert.equal(result.warning, undefined)
    assert.ok(result.estimatedTokens > 0)
  })

  test('prompt exceeding max returns ok=false with warning', () => {
    // sonnet max = 100_000 tokens → need ~350K chars
    const big = 'x'.repeat(360_000)
    const result = PromptBuilder.checkPromptSize(big, '', 'sonnet')
    assert.equal(result.ok, false)
    assert.ok(result.warning!.includes('exceeds'))
  })

  test('prompt in warning band returns ok=true with warning', () => {
    // sonnet warn = 60_000 → need ~210K chars; max = 100_000 → ~350K chars
    const medium = 'x'.repeat(220_000)
    const result = PromptBuilder.checkPromptSize(medium, '', 'sonnet')
    assert.equal(result.ok, true)
    assert.ok(result.warning!.includes('approaching'))
  })

  test('unknown model tier falls back to sonnet', () => {
    const result = PromptBuilder.checkPromptSize('hi', 'there', 'unknown-model')
    // Should use sonnet budget and succeed
    assert.equal(result.ok, true)
  })

  test('haiku has lower budgets than sonnet', () => {
    // Just above haiku max (~50K tokens → 175K chars)
    const aboveHaiku = 'x'.repeat(180_000)
    const haikuResult = PromptBuilder.checkPromptSize(aboveHaiku, '', 'haiku')
    const sonnetResult = PromptBuilder.checkPromptSize(aboveHaiku, '', 'sonnet')
    assert.equal(haikuResult.ok, false)
    assert.equal(sonnetResult.ok, true) // sonnet max is higher
  })
})

// ── buildLocalPlanDirective ──

describe('PromptBuilder.buildLocalPlanDirective', () => {
  test('small tier → 5 tool budget', () => {
    const directive = builder.buildLocalPlanDirective('small')
    assert.ok(directive.includes('Maximum 5 tool calls'))
    assert.ok(directive.includes('Plan Mode'))
  })

  test('medium tier → 8 tool budget', () => {
    const directive = builder.buildLocalPlanDirective('medium')
    assert.ok(directive.includes('Maximum 8 tool calls'))
  })

  test('large tier → 15 tool budget', () => {
    const directive = builder.buildLocalPlanDirective('large')
    assert.ok(directive.includes('Maximum 15 tool calls'))
  })

  test('includes strict workflow steps', () => {
    const directive = builder.buildLocalPlanDirective('small')
    assert.ok(directive.includes('PARSE'))
    assert.ok(directive.includes('LOCATE'))
    assert.ok(directive.includes('READ'))
    assert.ok(directive.includes('EMIT THE PLAN'))
  })
})

// ── extractEssentialSections (private, via any) ──

describe('PromptBuilder.extractEssentialSections (private)', () => {
  test('keeps sections with essential headers', () => {
    const prompt = `## Identity\nI am an agent.\n\n## Mode\nBuild mode.\n\n## Skills\nMany skills.`
    const result = (builder as any).extractEssentialSections(prompt)
    assert.ok(result.includes('Identity'))
    assert.ok(result.includes('Mode'))
    // Skills is not in essentialHeaders
    assert.ok(!result.includes('Skills'))
  })

  test('empty prompt → empty string', () => {
    const result = (builder as any).extractEssentialSections('')
    assert.equal(result, '')
  })

  test('keeps conventions and error handling', () => {
    const prompt = `## Conventions\nFollow these.\n\n## Error Handling\nDo this.`
    const result = (builder as any).extractEssentialSections(prompt)
    assert.ok(result.includes('Conventions'))
    assert.ok(result.includes('Error Handling'))
  })
})

// ── buildClaudeMdLayer ──

describe('PromptBuilder.buildClaudeMdLayer', () => {
  test('empty workspacePath returns empty string', () => {
    assert.equal(builder.buildClaudeMdLayer('', 'build'), '')
  })

  test('nonexistent path returns empty string (no CLAUDE.md)', () => {
    assert.equal(builder.buildClaudeMdLayer('/nonexistent/path/xyz', 'build'), '')
  })
})

// ── Instruction layer budget ──

/**
 * The instruction layer is prepended to every prompt. Uncapped it reached 12k
 * chars (~3.4k tokens) on a repo with several rule files, which is the kind of
 * cost nobody attributes to the right place. These pin the tier ceilings.
 */
describe('PromptBuilder instruction layer budget', () => {
  /** Workspace with enough rule-file bulk to exceed every tier budget. */
  function withRuleFiles(body: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'prompt-builder-instr-'))
    try {
      const filler = 'Always prefer the repository convention over personal taste. '.repeat(120)
      writeFileSync(join(root, 'AGENTS.md'), `# Agents\n\n${filler}`, 'utf-8')
      writeFileSync(join(root, '.clinerules'), `# Cline\n\n${filler}`, 'utf-8')
      writeFileSync(join(root, '.windsurfrules'), `# Windsurf\n\n${filler}`, 'utf-8')
      mkdirSync(join(root, '.cursor', 'rules'), { recursive: true })
      writeFileSync(join(root, '.cursor', 'rules', 'a.mdc'), `# A\n\n${filler}`, 'utf-8')
      writeFileSync(join(root, '.cursor', 'rules', 'b.mdc'), `# B\n\n${filler}`, 'utf-8')
      body(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  function layerFor(root: string, tier: 'minimal' | 'standard' | 'full'): string {
    // Private by design; the header of this file documents the `as any` access.
    return (builder as any).buildInstructionSourcesLayer(root, tier, [])
  }

  test('minimal tier contributes nothing', () => {
    withRuleFiles((root) => {
      assert.equal(layerFor(root, 'minimal'), '')
    })
  })

  test('standard tier is capped at 4k characters', () => {
    withRuleFiles((root) => {
      const layer = layerFor(root, 'standard')
      assert.ok(layer.length > 0, 'the layer should still carry some instructions')
      assert.ok(
        layer.length <= 4_000 + 200,
        `standard layer was ${layer.length} chars, expected ≤ ~4000`
      )
    })
  })

  test('full tier is allowed more than standard', () => {
    withRuleFiles((root) => {
      const full = layerFor(root, 'full')
      const standard = layerFor(root, 'standard')
      assert.ok(
        full.length > standard.length,
        `full (${full.length}) should exceed standard (${standard.length})`
      )
      assert.ok(full.length <= 12_000 + 200)
    })
  })

  test('the cache is keyed by tier, so tiers do not serve each other', () => {
    withRuleFiles((root) => {
      // Standard first: with a tier-agnostic key this would be cached and
      // handed straight back for the `full` request below.
      const standard = layerFor(root, 'standard')
      const full = layerFor(root, 'full')
      assert.notEqual(standard.length, full.length)

      // And the second read of the same tier is still the capped one.
      assert.equal(layerFor(root, 'standard').length, standard.length)
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
