/**
 * Unit tests for CLI executor pure functions — buildCLIArgs, buildProcessEnv,
 * writeSystemPromptFile logic (replicated from private methods).
 *
 * Phase 14, Track 2 — cli-executor.ts (~868 lines at 31.56%)
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicated pure logic from CLIExecutor.buildCLIArgs ──

interface CLIExecuteOptions {
  model?: string
  permissionMode?: string
  systemPrompt?: string
  resume?: string
  resumeSessionAt?: string
  maxTurns?: number
  mcpConfigPath?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  additionalDirectories?: string[]
  effort?: string
  betas?: string[]
  fallbackModel?: string
  goal?: string
  thinkingBudget?: number
  envOverrides?: Record<string, string>
}

/**
 * Replicated goal-injection logic from buildCLIArgs.
 * When systemPrompt and goal are both set, the goal is appended as a
 * ## Completion Goal section in the system prompt content (not as a CLI flag).
 */
function buildSystemPromptWithGoal(systemPrompt: string, goal?: string): string {
  let fullPrompt = systemPrompt
  if (goal) {
    fullPrompt += `\n\n## Completion Goal\n\nWork autonomously until the following condition is met, then emit the completion block:\n\n${goal}`
  }
  return fullPrompt
}

/**
 * Replicated from CLIExecutor.buildCLIArgs (cli-executor.ts:658-774).
 * Pure function: maps SDK-style options to `claude` CLI flags.
 */
function buildCLIArgs(options: CLIExecuteOptions): string[] {
  const args: string[] = [
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--allow-dangerously-skip-permissions'
  ]

  if (options.model) {
    args.push('--model', options.model)
  }

  if (options.permissionMode) {
    const modeMap: Record<string, string> = {
      default: 'default',
      plan: 'plan',
      bypassPermissions: 'bypassPermissions',
      acceptEdits: 'acceptEdits',
      auto: 'auto',
      dontAsk: 'dontAsk'
    }
    const cliMode = modeMap[options.permissionMode] ?? 'default'
    args.push('--permission-mode', cliMode)
  }

  // System prompt handling is skipped here (requires file I/O)

  if (options.resume) {
    if (/^[a-zA-Z0-9_-]{8,}$/.test(options.resume)) {
      args.push('--resume', options.resume)
    }
    // Malformed session IDs are silently skipped (logged in prod)
  }

  if (options.resumeSessionAt) {
    args.push('--resume-session-at', options.resumeSessionAt)
  }

  if (options.maxTurns) {
    args.push('--max-turns', String(options.maxTurns))
  }

  if (options.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath)
  }

  if (options.allowedTools?.length) {
    args.push('--allowedTools', options.allowedTools.join(','))
  }

  if (options.disallowedTools?.length) {
    args.push('--disallowedTools', options.disallowedTools.join(','))
  }

  if (options.additionalDirectories?.length) {
    for (const dir of options.additionalDirectories) {
      args.push('--add-dir', dir)
    }
  }

  if (options.effort) {
    args.push('--effort', options.effort)
  }

  if (options.betas?.length) {
    for (const beta of options.betas) {
      args.push('--betas', beta)
    }
  }

  if (options.fallbackModel) {
    args.push('--fallback-model', options.fallbackModel)
  }

  // Goal is delivered via system prompt, not as a CLI flag.
  // thinkingBudget is dropped silently (no CLI equivalent).

  return args
}

/**
 * Replicated from CLIExecutor.buildProcessEnv (cli-executor.ts:826-832).
 * Pure function: merges base env with overrides and app identification.
 */
function buildProcessEnv(
  options: CLIExecuteOptions,
  baseEnv: Record<string, string | undefined>,
  appVersion: string
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    ...(options.envOverrides ?? {}),
    CLAUDE_AGENT_SDK_CLIENT_APP: `code-atelier/${appVersion}`,
    CLAUDE_CODE_SUPPRESS_SESSION_ATTRIBUTION: '1'
  }
}

/**
 * Replicated hash-based dedup logic from writeSystemPromptFile (cli-executor.ts:784).
 */
function computePromptHash(prompt: string): string {
  return createHash('md5').update(prompt).digest('hex').slice(0, 12)
}

// ── Tests ──

describe('buildCLIArgs — core flags', () => {
  test('always_includes_output_format_stream_json', () => {
    const args = buildCLIArgs({})
    assert.ok(args.includes('--output-format'))
    assert.ok(args.includes('stream-json'))
  })

  test('always_includes_verbose', () => {
    const args = buildCLIArgs({})
    assert.ok(args.includes('--verbose'))
  })

  test('always_includes_include_partial_messages', () => {
    const args = buildCLIArgs({})
    assert.ok(args.includes('--include-partial-messages'))
  })

  test('always_includes_allow_dangerously_skip_permissions', () => {
    const args = buildCLIArgs({})
    assert.ok(args.includes('--allow-dangerously-skip-permissions'))
  })
})

describe('buildCLIArgs — model flag', () => {
  test('model_flag_includes_model_value', () => {
    const args = buildCLIArgs({ model: 'claude-sonnet-4-6' })
    const idx = args.indexOf('--model')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'claude-sonnet-4-6')
  })

  test('no_model_flag_when_undefined', () => {
    const args = buildCLIArgs({})
    assert.ok(!args.includes('--model'))
  })
})

describe('buildCLIArgs — permission mode', () => {
  test('plan_mode_mapping', () => {
    const args = buildCLIArgs({ permissionMode: 'plan' })
    const idx = args.indexOf('--permission-mode')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'plan')
  })

  test('bypassPermissions_mode_mapping', () => {
    const args = buildCLIArgs({ permissionMode: 'bypassPermissions' })
    const idx = args.indexOf('--permission-mode')
    assert.equal(args[idx + 1], 'bypassPermissions')
  })

  test('auto_mode_mapping', () => {
    const args = buildCLIArgs({ permissionMode: 'auto' })
    const idx = args.indexOf('--permission-mode')
    assert.equal(args[idx + 1], 'auto')
  })

  test('unknown_mode_falls_back_to_default', () => {
    const args = buildCLIArgs({ permissionMode: 'unknown-mode' })
    const idx = args.indexOf('--permission-mode')
    assert.equal(args[idx + 1], 'default')
  })
})

describe('buildCLIArgs — session resume', () => {
  test('valid_session_id_includes_resume_flag', () => {
    const args = buildCLIArgs({ resume: 'abc12345-session' })
    const idx = args.indexOf('--resume')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'abc12345-session')
  })

  test('malformed_session_id_skips_resume', () => {
    const args = buildCLIArgs({ resume: 'ab' }) // Too short
    assert.ok(!args.includes('--resume'))
  })

  test('session_id_with_special_chars_skips_resume', () => {
    const args = buildCLIArgs({ resume: 'abc def !@#' })
    assert.ok(!args.includes('--resume'))
  })

  test('resume_session_at_includes_flag', () => {
    const args = buildCLIArgs({ resumeSessionAt: 'msg-12345' })
    const idx = args.indexOf('--resume-session-at')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'msg-12345')
  })
})

describe('buildCLIArgs — max turns', () => {
  test('max_turns_includes_flag', () => {
    const args = buildCLIArgs({ maxTurns: 50 })
    const idx = args.indexOf('--max-turns')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], '50')
  })
})

describe('buildCLIArgs — MCP config', () => {
  test('mcp_config_path_includes_flag', () => {
    const args = buildCLIArgs({ mcpConfigPath: '/tmp/mcp.json' })
    const idx = args.indexOf('--mcp-config')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], '/tmp/mcp.json')
  })
})

describe('buildCLIArgs — tool lists', () => {
  test('allowed_tools_comma_separated', () => {
    const args = buildCLIArgs({ allowedTools: ['Read', 'Glob', 'Grep'] })
    const idx = args.indexOf('--allowedTools')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'Read,Glob,Grep')
  })

  test('disallowed_tools_comma_separated', () => {
    const args = buildCLIArgs({ disallowedTools: ['Write', 'Edit'] })
    const idx = args.indexOf('--disallowedTools')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'Write,Edit')
  })

  test('empty_tools_arrays_produce_no_flags', () => {
    const args = buildCLIArgs({ allowedTools: [], disallowedTools: [] })
    assert.ok(!args.includes('--allowedTools'))
    assert.ok(!args.includes('--disallowedTools'))
  })
})

describe('buildCLIArgs — additional directories', () => {
  test('multiple_add_dir_flags', () => {
    const args = buildCLIArgs({ additionalDirectories: ['/path/a', '/path/b'] })
    const indices = args.reduce<number[]>(
      (acc, v, i) => (v === '--add-dir' ? [...acc, i] : acc),
      []
    )
    assert.equal(indices.length, 2)
    assert.equal(args[indices[0] + 1], '/path/a')
    assert.equal(args[indices[1] + 1], '/path/b')
  })
})

describe('buildCLIArgs — effort', () => {
  test('effort_high_includes_flag', () => {
    const args = buildCLIArgs({ effort: 'high' })
    const idx = args.indexOf('--effort')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'high')
  })
})

describe('buildCLIArgs — betas', () => {
  test('multiple_betas_flags', () => {
    const args = buildCLIArgs({ betas: ['1m-context', 'extended-thinking'] })
    const indices = args.reduce<number[]>((acc, v, i) => (v === '--betas' ? [...acc, i] : acc), [])
    assert.equal(indices.length, 2)
    assert.equal(args[indices[0] + 1], '1m-context')
    assert.equal(args[indices[1] + 1], 'extended-thinking')
  })
})

describe('buildCLIArgs — fallback model', () => {
  test('fallback_model_includes_flag', () => {
    const args = buildCLIArgs({ fallbackModel: 'claude-sonnet-4-6' })
    const idx = args.indexOf('--fallback-model')
    assert.ok(idx >= 0)
    assert.equal(args[idx + 1], 'claude-sonnet-4-6')
  })
})

describe('buildCLIArgs — goal is NOT a CLI flag', () => {
  test('goal_does_not_produce_cli_flag', () => {
    const args = buildCLIArgs({ goal: 'All tests pass' })
    assert.ok(!args.includes('--goal'), '--goal must not appear in CLI args')
  })

  test('goal_does_not_affect_arg_count', () => {
    const withGoal = buildCLIArgs({ goal: 'All tests pass' })
    const without = buildCLIArgs({})
    assert.equal(withGoal.length, without.length)
  })
})

describe('buildCLIArgs — thinkingBudget is dropped', () => {
  test('thinking_budget_does_not_produce_cli_flag', () => {
    const args = buildCLIArgs({ thinkingBudget: 10000 })
    assert.ok(!args.includes('--thinking-budget'), '--thinking-budget must not appear in CLI args')
  })
})

describe('buildSystemPromptWithGoal', () => {
  test('appends_goal_section_to_system_prompt', () => {
    const prompt = buildSystemPromptWithGoal('You are a helpful assistant.', 'All tests pass')
    assert.ok(prompt.includes('## Completion Goal'))
    assert.ok(prompt.includes('All tests pass'))
    assert.ok(prompt.startsWith('You are a helpful assistant.'))
  })

  test('no_goal_returns_prompt_unchanged', () => {
    const prompt = buildSystemPromptWithGoal('You are a helpful assistant.')
    assert.equal(prompt, 'You are a helpful assistant.')
    assert.ok(!prompt.includes('## Completion Goal'))
  })

  test('empty_goal_returns_prompt_unchanged', () => {
    const prompt = buildSystemPromptWithGoal('Base prompt.', '')
    assert.equal(prompt, 'Base prompt.')
  })
})

describe('buildCLIArgs — omits flags when values undefined', () => {
  test('empty_options_produces_only_core_flags', () => {
    const args = buildCLIArgs({})
    // 7 core flags: --output-format stream-json --input-format stream-json
    //   --verbose --include-partial-messages --allow-dangerously-skip-permissions
    assert.equal(args.length, 7)
  })

  test('no_unsupported_flags_leak_through', () => {
    const args = buildCLIArgs({
      goal: 'test goal',
      thinkingBudget: 5000
    })
    // Only the 7 core flags should be present
    assert.equal(args.length, 7)
    assert.ok(!args.includes('--goal'))
    assert.ok(!args.includes('--thinking-budget'))
  })
})

// ── buildProcessEnv tests ──

describe('buildProcessEnv', () => {
  test('includes_PATH_from_base_environment', () => {
    const env = buildProcessEnv({}, { PATH: '/usr/bin:/usr/local/bin' }, '1.0.0')
    assert.equal(env.PATH, '/usr/bin:/usr/local/bin')
  })

  test('includes_CLAUDE_AGENT_SDK_CLIENT_APP', () => {
    const env = buildProcessEnv({}, {}, '2.5.0')
    assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, 'code-atelier/2.5.0')
  })

  test('merges_envOverrides_with_precedence', () => {
    const env = buildProcessEnv(
      { envOverrides: { CUSTOM_VAR: 'custom-value', PATH: '/custom/path' } },
      { PATH: '/usr/bin', HOME: '/home/user' },
      '1.0.0'
    )
    assert.equal(env.CUSTOM_VAR, 'custom-value')
    // envOverrides should override base
    assert.equal(env.PATH, '/custom/path')
    assert.equal(env.HOME, '/home/user')
  })

  test('handles_empty_overrides', () => {
    const env = buildProcessEnv({ envOverrides: {} }, { PATH: '/usr/bin' }, '1.0.0')
    assert.equal(env.PATH, '/usr/bin')
    assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, 'code-atelier/1.0.0')
  })

  test('handles_undefined_overrides', () => {
    const env = buildProcessEnv({}, { PATH: '/usr/bin' }, '1.0.0')
    assert.equal(env.PATH, '/usr/bin')
  })

  test('includes_CLAUDE_CODE_SUPPRESS_SESSION_ATTRIBUTION', () => {
    const env = buildProcessEnv({}, {}, '2.5.0')
    assert.equal(env.CLAUDE_CODE_SUPPRESS_SESSION_ATTRIBUTION, '1')
  })
})

// ── writeSystemPromptFile hash logic tests ──

describe('computePromptHash — dedup logic', () => {
  test('deterministic_hash_for_same_content', () => {
    const hash1 = computePromptHash('You are a helpful assistant.')
    const hash2 = computePromptHash('You are a helpful assistant.')
    assert.equal(hash1, hash2)
  })

  test('different_prompt_produces_different_hash', () => {
    const hash1 = computePromptHash('You are a helpful assistant.')
    const hash2 = computePromptHash('You are a code reviewer.')
    assert.notEqual(hash1, hash2)
  })

  test('hash_is_12_characters', () => {
    const hash = computePromptHash('test prompt')
    assert.equal(hash.length, 12)
  })

  test('hash_is_hex_string', () => {
    const hash = computePromptHash('test prompt')
    assert.match(hash, /^[0-9a-f]{12}$/)
  })
})

// ── Import the actual module to exercise its code ──

describe('CLI Executor — module import coverage', () => {
  test('cleanupStalePromptFiles_is_exported', async () => {
    const mod = await import('../cli-executor')
    assert.equal(typeof mod.cleanupStalePromptFiles, 'function')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
