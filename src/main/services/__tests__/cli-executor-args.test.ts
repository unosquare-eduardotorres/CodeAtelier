/**
 * Unit tests for cli-executor.ts — private `buildCLIArgs` method.
 *
 * Covers CLI flag construction from CLIExecuteOptions.
 * ⚠️ `systemPrompt` is intentionally omitted from test options to avoid
 * filesystem I/O from `writeSystemPromptFile`.
 *
 * All accessed via `(instance as any).buildCLIArgs(options)`.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { CLIExecutor } from '../cli-executor'

const executor = new CLIExecutor()

/** Minimal valid options (no systemPrompt → no FS I/O) */
function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'hello',
    model: 'claude-sonnet-4-6',
    cwd: '/tmp/workspace',
    permissionMode: 'default' as const,
    ...overrides
  }
}

// ── Core flags ──

describe('CLIExecutor.buildCLIArgs — core flags', () => {
  test('always includes stream-json, verbose, and skip-permissions flags', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts())
    assert.ok(args.includes('--output-format'), 'missing --output-format')
    assert.ok(args.includes('stream-json'), 'missing stream-json value')
    assert.ok(args.includes('--input-format'), 'missing --input-format')
    assert.ok(args.includes('--verbose'), 'missing --verbose')
    assert.ok(args.includes('--include-partial-messages'), 'missing --include-partial-messages')
    assert.ok(
      args.includes('--allow-dangerously-skip-permissions'),
      'missing --allow-dangerously-skip-permissions'
    )
  })

  test('output-format and input-format both set to stream-json', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts())
    const outputIdx = args.indexOf('--output-format')
    const inputIdx = args.indexOf('--input-format')
    assert.equal(args[outputIdx + 1], 'stream-json')
    assert.equal(args[inputIdx + 1], 'stream-json')
  })
})

// ── Model flag ──

describe('CLIExecutor.buildCLIArgs — model', () => {
  test('with model → includes --model flag', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ model: 'claude-opus-4-7' }))
    const idx = args.indexOf('--model')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'claude-opus-4-7')
  })

  test('without model → no --model flag', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ model: undefined }))
    assert.ok(!args.includes('--model'))
  })
})

// ── Permission mode ──

describe('CLIExecutor.buildCLIArgs — permission mode', () => {
  test('default mode → --permission-mode default', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ permissionMode: 'default' }))
    const idx = args.indexOf('--permission-mode')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'default')
  })

  test('plan mode → --permission-mode plan', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ permissionMode: 'plan' }))
    const idx = args.indexOf('--permission-mode')
    assert.equal(args[idx + 1], 'plan')
  })

  test('bypassPermissions → --permission-mode bypassPermissions', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ permissionMode: 'bypassPermissions' })
    )
    const idx = args.indexOf('--permission-mode')
    assert.equal(args[idx + 1], 'bypassPermissions')
  })

  test('auto mode → --permission-mode auto', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ permissionMode: 'auto' }))
    const idx = args.indexOf('--permission-mode')
    assert.equal(args[idx + 1], 'auto')
  })
})

// ── Resume ──

describe('CLIExecutor.buildCLIArgs — resume', () => {
  test('valid session ID → --resume included', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ resume: 'abc12345-def' })
    )
    const idx = args.indexOf('--resume')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'abc12345-def')
  })

  test('invalid session ID (too short) → --resume skipped', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ resume: 'ab' }))
    assert.ok(!args.includes('--resume'), 'short ID should be skipped')
  })

  test('session ID with special chars → --resume skipped', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ resume: 'abc!@#$%^&*' })
    )
    assert.ok(!args.includes('--resume'), 'special chars should be skipped')
  })
})

// ── Optional flags ──

describe('CLIExecutor.buildCLIArgs — optional flags', () => {
  test('maxTurns → --max-turns N', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ maxTurns: 25 }))
    const idx = args.indexOf('--max-turns')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], '25')
  })

  test('allowedTools → --allowedTools comma-joined', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ allowedTools: ['Read', 'Write', 'Bash'] })
    )
    const idx = args.indexOf('--allowedTools')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'Read,Write,Bash')
  })

  test('disallowedTools → --disallowedTools comma-joined', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ disallowedTools: ['Dangerous', 'Risky'] })
    )
    const idx = args.indexOf('--disallowedTools')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'Dangerous,Risky')
  })

  test('additionalDirectories → multiple --add-dir flags', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ additionalDirectories: ['/path/a', '/path/b'] })
    )
    const addDirIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === '--add-dir') acc.push(i)
      return acc
    }, [])
    assert.equal(addDirIndices.length, 2)
    assert.equal(args[addDirIndices[0] + 1], '/path/a')
    assert.equal(args[addDirIndices[1] + 1], '/path/b')
  })

  test('effort → --effort value', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ effort: 'high' }))
    const idx = args.indexOf('--effort')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'high')
  })

  test('betas → multiple --betas flags', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ betas: ['1m-context', 'experimental-flag'] })
    )
    const betaIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === '--betas') acc.push(i)
      return acc
    }, [])
    assert.equal(betaIndices.length, 2)
    assert.equal(args[betaIndices[0] + 1], '1m-context')
    assert.equal(args[betaIndices[1] + 1], 'experimental-flag')
  })

  test('fallbackModel → --fallback-model value', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ fallbackModel: 'claude-haiku-4-5' })
    )
    const idx = args.indexOf('--fallback-model')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'claude-haiku-4-5')
  })

  test('thinkingBudget > 0 → --thinking-budget N', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ thinkingBudget: 8000 })
    )
    const idx = args.indexOf('--thinking-budget')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], '8000')
  })

  test('thinkingBudget = 0 → skipped', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ thinkingBudget: 0 }))
    assert.ok(!args.includes('--thinking-budget'), 'thinkingBudget=0 should be skipped')
  })

  test('mcpConfigPath → --mcp-config path', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ mcpConfigPath: '/tmp/mcp.json' })
    )
    const idx = args.indexOf('--mcp-config')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], '/tmp/mcp.json')
  })

  test('resumeSessionAt → --resume-session-at value', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ resumeSessionAt: 'msg_abc123' })
    )
    const idx = args.indexOf('--resume-session-at')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'msg_abc123')
  })
})

// ── Absent optional flags ──

describe('CLIExecutor.buildCLIArgs — absent optionals produce no flags', () => {
  test('no optionals → only core flags present', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts())
    // Should NOT contain any of these optional flags
    assert.ok(!args.includes('--max-turns'))
    assert.ok(!args.includes('--allowedTools'))
    assert.ok(!args.includes('--disallowedTools'))
    assert.ok(!args.includes('--add-dir'))
    assert.ok(!args.includes('--effort'))
    assert.ok(!args.includes('--betas'))
    assert.ok(!args.includes('--fallback-model'))
    assert.ok(!args.includes('--thinking-budget'))
    assert.ok(!args.includes('--resume'))
    assert.ok(!args.includes('--resume-session-at'))
    assert.ok(!args.includes('--mcp-config'))
  })
})

// ── Additional permission modes ──

describe('CLIExecutor.buildCLIArgs — additional permission modes', () => {
  test('acceptEdits → --permission-mode acceptEdits', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ permissionMode: 'acceptEdits' }))
    const idx = args.indexOf('--permission-mode')
    assert.equal(args[idx + 1], 'acceptEdits')
  })

  test('dontAsk → --permission-mode dontAsk', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ permissionMode: 'dontAsk' }))
    const idx = args.indexOf('--permission-mode')
    assert.equal(args[idx + 1], 'dontAsk')
  })

  test('unknown permission mode → fallback to default', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ permissionMode: 'nonexistent' }))
    const idx = args.indexOf('--permission-mode')
    assert.equal(args[idx + 1], 'default')
  })
})

// ── Empty array edge cases ──

describe('CLIExecutor.buildCLIArgs — empty arrays', () => {
  test('empty allowedTools → no --allowedTools flag', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ allowedTools: [] }))
    assert.ok(!args.includes('--allowedTools'), 'empty array should not produce flag')
  })

  test('empty disallowedTools → no --disallowedTools flag', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ disallowedTools: [] }))
    assert.ok(!args.includes('--disallowedTools'), 'empty array should not produce flag')
  })

  test('empty additionalDirectories → no --add-dir flags', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ additionalDirectories: [] }))
    assert.ok(!args.includes('--add-dir'), 'empty array should not produce flag')
  })

  test('empty betas → no --betas flags', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ betas: [] }))
    assert.ok(!args.includes('--betas'), 'empty array should not produce flag')
  })
})

// ── Additional effort levels ──

describe('CLIExecutor.buildCLIArgs — effort levels', () => {
  test('effort: low → --effort low', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ effort: 'low' }))
    const idx = args.indexOf('--effort')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'low')
  })

  test('effort: medium → --effort medium', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ effort: 'medium' }))
    const idx = args.indexOf('--effort')
    assert.equal(args[idx + 1], 'medium')
  })

  test('effort: xhigh → --effort xhigh', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ effort: 'xhigh' }))
    const idx = args.indexOf('--effort')
    assert.equal(args[idx + 1], 'xhigh')
  })

  test('effort: max → --effort max', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ effort: 'max' }))
    const idx = args.indexOf('--effort')
    assert.equal(args[idx + 1], 'max')
  })
})

// ── Thinking budget edge cases ──

describe('CLIExecutor.buildCLIArgs — thinking budget edge cases', () => {
  test('thinkingBudget = 1 → --thinking-budget 1', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ thinkingBudget: 1 }))
    const idx = args.indexOf('--thinking-budget')
    assert.ok(idx >= 0, 'thinkingBudget=1 should produce flag')
    assert.equal(args[idx + 1], '1')
  })

  test('thinkingBudget = -100 → skipped (not > 0)', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ thinkingBudget: -100 }))
    assert.ok(!args.includes('--thinking-budget'), 'negative budget should be skipped')
  })
})

// ── Goal flag ──

describe('CLIExecutor.buildCLIArgs — goal flag', () => {
  test('goal set → --goal flag added', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ goal: 'Fix all failing tests and ensure CI passes' })
    )
    const idx = args.indexOf('--goal')
    assert.ok(idx >= 0, 'goal should produce --goal flag')
    assert.equal(args[idx + 1], 'Fix all failing tests and ensure CI passes')
  })

  test('goal undefined → no --goal flag', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts())
    assert.ok(!args.includes('--goal'), 'undefined goal should not produce flag')
  })

  test('goal empty string → --goal flag with empty value', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ goal: '' }))
    // Empty string is falsy, so no --goal flag
    assert.ok(!args.includes('--goal'), 'empty goal should not produce flag')
  })
})

// ── Combined flag edge cases ──

describe('CLIExecutor.buildCLIArgs — combined flags', () => {
  test('all optional flags set simultaneously → all present', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({
        model: 'claude-opus-4-7',
        maxTurns: 50,
        allowedTools: ['Read', 'Write'],
        disallowedTools: ['Bash'],
        additionalDirectories: ['/extra'],
        effort: 'xhigh',
        betas: ['1m-context'],
        fallbackModel: 'claude-haiku-4-5',
        thinkingBudget: 8000,
        mcpConfigPath: '/tmp/mcp.json',
        resumeSessionAt: 'msg_abc',
        resume: 'valid-session-id-123',
        goal: 'Complete all tasks'
      })
    )
    assert.ok(args.includes('--model'))
    assert.ok(args.includes('--max-turns'))
    assert.ok(args.includes('--allowedTools'))
    assert.ok(args.includes('--disallowedTools'))
    assert.ok(args.includes('--add-dir'))
    assert.ok(args.includes('--effort'))
    assert.ok(args.includes('--betas'))
    assert.ok(args.includes('--fallback-model'))
    assert.ok(args.includes('--thinking-budget'))
    assert.ok(args.includes('--mcp-config'))
    assert.ok(args.includes('--resume-session-at'))
    assert.ok(args.includes('--resume'))
    assert.ok(args.includes('--goal'))
  })

  test('disallowedTools with allowedTools → both flags present', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({
        allowedTools: ['Read', 'Write'],
        disallowedTools: ['Bash', 'Exec']
      })
    )
    const allowIdx = args.indexOf('--allowedTools')
    const disallowIdx = args.indexOf('--disallowedTools')
    assert.ok(allowIdx >= 0, 'allowedTools should be present')
    assert.ok(disallowIdx >= 0, 'disallowedTools should be present')
    assert.equal(args[allowIdx + 1], 'Read,Write')
    assert.equal(args[disallowIdx + 1], 'Bash,Exec')
  })

  test('multiple additionalDirectories → multiple --add-dir flags in order', () => {
    const dirs = ['/a', '/b', '/c']
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ additionalDirectories: dirs })
    )
    const addDirIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === '--add-dir') acc.push(i)
      return acc
    }, [])
    assert.equal(addDirIndices.length, 3)
    assert.equal(args[addDirIndices[0] + 1], '/a')
    assert.equal(args[addDirIndices[1] + 1], '/b')
    assert.equal(args[addDirIndices[2] + 1], '/c')
  })

  test('multiple betas → multiple --betas flags in order', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ betas: ['alpha', 'beta', 'gamma'] })
    )
    const betaIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === '--betas') acc.push(i)
      return acc
    }, [])
    assert.equal(betaIndices.length, 3)
    assert.equal(args[betaIndices[0] + 1], 'alpha')
    assert.equal(args[betaIndices[1] + 1], 'beta')
    assert.equal(args[betaIndices[2] + 1], 'gamma')
  })
})

// ── Resume edge cases ──

describe('CLIExecutor.buildCLIArgs — resume edge cases', () => {
  test('empty string resume → --resume skipped', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ resume: '' }))
    assert.ok(!args.includes('--resume'), 'empty string should be skipped')
  })

  test('valid ID with underscores and hyphens → accepted', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ resume: 'session_id-with_mixed-chars-12345' })
    )
    assert.ok(args.includes('--resume'), 'underscores and hyphens should be valid')
  })

  test('numeric-only session ID (8+ chars) → accepted', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ resume: '12345678' })
    )
    assert.ok(args.includes('--resume'), 'numeric ID should be accepted')
  })

  test('exactly 8 char session ID → accepted (boundary)', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ resume: 'abcdefgh' })
    )
    assert.ok(args.includes('--resume'), '8 chars should pass the {8,} check')
  })

  test('7 char session ID → rejected (boundary)', () => {
    const args: string[] = (executor as any).buildCLIArgs(
      baseOpts({ resume: 'abcdefg' })
    )
    assert.ok(!args.includes('--resume'), '7 chars should fail the {8,} check')
  })
})

// ── maxTurns edge cases ──

describe('CLIExecutor.buildCLIArgs — maxTurns edge cases', () => {
  test('maxTurns = 0 → no flag (falsy)', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ maxTurns: 0 }))
    assert.ok(!args.includes('--max-turns'), 'zero maxTurns should be skipped')
  })

  test('maxTurns = 1 → --max-turns 1', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ maxTurns: 1 }))
    const idx = args.indexOf('--max-turns')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], '1')
  })

  test('large maxTurns → properly stringified', () => {
    const args: string[] = (executor as any).buildCLIArgs(baseOpts({ maxTurns: 9999 }))
    const idx = args.indexOf('--max-turns')
    assert.equal(args[idx + 1], '9999')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
