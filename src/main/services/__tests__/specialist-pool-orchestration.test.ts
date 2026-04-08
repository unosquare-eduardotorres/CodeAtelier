/**
 * Unit tests for specialist pool orchestration features:
 * - R1: Failure cascade (cascadeSkipTask, shouldCascadeSkip)
 * - R2: Inline loop detection (consecutive identical tool calls)
 * - R3: Structured output schema validation (validateTaskOutput, schema registry)
 * - Extracted methods: resolveSpecialistConfig helpers, buildDependencyContext patterns,
 *   topologicalSort, detectConclusivePattern
 */
import assert from 'node:assert/strict'
import { z } from 'zod'

import {
  validateTaskOutput,
  registerOutputSchema,
  getOutputSchema,
  listOutputSchemas,
  validateWithSchema
} from '../specialist/structured-output'
import { topologicalSort, detectConclusivePattern } from '../specialist/task-scheduler'
import type { DecomposedTask } from '../../../shared/types'

let passed = 0
let failed = 0

const asyncTests: Promise<void>[] = []

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn()
    if (result instanceof Promise) {
      asyncTests.push(
        result
          .then(() => {
            console.log(`  ✓ ${name}`)
            passed++
          })
          .catch((err) => {
            console.error(`  ✗ ${name}`)
            console.error(`    ${(err as Error).message}`)
            failed++
          })
      )
    } else {
      console.log(`  ✓ ${name}`)
      passed++
    }
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

// Helper to make a task
function makeTask(
  id: string,
  specialist: string,
  description: string,
  dependsOn: string[] = [],
  outputSchema?: string
): DecomposedTask {
  return { id, specialist, description, dependsOn, outputSchema }
}

// ══════════════════════════════════════════════════════════════════
// R1: Failure Cascade Tests
// ══════════════════════════════════════════════════════════════════

describe('R1: Failure Cascade — shouldCascadeSkip logic', () => {
  // These test the pure logic that SpecialistPoolService.shouldCascadeSkip implements.
  // We test the same algorithm in isolation since the method is private.

  test('task with no dependencies is never cascade-skipped', () => {
    const task = makeTask('t1', 'dev', 'Build feature')
    const failedSet = new Set<string>()
    const skippedSet = new Set<string>()

    const shouldSkip = task.dependsOn.some((depId) => failedSet.has(depId) || skippedSet.has(depId))
    assert.equal(shouldSkip, false)
  })

  test('task with failed dependency should be cascade-skipped', () => {
    const task = makeTask('t2', 'dev', 'Add tests', ['t1'])
    const failedSet = new Set<string>(['t1'])
    const skippedSet = new Set<string>()

    const shouldSkip = task.dependsOn.some((depId) => failedSet.has(depId) || skippedSet.has(depId))
    assert.equal(shouldSkip, true)
  })

  test('task with skipped dependency should be cascade-skipped (transitive)', () => {
    const task = makeTask('t3', 'dev', 'Deploy', ['t2'])
    const failedSet = new Set<string>(['t1'])
    const skippedSet = new Set<string>(['t2'])

    const shouldSkip = task.dependsOn.some((depId) => failedSet.has(depId) || skippedSet.has(depId))
    assert.equal(shouldSkip, true)
  })

  test('task with completed dependency is not skipped', () => {
    const task = makeTask('t2', 'dev', 'Add tests', ['t1'])
    const failedSet = new Set<string>()
    const skippedSet = new Set<string>()
    const completedSet = new Set<string>(['t1'])

    const shouldSkip = task.dependsOn.some((depId) => failedSet.has(depId) || skippedSet.has(depId))
    assert.equal(shouldSkip, false)
    // And the dep IS completed
    assert.ok(completedSet.has('t1'))
  })

  test('task with mixed dependencies — one failed, one completed — is skipped', () => {
    const task = makeTask('t3', 'tester', 'Integration tests', ['t1', 't2'])
    const failedSet = new Set<string>(['t1'])
    const skippedSet = new Set<string>()

    const shouldSkip = task.dependsOn.some((depId) => failedSet.has(depId) || skippedSet.has(depId))
    assert.equal(shouldSkip, true)
  })

  test('transitive cascade chain: t1 fails → t2 skipped → t3 skipped', () => {
    const t2 = makeTask('t2', 'dev', 'Step 2', ['t1'])
    const t3 = makeTask('t3', 'dev', 'Step 3', ['t2'])

    const failedSet = new Set<string>(['t1'])
    const skippedSet = new Set<string>()

    // t2 check
    const t2ShouldSkip = t2.dependsOn.some((depId) => failedSet.has(depId) || skippedSet.has(depId))
    assert.equal(t2ShouldSkip, true)
    skippedSet.add('t2')

    // t3 check (depends on t2 which is now skipped)
    const t3ShouldSkip = t3.dependsOn.some((depId) => failedSet.has(depId) || skippedSet.has(depId))
    assert.equal(t3ShouldSkip, true)
  })
})

// ══════════════════════════════════════════════════════════════════
// R2: Inline Loop Detection Tests
// ══════════════════════════════════════════════════════════════════

describe('R2: Inline Loop Detection — tool signature tracking', () => {
  // Simulates the loop detection algorithm from handleToolUseChunk

  function simulateToolCalls(
    calls: Array<{ toolName: string; toolInput: string }>,
    maxConsecutive = 3
  ): { detected: boolean; atCall: number } {
    let lastSignature: string | null = null
    let consecutiveCount = 0

    for (let i = 0; i < calls.length; i++) {
      const sig = `${calls[i].toolName}:${calls[i].toolInput}`
      if (sig === lastSignature) {
        consecutiveCount++
      } else {
        lastSignature = sig
        consecutiveCount = 1
      }

      if (consecutiveCount >= maxConsecutive) {
        return { detected: true, atCall: i + 1 }
      }
    }

    return { detected: false, atCall: calls.length }
  }

  test('detects 3 consecutive identical Read calls', () => {
    const calls = [
      { toolName: 'Read', toolInput: '{"file_path":"/src/index.ts"}' },
      { toolName: 'Read', toolInput: '{"file_path":"/src/index.ts"}' },
      { toolName: 'Read', toolInput: '{"file_path":"/src/index.ts"}' }
    ]
    const result = simulateToolCalls(calls)
    assert.equal(result.detected, true)
    assert.equal(result.atCall, 3)
  })

  test('does not trigger for different tool inputs', () => {
    const calls = [
      { toolName: 'Read', toolInput: '{"file_path":"/src/a.ts"}' },
      { toolName: 'Read', toolInput: '{"file_path":"/src/b.ts"}' },
      { toolName: 'Read', toolInput: '{"file_path":"/src/c.ts"}' }
    ]
    const result = simulateToolCalls(calls)
    assert.equal(result.detected, false)
  })

  test('does not trigger for different tool names with same input', () => {
    const calls = [
      { toolName: 'Read', toolInput: '{"file_path":"/src/a.ts"}' },
      { toolName: 'Write', toolInput: '{"file_path":"/src/a.ts"}' },
      { toolName: 'Read', toolInput: '{"file_path":"/src/a.ts"}' }
    ]
    const result = simulateToolCalls(calls)
    assert.equal(result.detected, false)
  })

  test('resets counter when different tool is interleaved', () => {
    const calls = [
      { toolName: 'Read', toolInput: '{"file_path":"/src/a.ts"}' },
      { toolName: 'Read', toolInput: '{"file_path":"/src/a.ts"}' },
      { toolName: 'Grep', toolInput: '{"pattern":"foo"}' },
      { toolName: 'Read', toolInput: '{"file_path":"/src/a.ts"}' },
      { toolName: 'Read', toolInput: '{"file_path":"/src/a.ts"}' }
    ]
    const result = simulateToolCalls(calls)
    assert.equal(result.detected, false)
  })

  test('detects loop after interleaved different call', () => {
    const calls = [
      { toolName: 'Grep', toolInput: '{"pattern":"x"}' },
      { toolName: 'Bash', toolInput: '{"command":"npm test"}' },
      { toolName: 'Bash', toolInput: '{"command":"npm test"}' },
      { toolName: 'Bash', toolInput: '{"command":"npm test"}' }
    ]
    const result = simulateToolCalls(calls)
    assert.equal(result.detected, true)
    assert.equal(result.atCall, 4)
  })

  test('respects configurable threshold', () => {
    const calls = [
      { toolName: 'Read', toolInput: 'same' },
      { toolName: 'Read', toolInput: 'same' }
    ]
    // Threshold of 2
    const result = simulateToolCalls(calls, 2)
    assert.equal(result.detected, true)

    // Default threshold of 3
    const result2 = simulateToolCalls(calls, 3)
    assert.equal(result2.detected, false)
  })
})

// ══════════════════════════════════════════════════════════════════
// R3: Structured Output Schema Validation Tests
// ══════════════════════════════════════════════════════════════════

describe('R3: Schema Registry', () => {
  test('investigation-report schema is pre-registered', () => {
    const schema = getOutputSchema('investigation-report')
    assert.ok(schema, 'investigation-report schema should be registered')
  })

  test('registerOutputSchema adds new schema', () => {
    const testSchema = z.object({
      summary: z.string().min(1),
      score: z.number().min(0).max(100)
    })
    registerOutputSchema('test-output', testSchema as z.ZodType<unknown>)
    assert.ok(getOutputSchema('test-output'))
    assert.ok(listOutputSchemas().includes('test-output'))
  })

  test('getOutputSchema returns undefined for unregistered name', () => {
    const schema = getOutputSchema('nonexistent-schema')
    assert.equal(schema, undefined)
  })

  test('listOutputSchemas returns all registered names', () => {
    const names = listOutputSchemas()
    assert.ok(names.includes('investigation-report'))
    assert.ok(names.includes('test-output'))
  })
})

describe('R3: validateTaskOutput', () => {
  // Register a test schema for these tests
  const taskResultSchema = z.object({
    status: z.enum(['success', 'partial', 'failure']),
    changes: z.array(
      z.object({
        file: z.string().min(1),
        action: z.enum(['created', 'modified', 'deleted'])
      })
    ),
    summary: z.string().min(1)
  })
  registerOutputSchema('task-result', taskResultSchema as z.ZodType<unknown>)

  test('validates correct JSON output in code fence', () => {
    const output = `I've made the changes.\n\`\`\`json\n${JSON.stringify({
      status: 'success',
      changes: [{ file: 'src/app.ts', action: 'modified' }],
      summary: 'Updated routing logic'
    })}\n\`\`\``

    const result = validateTaskOutput(output, 'task-result')
    assert.ok(result.success)
    if (result.success) {
      const data = result.data as { status: string; changes: unknown[]; summary: string }
      assert.equal(data.status, 'success')
      assert.equal(data.changes.length, 1)
    }
  })

  test('returns error for missing required fields', () => {
    const output = `\`\`\`json\n${JSON.stringify({ status: 'success' })}\n\`\`\``
    const result = validateTaskOutput(output, 'task-result')
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.errors.some((e) => e.includes('changes')))
      assert.ok(result.errors.some((e) => e.includes('summary')))
    }
  })

  test('returns error for invalid enum value', () => {
    const output = JSON.stringify({
      status: 'unknown',
      changes: [],
      summary: 'Done'
    })
    const result = validateTaskOutput(output, 'task-result')
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.errors.some((e) => e.includes('status')))
    }
  })

  test('returns error for unregistered schema', () => {
    const result = validateTaskOutput('{}', 'ghost-schema')
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.errors[0].includes('No schema registered'))
      assert.ok(result.errors[0].includes('ghost-schema'))
    }
  })

  test('returns error for output with no JSON', () => {
    const result = validateTaskOutput('I finished the task. Everything looks good!', 'task-result')
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.errors.some((e) => e.includes('No valid JSON')))
    }
  })

  test('validates investigation-report schema via registry', () => {
    const report = JSON.stringify({
      problem: 'Memory leak in event handlers',
      rootCause: 'Missing removeEventListener in cleanup',
      proposedFix: 'Add cleanup in useEffect return',
      filesAffected: [{ path: 'src/hooks/useData.ts', reason: 'Missing cleanup' }],
      impact: 'high',
      impactReason: 'Causes OOM after extended use'
    })
    const output = `\`\`\`investigation-report\n${report}\n\`\`\``
    const result = validateTaskOutput(output, 'investigation-report')
    assert.ok(result.success)
  })

  test('bracket-match extraction works for schema validation', () => {
    const output = `The result is: ${JSON.stringify({
      status: 'success',
      changes: [{ file: 'a.ts', action: 'created' }],
      summary: 'Created new file'
    })} — that's all.`
    const result = validateTaskOutput(output, 'task-result')
    assert.ok(result.success)
  })
})

// ══════════════════════════════════════════════════════════════════
// Existing Extracted Methods — topologicalSort + detectConclusivePattern
// ══════════════════════════════════════════════════════════════════

describe('topologicalSort', () => {
  test('sorts tasks respecting dependencies', () => {
    const tasks = [
      makeTask('t3', 'dev', 'Deploy', ['t2']),
      makeTask('t1', 'dev', 'Setup'),
      makeTask('t2', 'dev', 'Build', ['t1'])
    ]
    const sorted = topologicalSort(tasks)
    assert.equal(sorted[0].id, 't1')
    assert.equal(sorted[1].id, 't2')
    assert.equal(sorted[2].id, 't3')
  })

  test('preserves order for independent tasks', () => {
    const tasks = [
      makeTask('t1', 'dev', 'Task A'),
      makeTask('t2', 'dev', 'Task B'),
      makeTask('t3', 'dev', 'Task C')
    ]
    const sorted = topologicalSort(tasks)
    assert.equal(sorted.length, 3)
    assert.equal(sorted[0].id, 't1')
    assert.equal(sorted[1].id, 't2')
    assert.equal(sorted[2].id, 't3')
  })

  test('handles diamond dependencies', () => {
    const tasks = [
      makeTask('t4', 'dev', 'Final', ['t2', 't3']),
      makeTask('t2', 'dev', 'Path A', ['t1']),
      makeTask('t3', 'dev', 'Path B', ['t1']),
      makeTask('t1', 'dev', 'Start')
    ]
    const sorted = topologicalSort(tasks)
    assert.equal(sorted[0].id, 't1')
    const t4Index = sorted.findIndex((t) => t.id === 't4')
    const t2Index = sorted.findIndex((t) => t.id === 't2')
    const t3Index = sorted.findIndex((t) => t.id === 't3')
    assert.ok(t4Index > t2Index, 't4 should come after t2')
    assert.ok(t4Index > t3Index, 't4 should come after t3')
  })

  test('handles empty array', () => {
    const sorted = topologicalSort([])
    assert.equal(sorted.length, 0)
  })

  test('handles single task', () => {
    const sorted = topologicalSort([makeTask('t1', 'dev', 'Only task')])
    assert.equal(sorted.length, 1)
    assert.equal(sorted[0].id, 't1')
  })
})

describe('detectConclusivePattern', () => {
  test('detects investigation-report block', () => {
    const output = '```investigation-report\n{"problem":"test"}\n```'
    const pattern = detectConclusivePattern(output)
    assert.equal(pattern, 'investigation-report')
  })

  test('detects "Summary of Findings" header', () => {
    const output = '## Summary of Findings\nHere are my findings...'
    const pattern = detectConclusivePattern(output)
    assert.equal(pattern, 'summary-of-findings')
  })

  test('detects "Root Cause" header', () => {
    const output = '## Root Cause\nThe root cause is...'
    const pattern = detectConclusivePattern(output)
    assert.equal(pattern, 'root-cause')
  })

  test('detects natural language conclusion', () => {
    const output = 'In summary, the issue is caused by...'
    const pattern = detectConclusivePattern(output)
    assert.equal(pattern, 'natural-conclusion')
  })

  test('detects "The root cause is" statement', () => {
    const output = 'After investigation, the root cause is the missing index.'
    const pattern = detectConclusivePattern(output)
    assert.equal(pattern, 'root-cause-direct')
  })

  test('detects "Based on my analysis" wrap-up', () => {
    const output = 'Based on my analysis, there are three issues.'
    const pattern = detectConclusivePattern(output)
    assert.equal(pattern, 'analysis-wrap-up')
  })

  test('returns null for non-conclusive output', () => {
    const output = 'Let me check the file structure first.'
    const pattern = detectConclusivePattern(output)
    assert.equal(pattern, null)
  })

  test('returns null for empty string', () => {
    const pattern = detectConclusivePattern('')
    assert.equal(pattern, null)
  })
})

// ══════════════════════════════════════════════════════════════════
// validateWithSchema (generic Zod validation)
// ══════════════════════════════════════════════════════════════════

describe('validateWithSchema', () => {
  const schema = z.object({
    name: z.string().min(1),
    count: z.number().int().positive()
  })

  test('validates correct data', () => {
    const result = validateWithSchema({ name: 'test', count: 5 }, schema)
    assert.ok(result.success)
    if (result.success) {
      assert.equal(result.data.name, 'test')
      assert.equal(result.data.count, 5)
    }
  })

  test('rejects invalid data with field errors', () => {
    const result = validateWithSchema({ name: '', count: -1 }, schema)
    assert.equal(result.success, false)
    if (!result.success) {
      assert.ok(result.errors.length >= 2)
    }
  })

  test('rejects null input', () => {
    const result = validateWithSchema(null, schema)
    assert.equal(result.success, false)
  })
})

// ── Summary ────────────────────────────────────────────────────

// Wait for all async tests to complete before printing summary
Promise.all(asyncTests).then(() => {
  console.log(`\n─────────────────────────────────`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
})
