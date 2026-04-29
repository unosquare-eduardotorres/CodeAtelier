/**
 * Tests for cache-audit hooks — context amplification mitigations.
 *
 * Covers:
 * - createReadLimitHook — injects limit on unbounded Read calls
 * - createBashOutputCapHook — caps noisy Bash command output
 * - createLargeOutputWarningHook — warns after consecutive large outputs
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  createReadLimitHook,
  createBashOutputCapHook,
  createLargeOutputWarningHook
} from '../sdk-hooks'
import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal hook input payload matching the SDK shape */
function makeInput(
  toolName: string,
  toolInput: Record<string, unknown> = {},
  hookEventName: string = 'PreToolUse'
): HookInput {
  return {
    tool_name: toolName,
    tool_input: toolInput,
    hook_event_name: hookEventName
  } as HookInput
}

/** Build a PostToolUse input with tool_response */
function makePostToolUseInput(toolName: string, toolResponse: string): HookInput {
  return {
    tool_name: toolName,
    tool_response: toolResponse,
    hook_event_name: 'PostToolUse'
  } as HookInput
}

/** Stub options matching the SDK HookCallback 3rd arg */
const hookOptions = { signal: AbortSignal.abort() }

/** Call hook with all 3 required SDK args */
async function callHook(
  hook: ReturnType<typeof createReadLimitHook>,
  input: HookInput
): Promise<SyncHookJSONOutput> {
  return (await hook(input, undefined, hookOptions)) as SyncHookJSONOutput
}

// ── createReadLimitHook ────────────────────────────────────────────────────

describe('createReadLimitHook — default limit', () => {
  test('injects limit=300 on Read without limit or offset', async () => {
    const hook = createReadLimitHook(300)
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/big-file.ts' }))
    const output = result.hookSpecificOutput as Record<string, unknown>
    assert.equal(output.hookEventName, 'PreToolUse')
    const updatedInput = output.updatedInput as Record<string, unknown>
    assert.equal(updatedInput.limit, 300)
    assert.equal(updatedInput.file_path, '/proj/src/big-file.ts')
  })

  test('does not inject limit when model specifies limit', async () => {
    const hook = createReadLimitHook(300)
    const result = await callHook(
      hook,
      makeInput('Read', { file_path: '/proj/src/big-file.ts', limit: 50 })
    )
    assert.deepStrictEqual(result, {})
  })

  test('does not inject limit when model specifies offset', async () => {
    const hook = createReadLimitHook(300)
    const result = await callHook(
      hook,
      makeInput('Read', { file_path: '/proj/src/big-file.ts', offset: 100 })
    )
    assert.deepStrictEqual(result, {})
  })

  test('does not inject limit when both limit and offset are specified', async () => {
    const hook = createReadLimitHook(300)
    const result = await callHook(
      hook,
      makeInput('Read', { file_path: '/proj/src/big-file.ts', offset: 100, limit: 50 })
    )
    assert.deepStrictEqual(result, {})
  })

  test('ignores non-Read tools', async () => {
    const hook = createReadLimitHook(300)
    const result = await callHook(hook, makeInput('Grep', { pattern: 'foo', path: '/proj/src' }))
    assert.deepStrictEqual(result, {})
  })

  test('ignores Write tool', async () => {
    const hook = createReadLimitHook(300)
    const result = await callHook(
      hook,
      makeInput('Write', { file_path: '/proj/out.txt', content: 'x' })
    )
    assert.deepStrictEqual(result, {})
  })
})

describe('createReadLimitHook — custom limit', () => {
  test('uses custom limit value', async () => {
    const hook = createReadLimitHook(100)
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/big-file.ts' }))
    const output = result.hookSpecificOutput as Record<string, unknown>
    const updatedInput = output.updatedInput as Record<string, unknown>
    assert.equal(updatedInput.limit, 100)
  })
})

// ── createBashOutputCapHook ────────────────────────────────────────────────

describe('createBashOutputCapHook — noisy command patterns', () => {
  test('caps npm run build output', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', { command: 'npm run build' }))
    const output = result.hookSpecificOutput as Record<string, unknown>
    const updatedInput = output.updatedInput as Record<string, unknown>
    assert.equal(updatedInput.command, 'npm run build 2>&1 | tail -30')
  })

  test('caps npm install output', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', { command: 'npm install' }))
    const output = result.hookSpecificOutput as Record<string, unknown>
    const updatedInput = output.updatedInput as Record<string, unknown>
    assert.equal(updatedInput.command, 'npm install 2>&1 | tail -30')
  })

  test('caps npm ci output', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', { command: 'npm ci' }))
    const output = result.hookSpecificOutput as Record<string, unknown>
    const updatedInput = output.updatedInput as Record<string, unknown>
    assert.equal(updatedInput.command, 'npm ci 2>&1 | tail -30')
  })

  test('caps npx eslint output', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', { command: 'npx eslint src/' }))
    const output = result.hookSpecificOutput as Record<string, unknown>
    const updatedInput = output.updatedInput as Record<string, unknown>
    assert.equal(updatedInput.command, 'npx eslint src/ 2>&1 | tail -30')
  })

  test('caps npx tsc output', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', { command: 'npx tsc --noEmit' }))
    const output = result.hookSpecificOutput as Record<string, unknown>
    const updatedInput = output.updatedInput as Record<string, unknown>
    assert.equal(updatedInput.command, 'npx tsc --noEmit 2>&1 | tail -30')
  })

  test('caps git log without --oneline', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', { command: 'git log -20' }))
    const output = result.hookSpecificOutput as Record<string, unknown>
    const updatedInput = output.updatedInput as Record<string, unknown>
    assert.equal(updatedInput.command, 'git log -20 2>&1 | tail -30')
  })

  test('allows git log --oneline (already compact)', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', { command: 'git log --oneline -20' }))
    assert.deepStrictEqual(result, {})
  })
})

describe('createBashOutputCapHook — passthrough cases', () => {
  test('ignores non-Bash tools', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Read', { file_path: '/proj/src/x.ts' }))
    assert.deepStrictEqual(result, {})
  })

  test('ignores commands that already have | tail', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', { command: 'npm run build | tail -10' }))
    assert.deepStrictEqual(result, {})
  })

  test('ignores commands that already have | head', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', { command: 'npm run build | head -10' }))
    assert.deepStrictEqual(result, {})
  })

  test('ignores commands with output redirection >', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(
      hook,
      makeInput('Bash', { command: 'npm run build > /tmp/build.log' })
    )
    assert.deepStrictEqual(result, {})
  })

  test('ignores commands with 2> redirection', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(
      hook,
      makeInput('Bash', { command: 'npm run build 2> /tmp/err.log' })
    )
    assert.deepStrictEqual(result, {})
  })

  test('ignores non-noisy commands', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', { command: 'echo hello' }))
    assert.deepStrictEqual(result, {})
  })

  test('ignores ls command', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', { command: 'ls -la src/' }))
    assert.deepStrictEqual(result, {})
  })

  test('ignores empty command', async () => {
    const hook = createBashOutputCapHook(30)
    const result = await callHook(hook, makeInput('Bash', {}))
    assert.deepStrictEqual(result, {})
  })
})

describe('createBashOutputCapHook — custom tail lines', () => {
  test('uses custom tail lines value', async () => {
    const hook = createBashOutputCapHook(50)
    const result = await callHook(hook, makeInput('Bash', { command: 'npm run build' }))
    const output = result.hookSpecificOutput as Record<string, unknown>
    const updatedInput = output.updatedInput as Record<string, unknown>
    assert.equal(updatedInput.command, 'npm run build 2>&1 | tail -50')
  })
})

// ── createLargeOutputWarningHook ───────────────────────────────────────────

describe('createLargeOutputWarningHook — threshold detection', () => {
  test('does not warn on first large output', async () => {
    const hook = createLargeOutputWarningHook(100)
    const result = await callHook(hook, makePostToolUseInput('Read', 'x'.repeat(200)))
    assert.deepStrictEqual(result, {})
  })

  test('warns after 2 consecutive large outputs', async () => {
    const hook = createLargeOutputWarningHook(100)
    // First large output — no warning
    await callHook(hook, makePostToolUseInput('Read', 'x'.repeat(200)))
    // Second large output — should warn
    const result = await callHook(hook, makePostToolUseInput('Grep', 'y'.repeat(200)))
    const output = result.hookSpecificOutput as Record<string, unknown>
    assert.equal(output.hookEventName, 'PostToolUse')
    assert.ok(
      (output.additionalContext as string).includes('large tool outputs'),
      'should include warning about large outputs'
    )
  })

  test('resets counter after a small output', async () => {
    const hook = createLargeOutputWarningHook(100)
    // First large output
    await callHook(hook, makePostToolUseInput('Read', 'x'.repeat(200)))
    // Small output — resets counter
    await callHook(hook, makePostToolUseInput('Edit', 'ok'))
    // Another large output — should NOT warn (counter was reset)
    const result = await callHook(hook, makePostToolUseInput('Read', 'z'.repeat(200)))
    assert.deepStrictEqual(result, {})
  })

  test('resets counter after warning fires', async () => {
    const hook = createLargeOutputWarningHook(100)
    // Trigger warning (2 consecutive large)
    await callHook(hook, makePostToolUseInput('Read', 'x'.repeat(200)))
    await callHook(hook, makePostToolUseInput('Grep', 'y'.repeat(200)))
    // Next large output — should NOT warn (counter reset after warning)
    const result = await callHook(hook, makePostToolUseInput('Bash', 'z'.repeat(200)))
    assert.deepStrictEqual(result, {})
  })

  test('warns again after 2 more consecutive large outputs', async () => {
    const hook = createLargeOutputWarningHook(100)
    // First cycle — trigger warning
    await callHook(hook, makePostToolUseInput('Read', 'x'.repeat(200)))
    await callHook(hook, makePostToolUseInput('Grep', 'y'.repeat(200)))
    // Second cycle — trigger warning again
    await callHook(hook, makePostToolUseInput('Read', 'a'.repeat(200)))
    const result = await callHook(hook, makePostToolUseInput('Bash', 'b'.repeat(200)))
    const output = result.hookSpecificOutput as Record<string, unknown>
    assert.equal(output.hookEventName, 'PostToolUse')
  })

  test('ignores non-PostToolUse events', async () => {
    const hook = createLargeOutputWarningHook(100)
    const result = await callHook(
      hook,
      makeInput('Read', { file_path: '/proj/src/x.ts' }, 'PreToolUse')
    )
    assert.deepStrictEqual(result, {})
  })

  test('handles non-string tool_response gracefully', async () => {
    const hook = createLargeOutputWarningHook(100)
    const input = {
      tool_name: 'Read',
      tool_response: { data: 'object response' },
      hook_event_name: 'PostToolUse'
    } as HookInput
    const result = await callHook(hook, input)
    assert.deepStrictEqual(result, {})
  })
})

describe('createLargeOutputWarningHook — custom threshold', () => {
  test('uses custom threshold', async () => {
    const hook = createLargeOutputWarningHook(50)
    // Both outputs > 50 chars
    await callHook(hook, makePostToolUseInput('Read', 'x'.repeat(60)))
    const result = await callHook(hook, makePostToolUseInput('Grep', 'y'.repeat(60)))
    const output = result.hookSpecificOutput as Record<string, unknown>
    assert.equal(output.hookEventName, 'PostToolUse')
  })

  test('does not warn when outputs are below threshold', async () => {
    const hook = createLargeOutputWarningHook(50)
    await callHook(hook, makePostToolUseInput('Read', 'x'.repeat(30)))
    const result = await callHook(hook, makePostToolUseInput('Grep', 'y'.repeat(30)))
    assert.deepStrictEqual(result, {})
  })
})

// Summary runs after all async tests drain
summaryAsync()
