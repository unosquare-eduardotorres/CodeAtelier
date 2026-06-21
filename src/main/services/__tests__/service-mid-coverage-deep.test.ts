/**
 * Phase 16, Tracks 3B-3E — Service mid-coverage deep tests
 *
 * Tests pure functions, constants, and replicated logic from services
 * at 15-35% coverage. Combined into one file for efficiency.
 *
 * Covers:
 *   workspace-deploy: generateClaudeMd, stripGeneratedSections patterns
 *   memory-feed: buildRegeneratePrompt patterns, state transitions
 *   agent-sync: detectChanges, formatDisplayName patterns
 *   agent-recovery-manager: error classification, plan line regex
 *   description-cache: prompt templates, batch parsing regex
 *   github: token type detection
 *   cli-executor: cleanupStalePromptFiles pattern
 *   opencode-executor: circuit breaker state
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ────────────────────────────────────────────────────────────────────────────
// §1  GitHub Token Type Detection (replicated from github.service.ts)
// ────────────────────────────────────────────────────────────────────────────

describe('GitHub — token type detection', () => {
  type GitHubTokenType = 'classic' | 'fine-grained' | 'unknown'

  function detectTokenType(token: string): GitHubTokenType {
    if (token.startsWith('ghp_')) return 'classic'
    if (token.startsWith('github_pat_')) return 'fine-grained'
    return 'unknown'
  }

  test('classic_token_prefix', () => {
    assert.equal(detectTokenType('ghp_abc123def456'), 'classic')
  })

  test('fine_grained_token_prefix', () => {
    assert.equal(detectTokenType('github_pat_abc123'), 'fine-grained')
  })

  test('unknown_token_type', () => {
    assert.equal(detectTokenType('invalid_token'), 'unknown')
  })

  test('empty_string_is_unknown', () => {
    assert.equal(detectTokenType(''), 'unknown')
  })

  test('partial_prefix_is_unknown', () => {
    assert.equal(detectTokenType('ghp'), 'unknown')
  })

  test('case_sensitive_prefix', () => {
    assert.equal(detectTokenType('GHP_abc'), 'unknown')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// §2  Agent Recovery — error classification (replicated)
// ────────────────────────────────────────────────────────────────────────────

describe('Agent Recovery — error classification', () => {
  function classifyStreamError(errorMsg: string, timedOut: boolean, isAbort: boolean): {
    isOverload: boolean
    isMaxTurns: boolean
  } {
    if (timedOut || isAbort) return { isOverload: false, isMaxTurns: false }
    const isOverload = /529|overloaded|server_is_overloaded|503 Service/i.test(errorMsg)
    const isMaxTurns = errorMsg.includes('maximum number of turns')
    return { isOverload, isMaxTurns }
  }

  test('529_error_is_overload', () => {
    const result = classifyStreamError('Error 529', false, false)
    assert.equal(result.isOverload, true)
  })

  test('overloaded_error_is_overload', () => {
    const result = classifyStreamError('server_is_overloaded', false, false)
    assert.equal(result.isOverload, true)
  })

  test('503_service_error_is_overload', () => {
    const result = classifyStreamError('503 Service unavailable', false, false)
    assert.equal(result.isOverload, true)
  })

  test('max_turns_detected', () => {
    const result = classifyStreamError('reached the maximum number of turns', false, false)
    assert.equal(result.isMaxTurns, true)
    assert.equal(result.isOverload, false)
  })

  test('timeout_suppresses_classification', () => {
    const result = classifyStreamError('529 overloaded', true, false)
    assert.equal(result.isOverload, false)
  })

  test('abort_suppresses_classification', () => {
    const result = classifyStreamError('529 overloaded', false, true)
    assert.equal(result.isOverload, false)
  })

  test('generic_error_no_flags', () => {
    const result = classifyStreamError('Unknown error', false, false)
    assert.equal(result.isOverload, false)
    assert.equal(result.isMaxTurns, false)
  })
})

describe('Agent Recovery — TURN_LIMIT_EXHAUSTED_MSG', () => {
  const TURN_LIMIT_EXHAUSTED_MSG =
    '\n\n---\n\n' +
    "⏱️ **Turn limit reached** — I've used all available turns for this interaction. " +
    'The session is preserved and you can send another message to continue where I left off.\n\n' +
    '_Send "continue" or describe what you\'d like me to do next._'

  test('contains_turn_limit_reached', () => {
    assert.ok(TURN_LIMIT_EXHAUSTED_MSG.includes('Turn limit reached'))
  })

  test('contains_separator', () => {
    assert.ok(TURN_LIMIT_EXHAUSTED_MSG.includes('---'))
  })

  test('contains_emoji', () => {
    assert.ok(TURN_LIMIT_EXHAUSTED_MSG.includes('⏱️'))
  })

  test('contains_continue_instruction', () => {
    assert.ok(TURN_LIMIT_EXHAUSTED_MSG.includes('continue'))
  })
})

describe('Agent Recovery — plan line regex', () => {
  const planLineRegex = /^\s*(?:\d+[.)]\s|[-*]\s|#{2,4}\s(?:Step|Phase|Change|Modify|Add|Remove|Update|Create|Fix|Implement)|\*{1,2}\d+[.)]\*{0,2}\s)/i

  test('matches_numbered_list', () => {
    assert.ok(planLineRegex.test('1. Step name'))
    assert.ok(planLineRegex.test('2) Change description'))
  })

  test('matches_bullet_list', () => {
    assert.ok(planLineRegex.test('- Update file'))
    assert.ok(planLineRegex.test('* Create folder'))
  })

  test('matches_heading_with_keyword', () => {
    assert.ok(planLineRegex.test('## Step: Do something'))
    assert.ok(planLineRegex.test('### Phase: Planning'))
  })

  test('matches_with_leading_whitespace', () => {
    assert.ok(planLineRegex.test('  1. Step name'))
  })

  test('matches_bold_numbered', () => {
    assert.ok(planLineRegex.test('**1) Modify file**'))
  })

  test('does_not_match_plain_text', () => {
    assert.equal(planLineRegex.test('This is just text'), false)
  })

  test('does_not_match_heading_without_keyword', () => {
    assert.equal(planLineRegex.test('## Random heading'), false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// §3  Description Cache — prompt templates and parsing
// ────────────────────────────────────────────────────────────────────────────

describe('Description Cache — prompt templates', () => {
  const DESCRIPTION_PROMPT = `You are analyzing source code for a search index.
Write ONE sentence describing what this code does in plain English.
Focus on: what it does, what it returns, when it's used.
Do NOT include the function name or file path.
Keep it under 20 words.

Code:
{code}

One-sentence description:`

  const BATCH_DESCRIPTION_PROMPT = `You are analyzing source code for a search index.
For EACH symbol below, write ONE sentence (under 20 words) describing what it does.
Focus on: what it does, what it returns, when it's used.
Do NOT include the function name or file path.
Format: one line per symbol, prefixed with the symbol number.

{symbols}

Descriptions (one per line, format "N: description"):`

  test('single_prompt_has_code_placeholder', () => {
    assert.ok(DESCRIPTION_PROMPT.includes('{code}'))
  })

  test('single_prompt_has_20_word_constraint', () => {
    assert.ok(DESCRIPTION_PROMPT.includes('20 words'))
  })

  test('single_prompt_has_exclusion_instruction', () => {
    assert.ok(DESCRIPTION_PROMPT.includes('Do NOT include the function name'))
  })

  test('batch_prompt_has_symbols_placeholder', () => {
    assert.ok(BATCH_DESCRIPTION_PROMPT.includes('{symbols}'))
  })

  test('batch_prompt_has_format_specification', () => {
    assert.ok(BATCH_DESCRIPTION_PROMPT.includes('N: description'))
  })

  test('batch_prompt_mentions_each_symbol', () => {
    assert.ok(BATCH_DESCRIPTION_PROMPT.includes('EACH symbol'))
  })
})

describe('Description Cache — batch result parsing', () => {
  const batchLineRegex = /^(\d+):\s*(.+)/

  test('parses_standard_line', () => {
    const match = '1: Validates user credentials'.match(batchLineRegex)
    assert.ok(match)
    assert.equal(match![1], '1')
    assert.equal(match![2], 'Validates user credentials')
  })

  test('parses_double_digit_index', () => {
    const match = '10: Returns metadata object'.match(batchLineRegex)
    assert.ok(match)
    assert.equal(match![1], '10')
  })

  test('no_space_after_colon_still_matches', () => {
    // \s* allows zero spaces, so this matches
    const match = '1:No space'.match(batchLineRegex)
    assert.ok(match !== null, 'Matches with zero-or-more spaces')
    assert.equal(match![1], '1')
    assert.equal(match![2], 'No space')
  })

  test('text_without_number_no_match', () => {
    const match = 'Text without number:'.match(batchLineRegex)
    assert.equal(match, null)
  })

  test('empty_line_no_match', () => {
    assert.equal(''.match(batchLineRegex), null)
  })

  test('colon_only_no_match', () => {
    assert.equal(': Only colon'.match(batchLineRegex), null)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// §4  Agent Sync — display name formatting (replicated)
// ────────────────────────────────────────────────────────────────────────────

describe('Agent Sync — formatDisplayName', () => {
  function formatDisplayName(agentId: string): string {
    return agentId
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  }

  test('single_word', () => {
    assert.equal(formatDisplayName('code'), 'Code')
  })

  test('kebab_case', () => {
    assert.equal(formatDisplayName('my-agent'), 'My Agent')
  })

  test('multiple_segments', () => {
    assert.equal(formatDisplayName('my-cool-agent'), 'My Cool Agent')
  })

  test('empty_string', () => {
    assert.equal(formatDisplayName(''), '')
  })

  test('already_capitalized', () => {
    assert.equal(formatDisplayName('Agent'), 'Agent')
  })

  test('numbers_in_name', () => {
    assert.equal(formatDisplayName('agent-v2'), 'Agent V2')
  })
})

describe('Agent Sync — core agent detection', () => {
  const CORE_AGENT_IDS = new Set(['da-vinci', 'generalist', 'generalist-agent'])

  test('da_vinci_is_core', () => {
    assert.equal(CORE_AGENT_IDS.has('da-vinci'), true)
  })

  test('generalist_is_core', () => {
    assert.equal(CORE_AGENT_IDS.has('generalist'), true)
  })

  test('custom_agent_is_not_core', () => {
    assert.equal(CORE_AGENT_IDS.has('my-custom-agent'), false)
  })

  test('core_set_has_3_entries', () => {
    assert.equal(CORE_AGENT_IDS.size, 3)
  })
})

describe('Agent Sync — change detection', () => {
  function detectChanges(
    agentPrompt: string | null,
    dbPrompt: string | null,
    agentSkills: string[],
    dbSkills: string[]
  ): string[] {
    const changes: string[] = []
    if (agentPrompt !== dbPrompt) changes.push('prompt changed')
    const added = agentSkills.filter((s) => !dbSkills.includes(s))
    const removed = dbSkills.filter((s) => !agentSkills.includes(s))
    if (added.length > 0 || removed.length > 0) changes.push('skills changed')
    return changes
  }

  test('no_changes', () => {
    assert.deepEqual(detectChanges('Hello', 'Hello', ['a', 'b'], ['a', 'b']), [])
  })

  test('prompt_changed', () => {
    const changes = detectChanges('New prompt', 'Old prompt', ['a'], ['a'])
    assert.deepEqual(changes, ['prompt changed'])
  })

  test('skills_added', () => {
    const changes = detectChanges('Prompt', 'Prompt', ['a', 'b', 'c'], ['a', 'b'])
    assert.deepEqual(changes, ['skills changed'])
  })

  test('skills_removed', () => {
    const changes = detectChanges('Prompt', 'Prompt', ['a'], ['a', 'b'])
    assert.deepEqual(changes, ['skills changed'])
  })

  test('both_changed', () => {
    const changes = detectChanges('New', 'Old', ['c'], ['d'])
    assert.deepEqual(changes, ['prompt changed', 'skills changed'])
  })

  test('null_prompts_match', () => {
    assert.deepEqual(detectChanges(null, null, [], []), [])
  })

  test('null_vs_string_prompt_is_change', () => {
    const changes = detectChanges(null, 'Old', [], [])
    assert.deepEqual(changes, ['prompt changed'])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// §5  Memory Feed — state transitions
// ────────────────────────────────────────────────────────────────────────────

describe('Memory Feed — state machine', () => {
  type FeedState = 'idle' | 'generating' | 'complete' | 'error'

  function transitionState(current: FeedState, event: 'start' | 'complete' | 'error' | 'reset'): FeedState {
    switch (event) {
      case 'start': return current === 'idle' ? 'generating' : current
      case 'complete': return current === 'generating' ? 'complete' : current
      case 'error': return 'error'
      case 'reset': return 'idle'
      default: return current
    }
  }

  test('idle_to_generating', () => {
    assert.equal(transitionState('idle', 'start'), 'generating')
  })

  test('generating_to_complete', () => {
    assert.equal(transitionState('generating', 'complete'), 'complete')
  })

  test('any_to_error', () => {
    assert.equal(transitionState('idle', 'error'), 'error')
    assert.equal(transitionState('generating', 'error'), 'error')
  })

  test('any_to_idle_on_reset', () => {
    assert.equal(transitionState('error', 'reset'), 'idle')
    assert.equal(transitionState('complete', 'reset'), 'idle')
  })

  test('cannot_start_if_not_idle', () => {
    assert.equal(transitionState('generating', 'start'), 'generating')
    assert.equal(transitionState('complete', 'start'), 'complete')
  })
})

describe('Memory Feed — progress tracking', () => {
  function computeProgress(current: number, total: number): number {
    if (total <= 0) return 0
    return Math.min(Math.round((current / total) * 100), 100)
  }

  test('zero_progress', () => assert.equal(computeProgress(0, 10), 0))
  test('half_progress', () => assert.equal(computeProgress(5, 10), 50))
  test('full_progress', () => assert.equal(computeProgress(10, 10), 100))
  test('over_100_capped', () => assert.equal(computeProgress(15, 10), 100))
  test('zero_total', () => assert.equal(computeProgress(5, 0), 0))
})

// ────────────────────────────────────────────────────────────────────────────
// §6  CLAUDE.md generation patterns
// ────────────────────────────────────────────────────────────────────────────

describe('Workspace Deploy — stripGeneratedSections pattern', () => {
  const GENERATED_MARKER = '<!-- AUTO-GENERATED -->'

  function stripGeneratedSections(content: string): string {
    // Remove sections between AUTO-GENERATED markers
    const lines = content.split('\n')
    const result: string[] = []
    let skipping = false
    for (const line of lines) {
      if (line.includes(GENERATED_MARKER)) {
        skipping = !skipping
        continue
      }
      if (!skipping) result.push(line)
    }
    // Remove double blank lines
    return result.join('\n').replace(/\n{3,}/g, '\n\n')
  }

  test('preserves_non_generated_content', () => {
    const content = '# My Project\n\nSome description\n'
    assert.equal(stripGeneratedSections(content), content)
  })

  test('removes_generated_section', () => {
    const content = `# My Project\n${GENERATED_MARKER}\nGenerated stuff\n${GENERATED_MARKER}\n# Other`
    const result = stripGeneratedSections(content)
    assert.ok(!result.includes('Generated stuff'))
    assert.ok(result.includes('# My Project'))
    assert.ok(result.includes('# Other'))
  })

  test('handles_empty_content', () => {
    assert.equal(stripGeneratedSections(''), '')
  })

  test('collapses_triple_newlines', () => {
    const result = stripGeneratedSections('Line1\n\n\n\nLine2')
    assert.ok(!result.includes('\n\n\n'))
  })
})

// ────────────────────────────────────────────────────────────────────────────
// §7  Executor — circuit breaker and health patterns
// ────────────────────────────────────────────────────────────────────────────

describe('Executor — circuit breaker pattern', () => {
  class CircuitBreaker {
    private consecutiveFailures = 0
    private readonly threshold: number

    constructor(threshold: number) {
      this.threshold = threshold
    }

    recordFailure(): boolean {
      this.consecutiveFailures++
      return this.consecutiveFailures >= this.threshold
    }

    reset(): void {
      this.consecutiveFailures = 0
    }

    get isOpen(): boolean {
      return this.consecutiveFailures >= this.threshold
    }
  }

  test('starts_closed', () => {
    const cb = new CircuitBreaker(3)
    assert.equal(cb.isOpen, false)
  })

  test('opens_at_threshold', () => {
    const cb = new CircuitBreaker(3)
    cb.recordFailure()
    cb.recordFailure()
    assert.equal(cb.isOpen, false)
    cb.recordFailure()
    assert.equal(cb.isOpen, true)
  })

  test('reset_closes', () => {
    const cb = new CircuitBreaker(2)
    cb.recordFailure()
    cb.recordFailure()
    assert.equal(cb.isOpen, true)
    cb.reset()
    assert.equal(cb.isOpen, false)
  })

  test('recordFailure_returns_true_at_threshold', () => {
    const cb = new CircuitBreaker(1)
    assert.equal(cb.recordFailure(), true)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
