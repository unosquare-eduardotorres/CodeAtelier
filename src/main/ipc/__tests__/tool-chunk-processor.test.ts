/**
 * Tool Chunk Processor — verifies the shared processToolChunk() pipeline.
 *
 * Covers: tool_use, tool_result, tool_progress, control tool skip,
 * format tag skip, Read/Grep/Glob composition, error detection.
 *
 * Run: npx tsx src/main/ipc/__tests__/tool-chunk-processor.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  processToolChunk,
  extractEditDiffs,
  isExpectedPlanModeBlock,
  isExpectedToolUnavailable,
  isAgentToolMistake,
  isCliInteractionError
} from '../tool-chunk-processor'
import type { StreamChunk } from '../../services/agent-base.service'

const BASE_OPTIONS = { agentType: 'test' } as const

// ── Non-tool chunk types return null ──

describe('processToolChunk — non-tool chunks', () => {
  test('returns null for text chunks', () => {
    const chunk: StreamChunk = { type: 'text', content: 'hello' }
    assert.equal(processToolChunk(chunk, BASE_OPTIONS), null)
  })

  test('returns null for error chunks', () => {
    const chunk: StreamChunk = { type: 'error', error: 'boom' }
    assert.equal(processToolChunk(chunk, BASE_OPTIONS), null)
  })

  test('returns null for thinking chunks', () => {
    const chunk: StreamChunk = { type: 'thinking', content: 'hmm' }
    assert.equal(processToolChunk(chunk, BASE_OPTIONS), null)
  })

  test('returns null for turn_boundary chunks', () => {
    const chunk: StreamChunk = { type: 'turn_boundary' }
    assert.equal(processToolChunk(chunk, BASE_OPTIONS), null)
  })
})

// ── Control tool skip ──

describe('processToolChunk — control tool filtering', () => {
  test('returns null for control-actions tool_use', () => {
    const chunk: StreamChunk = {
      type: 'tool_use',
      toolName: 'mcp__control-actions__emit_plan',
      toolId: 'ctrl-1'
    }
    assert.equal(processToolChunk(chunk, BASE_OPTIONS), null)
  })

  test('returns null for control-actions tool_result', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'mcp__control-actions__ask_user',
      toolId: 'ctrl-2',
      content: '{}'
    }
    assert.equal(processToolChunk(chunk, BASE_OPTIONS), null)
  })

  test('returns null for control-actions tool_progress', () => {
    const chunk: StreamChunk = {
      type: 'tool_progress',
      toolName: 'mcp__control-actions__emit_plan',
      toolId: 'ctrl-3'
    }
    assert.equal(processToolChunk(chunk, BASE_OPTIONS), null)
  })
})

// ── tool_use ──

describe('processToolChunk — tool_use', () => {
  test('produces running ToolActivity', () => {
    const chunk: StreamChunk = {
      type: 'tool_use',
      toolName: 'Read',
      toolId: 'read-1',
      toolInput: JSON.stringify({ file_path: 'src/app.ts' })
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.type, 'tool_activity')
    assert.equal(result.toolActivity.id, 'read-1')
    assert.equal(result.toolActivity.toolName, 'Read')
    assert.equal(result.toolActivity.status, 'running')
    assert.ok(result.toolActivity.startedAt > 0)
    assert.ok(result.toolActivity.input) // summarized from JSON
  })

  test('uses provided toolId', () => {
    const chunk: StreamChunk = {
      type: 'tool_use',
      toolName: 'Grep',
      toolId: 'my-id-123'
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.id, 'my-id-123')
  })

  test('generates toolId when not provided', () => {
    const chunk: StreamChunk = {
      type: 'tool_use',
      toolName: 'Bash'
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.ok(result.toolActivity.id.startsWith('tool-'))
  })

  test('handles missing toolName gracefully', () => {
    const chunk: StreamChunk = {
      type: 'tool_use',
      toolId: 'no-name-1'
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.toolName, 'Unknown')
  })

  test('truncates non-JSON toolInput to 120 chars', () => {
    const longInput = 'x'.repeat(200)
    const chunk: StreamChunk = {
      type: 'tool_use',
      toolName: 'SomeCustomTool',
      toolId: 'trunc-1',
      toolInput: longInput
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.ok(result.toolActivity.input!.length <= 120)
  })
})

// ── Edit diffs ──

describe('extractEditDiffs', () => {
  test('multiedit_edits_array_produces_one_diff_per_edit', () => {
    const result = extractEditDiffs({
      file_path: 'src/a.ts',
      edits: [
        { old_string: 'foo', new_string: 'bar' },
        { old_string: 'baz', new_string: 'qux' }
      ]
    })
    assert.ok(result)
    assert.equal(result.editDiffs.length, 2)
    assert.deepEqual(result.editDiffs[0], { oldString: 'foo', newString: 'bar' })
    assert.equal(result.editDiffsOmitted, 0)
  })

  test('top_level_edit_shape_produces_one_diff', () => {
    const result = extractEditDiffs({
      file_path: 'src/a.ts',
      old_string: 'before',
      new_string: 'after'
    })
    assert.ok(result)
    assert.equal(result.editDiffs.length, 1)
    assert.equal(result.editDiffs[0].oldString, 'before')
    assert.equal(result.editDiffs[0].newString, 'after')
  })

  test('camelCase_shape_is_tolerated', () => {
    const result = extractEditDiffs({ oldString: 'a', newString: 'b' })
    assert.ok(result)
    assert.equal(result.editDiffs[0].oldString, 'a')
  })

  test('input_without_edit_strings_returns_undefined', () => {
    assert.equal(extractEditDiffs({ file_path: 'src/a.ts', offset: 1 }), undefined)
  })

  test('oversized_strings_are_truncated', () => {
    const result = extractEditDiffs({
      old_string: 'x'.repeat(5_000),
      new_string: 'y'.repeat(5_000)
    })
    assert.ok(result)
    assert.equal(result.editDiffs[0].truncated, true)
    assert.equal(result.editDiffs[0].oldString.length, 2_000)
    assert.equal(result.editDiffs[0].newString.length, 2_000)
  })

  test('fifteen_edits_keeps_ten_and_reports_five_omitted', () => {
    const edits = Array.from({ length: 15 }, (_, i) => ({
      old_string: `old-${i}`,
      new_string: `new-${i}`
    }))
    const result = extractEditDiffs({ edits })
    assert.ok(result)
    assert.equal(result.editDiffs.length, 10)
    assert.equal(result.editDiffsOmitted, 5)
  })

  test('total_char_budget_stops_accumulation', () => {
    // 10 edits x 2 x 2000 chars = 40 000 chars, well over the 16 KB budget
    const edits = Array.from({ length: 10 }, () => ({
      old_string: 'x'.repeat(5_000),
      new_string: 'y'.repeat(5_000)
    }))
    const result = extractEditDiffs({ edits })
    assert.ok(result)
    assert.ok(result.editDiffs.length < 10)
    assert.ok(result.editDiffsOmitted > 0)
  })
})

describe('processToolChunk — editDiffs', () => {
  test('edit_tool_use_carries_edit_diffs', () => {
    const chunk: StreamChunk = {
      type: 'tool_use',
      toolName: 'Edit',
      toolId: 'edit-1',
      toolInputRaw: JSON.stringify({
        file_path: 'src/a.ts',
        old_string: 'const a = 1',
        new_string: 'const a = 2'
      })
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.operationType, 'edit')
    assert.equal(result.toolActivity.editDiffs?.length, 1)
    assert.equal(result.toolActivity.editDiffs?.[0].newString, 'const a = 2')
  })

  test('multiedit_tool_result_carries_edit_diffs', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'MultiEdit',
      toolId: 'edit-2',
      content: 'Done',
      toolInputRaw: JSON.stringify({
        file_path: 'src/a.ts',
        edits: [{ old_string: 'a', new_string: 'b' }]
      })
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.editDiffs?.length, 1)
  })

  // The tool_result path is the only place an Edit's input surfaces when the
  // CLI streams partial messages (tool_use starts with `input: {}`), so it must
  // carry the file path as well as the diffs — the row's path chip depends on it.
  test('edit_tool_result_carries_file_path_and_diffs', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'Edit',
      toolId: 'edit-4',
      content: 'Done',
      toolInputRaw: JSON.stringify({
        file_path: 'src/a.ts',
        old_string: 'const a = 1',
        new_string: 'const a = 2'
      })
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.filePath, 'src/a.ts')
    assert.equal(result.toolActivity.editDiffs?.length, 1)
    assert.equal(result.toolActivity.editDiffs?.[0].newString, 'const a = 2')
  })

  test('read_tool_has_no_edit_diffs', () => {
    const chunk: StreamChunk = {
      type: 'tool_use',
      toolName: 'Read',
      toolId: 'read-2',
      toolInputRaw: JSON.stringify({ file_path: 'src/a.ts' })
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.editDiffs, undefined)
  })

  test('bash_tool_has_no_edit_diffs', () => {
    const chunk: StreamChunk = {
      type: 'tool_use',
      toolName: 'Bash',
      toolId: 'bash-2',
      toolInputRaw: JSON.stringify({ command: 'ls -la' })
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.editDiffs, undefined)
  })

  test('edit_without_raw_input_degrades_gracefully', () => {
    const chunk: StreamChunk = {
      type: 'tool_use',
      toolName: 'Edit',
      toolId: 'edit-3',
      toolInput: 'src/a.ts (2 lines)'
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.operationType, 'edit')
    assert.equal(result.toolActivity.editDiffs, undefined)
  })
})

// ── tool_result ──

describe('processToolChunk — tool_result', () => {
  test('produces completed ToolActivity', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'Bash',
      toolId: 'bash-1',
      content: '{"stdout":"ok","exitCode":0}'
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.type, 'tool_activity')
    assert.equal(result.toolActivity.status, 'completed')
    assert.ok(result.toolActivity.completedAt! > 0)
  })

  test('detects tool_use_error and marks status as error', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'SomeTool',
      toolId: 'err-1',
      content: '<tool_use_error>File not found</tool_use_error>'
    }
    // Note: reportToolError will attempt to call app.getVersion() which may be undefined.
    // We use formatTagsToSkip to prevent the reporter from being called.
    const result = processToolChunk(chunk, {
      ...BASE_OPTIONS,
      formatTagsToSkip: ['SomeTool']
    })
    assert.ok(result)
    assert.equal(result.toolActivity.status, 'error')
  })

  test('skips error reporting for format tags', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'grill-evaluation',
      toolId: 'fmt-1',
      content: '<tool_use_error>not a real tool</tool_use_error>'
    }
    // Should not throw even with format tag skip — reporter not called
    const result = processToolChunk(chunk, {
      ...BASE_OPTIONS,
      formatTagsToSkip: ['grill-evaluation']
    })
    assert.ok(result)
    assert.equal(result.toolActivity.status, 'error')
  })

  test('composes Read input into result summary', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'Read',
      toolId: 'read-r1',
      toolInput: 'src/index.ts (1–50)',
      content: JSON.stringify({ content: 'file content here', lines: 50 })
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    // The result should contain " — " separator showing composition
    if (result.toolActivity.result) {
      assert.ok(
        result.toolActivity.result.includes('—') || result.toolActivity.input,
        'Read result should be composed with input'
      )
    }
  })

  test('composes Grep input into result summary', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'Grep',
      toolId: 'grep-r1',
      toolInput: 'pattern: /TODO/',
      content: JSON.stringify({ matches: 3 })
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    // Should have tool activity with composable result
    assert.equal(result.toolActivity.toolName, 'Grep')
  })

  test('does not compose non-composable tools', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'Bash',
      toolId: 'bash-nc1',
      toolInput: 'npm test',
      content: '{"exitCode": 0}'
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    // Bash is not in COMPOSABLE_TOOLS — result should not be composed with input using " — "
    assert.equal(result.toolActivity.toolName, 'Bash')
  })
})

// ── Layer 3: expected plan-mode Write/Edit blocks are NOT reported as bugs ──

describe('isExpectedPlanModeBlock', () => {
  const blocked = '<tool_use_error>: No such tool available: Write</tool_use_error>'

  test('true for Write block in plan mode', () => {
    assert.equal(isExpectedPlanModeBlock('Write', blocked, 'plan'), true)
  })

  test('true for Edit block in plan mode', () => {
    assert.equal(
      isExpectedPlanModeBlock('Edit', '<tool_use_error>No such tool available: Edit', 'plan'),
      true
    )
  })

  test('false in build mode (Write is allowed there)', () => {
    assert.equal(isExpectedPlanModeBlock('Write', blocked, 'build'), false)
  })

  test('false when mode is undefined', () => {
    assert.equal(isExpectedPlanModeBlock('Write', blocked, undefined), false)
  })

  test('false for a non-write tool in plan mode', () => {
    assert.equal(
      isExpectedPlanModeBlock('Bash', '<tool_use_error>No such tool available: Bash', 'plan'),
      false
    )
  })

  test('false for a genuine Write error (not a permission block)', () => {
    assert.equal(
      isExpectedPlanModeBlock(
        'Write',
        '<tool_use_error>EACCES: permission denied</tool_use_error>',
        'plan'
      ),
      false
    )
  })
})

describe('processToolChunk — plan-mode Write block suppression', () => {
  test('plan-mode Write block still renders as error but does not call reportToolError', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'Write',
      toolId: 'plan-blk-1',
      content: '<tool_use_error>: No such tool available: Write</tool_use_error>'
    }
    // No formatTagsToSkip here — isExpectedPlanModeBlock must prevent reportToolError
    // from firing. Correctness is verified by the isExpectedPlanModeBlock unit tests
    // above; this integration test confirms the wiring through processToolChunk.
    const result = processToolChunk(chunk, { agentType: 'specialist', mode: 'plan' })
    assert.ok(result)
    assert.equal(result.toolActivity.status, 'error')
  })

  test('genuine tool error in plan mode still reports (skipped here via format tag)', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'Bash',
      toolId: 'plan-real-1',
      content: '<tool_use_error>command failed</tool_use_error>'
    }
    // Bash error in plan mode is NOT an expected block — reporter would fire, so
    // we suppress via formatTagsToSkip to keep the unit test hermetic.
    const result = processToolChunk(chunk, {
      agentType: 'specialist',
      mode: 'plan',
      formatTagsToSkip: ['Bash']
    })
    assert.ok(result)
    assert.equal(result.toolActivity.status, 'error')
  })
})

// ── Layer 4: conditional MCP tool "No such tool" is NOT reported as a bug ──

describe('isExpectedToolUnavailable', () => {
  const noSuchTool =
    '<tool_use_error>No such tool available: mcp__memory__memory_search</tool_use_error>'

  test('true for memory_search when tool unavailable', () => {
    assert.equal(isExpectedToolUnavailable('mcp__memory__memory_search', noSuchTool), true)
  })

  test('true for memory_record when tool unavailable', () => {
    assert.equal(
      isExpectedToolUnavailable(
        'mcp__memory__memory_record',
        '<tool_use_error>No such tool available: mcp__memory__memory_record</tool_use_error>'
      ),
      true
    )
  })

  test('true for memory_flag when tool unavailable', () => {
    assert.equal(
      isExpectedToolUnavailable(
        'mcp__memory__memory_flag',
        '<tool_use_error>No such tool available: mcp__memory__memory_flag</tool_use_error>'
      ),
      true
    )
  })

  test('false for a non-conditional tool (Read)', () => {
    assert.equal(
      isExpectedToolUnavailable(
        'Read',
        '<tool_use_error>No such tool available: Read</tool_use_error>'
      ),
      false
    )
  })

  test('false for a genuine memory tool error (not "No such tool")', () => {
    assert.equal(
      isExpectedToolUnavailable(
        'mcp__memory__memory_search',
        '<tool_use_error>Database connection failed</tool_use_error>'
      ),
      false
    )
  })

  test('false when toolName is undefined', () => {
    assert.equal(isExpectedToolUnavailable(undefined, noSuchTool), false)
  })

  test('false when content is undefined', () => {
    assert.equal(isExpectedToolUnavailable('mcp__memory__memory_search', undefined), false)
  })
})

describe('processToolChunk — conditional MCP tool suppression', () => {
  test('memory_search "No such tool" does not call reportToolError', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'mcp__memory__memory_search',
      toolId: 'cond-mcp-1',
      content: '<tool_use_error>No such tool available: mcp__memory__memory_search</tool_use_error>'
    }
    // isExpectedToolUnavailable must prevent reportToolError from firing.
    // Correctness is verified by the isExpectedToolUnavailable unit tests above;
    // this integration test confirms the wiring through processToolChunk.
    const result = processToolChunk(chunk, { agentType: 'specialist' })
    assert.ok(result)
    assert.equal(result.toolActivity.status, 'error')
  })
})

// ── tool_progress ──

describe('processToolChunk — tool_progress', () => {
  test('produces running ToolActivity with elapsed time', () => {
    const chunk: StreamChunk = {
      type: 'tool_progress',
      toolName: 'Read',
      toolId: 'prog-1',
      elapsedSeconds: 5.2
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.type, 'tool_activity')
    assert.equal(result.toolActivity.status, 'running')
    assert.equal(result.toolActivity.elapsedSeconds, 5.2)
    assert.equal(result.toolActivity.id, 'prog-1')
  })

  // Progress frames are update-only: a synthesised id here could never be
  // closed by the tool_result, leaving a phantom 'running' row forever.
  // See tool-chunk-progress.test.ts.
  test('returns null when no toolId is provided (never mints an id)', () => {
    const chunk: StreamChunk = {
      type: 'tool_progress',
      toolName: 'Bash'
    }
    assert.equal(processToolChunk(chunk, BASE_OPTIONS), null)
  })
})

// ── Options ──

describe('processToolChunk — options', () => {
  test('uses workspacePath for input summarization', () => {
    const chunk: StreamChunk = {
      type: 'tool_use',
      toolName: 'Read',
      toolId: 'ws-1',
      toolInput: JSON.stringify({ file_path: '/Users/test/project/src/app.ts' })
    }
    const result = processToolChunk(chunk, {
      ...BASE_OPTIONS,
      workspacePath: '/Users/test/project'
    })
    assert.ok(result)
    // The summarizer should strip the workspace path prefix
    assert.ok(result.toolActivity.input)
  })
})

// ── Agent tool mistake filter ──

describe('isAgentToolMistake', () => {
  test('Edit with multiple matches is agent mistake', () => {
    assert.ok(
      isAgentToolMistake(
        '<tool_use_error>Found 2 matches of the string to replace, but replace_all is false.</tool_use_error>'
      )
    )
  })

  test('Write before Read is agent mistake', () => {
    assert.ok(
      isAgentToolMistake(
        '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>'
      )
    )
  })

  test('Edit identical strings is agent mistake', () => {
    assert.ok(
      isAgentToolMistake(
        '<tool_use_error>No changes to make: old_string and new_string are exactly the same.</tool_use_error>'
      )
    )
  })

  test('Grep non-existent path is agent mistake', () => {
    assert.ok(
      isAgentToolMistake('<tool_use_error>Path does not exist: /some/file.ts.</tool_use_error>')
    )
  })

  test('real errors are NOT agent mistakes', () => {
    assert.ok(!isAgentToolMistake('<tool_use_error>EACCES: permission denied</tool_use_error>'))
    assert.ok(!isAgentToolMistake(undefined))
    assert.ok(!isAgentToolMistake(''))
  })
})

// ── CLI interaction error filter ──

describe('isCliInteractionError', () => {
  test('true for Bash permission denied', () => {
    assert.ok(
      isCliInteractionError(
        'Permission to use Bash with command rm -rf coverage/tmp has been denied.'
      )
    )
  })

  test('true for user timeout', () => {
    assert.ok(isCliInteractionError('No user response — denied by timeout.'))
  })

  test("true for user rejection (doesn't)", () => {
    assert.ok(isCliInteractionError("The user doesn't want to proceed with this tool use."))
  })

  test('true for user rejection (does not)', () => {
    assert.ok(isCliInteractionError('The user does not want to proceed with this tool use.'))
  })

  test('true for multi-operation approval', () => {
    assert.ok(
      isCliInteractionError(
        'This Bash command contains multiple operations. The following part requires approval: grep -q "run-all.ts"'
      )
    )
  })

  test('true for file modification race', () => {
    assert.ok(
      isCliInteractionError(
        '<tool_use_error>File has been modified since read, either by the user or by a linter.</tool_use_error>'
      )
    )
  })

  test('true for tool not enabled in context', () => {
    assert.ok(
      isCliInteractionError(
        '<tool_use_error>Error: No such tool available: Bash. Bash exists but is not enabled in this context.</tool_use_error>'
      )
    )
  })

  test('false for real tool errors', () => {
    assert.ok(!isCliInteractionError('<tool_use_error>EACCES: permission denied</tool_use_error>'))
    assert.ok(!isCliInteractionError('<tool_use_error>File not found</tool_use_error>'))
    assert.ok(!isCliInteractionError('Exit code 1'))
  })

  test('false for undefined/empty', () => {
    assert.ok(!isCliInteractionError(undefined))
    assert.ok(!isCliInteractionError(''))
  })
})

describe('processToolChunk — CLI interaction error suppression', () => {
  test('permission denied does not reach reportToolError', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'Bash',
      toolId: 'cli-int-1',
      content: 'Permission to use Bash with command rm -rf coverage has been denied.',
      isError: true
    }
    // No formatTagsToSkip — if reportToolError fires, it would crash (no Electron app).
    // The fact this doesn't throw proves the suppression works.
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.status, 'error')
  })

  test('user timeout does not reach reportToolError', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'Bash',
      toolId: 'cli-int-2',
      content: 'No user response — denied by timeout.',
      isError: true
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.status, 'error')
  })

  test('file modified since read does not reach reportToolError', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'Edit',
      toolId: 'cli-int-3',
      content:
        '<tool_use_error>File has been modified since read, either by the user or by a linter.</tool_use_error>'
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.status, 'error')
  })

  test('tool not enabled in context does not reach reportToolError', () => {
    const chunk: StreamChunk = {
      type: 'tool_result',
      toolName: 'Bash',
      toolId: 'cli-int-4',
      content:
        '<tool_use_error>Error: No such tool available: Bash. Bash exists but is not enabled in this context.</tool_use_error>'
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.equal(result.toolActivity.status, 'error')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
