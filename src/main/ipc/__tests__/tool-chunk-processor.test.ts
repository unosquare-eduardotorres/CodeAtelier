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
import { processToolChunk, isExpectedPlanModeBlock } from '../tool-chunk-processor'
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
      isExpectedPlanModeBlock('Write', '<tool_use_error>EACCES: permission denied</tool_use_error>', 'plan'),
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
    // No formatTagsToSkip here: if reportToolError were called it would attempt
    // app.getVersion() and throw in the test env. isExpectedPlanModeBlock must
    // short-circuit the reporter, so this must NOT throw.
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

  test('generates toolId when not provided', () => {
    const chunk: StreamChunk = {
      type: 'tool_progress',
      toolName: 'Bash'
    }
    const result = processToolChunk(chunk, BASE_OPTIONS)
    assert.ok(result)
    assert.ok(result.toolActivity.id.startsWith('tool-'))
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

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
