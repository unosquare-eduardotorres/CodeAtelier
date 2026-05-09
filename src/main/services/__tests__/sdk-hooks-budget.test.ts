/**
 * Tests for the tool result budget hook — context output budgeting.
 *
 * Covers:
 * - Budget hook ignores non-PostToolUse events
 * - Budget hook accumulates tool output size
 * - Budget hook fires warning when threshold exceeded
 * - Budget hook resets after warning so it can re-trigger
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { createToolResultBudgetHook } from '../sdk-hooks'
import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a PostToolUse hook input with tool_response of given size */
function makePostToolUseInput(toolName: string, responseLength: number): HookInput {
  return {
    tool_name: toolName,
    tool_response: 'x'.repeat(responseLength),
    hook_event_name: 'PostToolUse'
  } as HookInput
}

/** Build a PreToolUse input (should be ignored) */
function makePreToolUseInput(toolName: string): HookInput {
  return {
    tool_name: toolName,
    tool_input: {},
    hook_event_name: 'PreToolUse'
  } as HookInput
}

/** Stub options matching the SDK HookCallback 3rd arg */
const hookOptions = { signal: AbortSignal.abort() }

/** Call hook with all 3 required SDK args */
async function callHook(
  hook: ReturnType<typeof createToolResultBudgetHook>,
  input: HookInput
): Promise<SyncHookJSONOutput> {
  return (await hook(input, undefined, hookOptions)) as SyncHookJSONOutput
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('createToolResultBudgetHook', () => {
  test('ignores PreToolUse events', async () => {
    const hook = createToolResultBudgetHook(1000)
    const result = await callHook(hook, makePreToolUseInput('Read'))
    assert.deepStrictEqual(result, {})
  })

  test('does not trigger under threshold', async () => {
    const hook = createToolResultBudgetHook(10_000)
    // 5K chars — well under 10K threshold
    const result = await callHook(hook, makePostToolUseInput('Read', 5_000))
    assert.deepStrictEqual(result, {})
  })

  test('accumulates across multiple calls', async () => {
    const hook = createToolResultBudgetHook(10_000)
    // 4K + 4K = 8K, still under 10K
    await callHook(hook, makePostToolUseInput('Read', 4_000))
    const result = await callHook(hook, makePostToolUseInput('Grep', 4_000))
    assert.deepStrictEqual(result, {})
  })

  test('triggers warning when threshold exceeded', async () => {
    const hook = createToolResultBudgetHook(10_000)
    // 6K + 6K = 12K, over 10K threshold
    await callHook(hook, makePostToolUseInput('Read', 6_000))
    const result = await callHook(hook, makePostToolUseInput('Grep', 6_000))
    const output = result.hookSpecificOutput as Record<string, unknown>
    assert.equal(output.hookEventName, 'PostToolUse')
    assert.ok((output.additionalContext as string).includes('Context budget alert'))
  })

  test('resets after warning and can re-trigger', async () => {
    const hook = createToolResultBudgetHook(10_000)
    // First trigger: 12K over 10K
    await callHook(hook, makePostToolUseInput('Read', 12_000))

    // After reset, next small call should be fine
    const smallResult = await callHook(hook, makePostToolUseInput('Read', 5_000))
    assert.deepStrictEqual(smallResult, {})

    // But a large call should re-trigger
    const bigResult = await callHook(hook, makePostToolUseInput('Read', 8_000))
    const output = bigResult.hookSpecificOutput as Record<string, unknown>
    assert.ok((output.additionalContext as string).includes('Context budget alert'))
  })

  test('handles missing tool_response gracefully', async () => {
    const hook = createToolResultBudgetHook(10_000)
    const input = {
      tool_name: 'Read',
      hook_event_name: 'PostToolUse'
      // no tool_response
    } as HookInput
    const result = await callHook(hook, input)
    assert.deepStrictEqual(result, {})
  })

  test('small tier budget (30K) triggers at 31K chars', async () => {
    const hook = createToolResultBudgetHook(30_000) // small tier value
    // Single call exceeding 30K budget → should trigger
    const result = await callHook(hook, makePostToolUseInput('Read', 31_000))
    const output = result.hookSpecificOutput as Record<string, unknown>
    assert.ok((output.additionalContext as string).includes('Context budget alert'))
  })

  test('small tier budget (30K) does not trigger at 25K chars', async () => {
    const hook = createToolResultBudgetHook(30_000) // small tier value
    const result = await callHook(hook, makePostToolUseInput('Read', 25_000))
    assert.deepStrictEqual(result, {})
  })

  test('medium tier budget (100K) triggers at 101K chars', async () => {
    const hook = createToolResultBudgetHook(100_000) // medium tier value
    const result = await callHook(hook, makePostToolUseInput('Read', 101_000))
    const output = result.hookSpecificOutput as Record<string, unknown>
    assert.ok((output.additionalContext as string).includes('Context budget alert'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
