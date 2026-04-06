/**
 * Unit tests for agent service pure functions.
 * Tests summarizeToolInput, conclusive pattern detection, and topological sort logic.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

import { summarizeToolInput } from '../agent-base.service'

// ── summarizeToolInput ──────────────────────────────────────

describe('summarizeToolInput', () => {
  test('Bash — returns description when available', () => {
    const result = summarizeToolInput('Bash', {
      command: 'ls -la',
      description: 'List files'
    })
    assert.equal(result, 'List files')
  })

  test('Bash — falls back to command when no description', () => {
    const result = summarizeToolInput('Bash', { command: 'npm run test' })
    assert.equal(result, 'npm run test')
  })

  test('Bash — returns empty string when no input', () => {
    const result = summarizeToolInput('Bash', {})
    assert.equal(result, '')
  })

  test('Read — returns relative path when workspace provided', () => {
    const result = summarizeToolInput(
      'Read',
      { file_path: '/home/user/project/src/index.ts' },
      '/home/user/project'
    )
    assert.equal(result, 'src/index.ts')
  })

  test('Read — returns absolute path when no workspace', () => {
    const result = summarizeToolInput('Read', {
      file_path: '/home/user/project/src/index.ts'
    })
    assert.equal(result, '/home/user/project/src/index.ts')
  })

  test('Read — returns empty for missing file_path', () => {
    const result = summarizeToolInput('Read', {})
    assert.equal(result, '')
  })

  test('Write — returns relative path', () => {
    const result = summarizeToolInput(
      'Write',
      { file_path: '/proj/src/foo.ts' },
      '/proj'
    )
    assert.equal(result, 'src/foo.ts')
  })

  test('Edit — returns relative path', () => {
    const result = summarizeToolInput(
      'Edit',
      { file_path: '/proj/src/bar.ts' },
      '/proj'
    )
    assert.equal(result, 'src/bar.ts')
  })

  test('Grep — returns pattern with path', () => {
    const result = summarizeToolInput(
      'Grep',
      { pattern: 'TODO', path: '/proj/src' },
      '/proj'
    )
    assert.equal(result, '/TODO/ in src')
  })

  test('Grep — returns pattern without path', () => {
    const result = summarizeToolInput('Grep', { pattern: 'fixme' })
    assert.equal(result, '/fixme/')
  })

  test('Glob — returns pattern', () => {
    const result = summarizeToolInput('Glob', { pattern: '**/*.ts' })
    assert.equal(result, '**/*.ts')
  })

  test('WebSearch — returns query', () => {
    const result = summarizeToolInput('WebSearch', {
      query: 'electron ipc best practices'
    })
    assert.equal(result, 'electron ipc best practices')
  })

  test('WebFetch — returns url', () => {
    const result = summarizeToolInput('WebFetch', {
      url: 'https://example.com/api'
    })
    assert.equal(result, 'https://example.com/api')
  })

  test('TodoRead — returns task management label', () => {
    const result = summarizeToolInput('TodoRead', {})
    assert.equal(result, 'Task management')
  })

  test('TodoWrite — returns task management label', () => {
    const result = summarizeToolInput('TodoWrite', {})
    assert.equal(result, 'Task management')
  })

  test('TaskOutput — returns truncated task id', () => {
    const result = summarizeToolInput('TaskOutput', {
      id: 'abc1234567890'
    })
    assert.equal(result, 'Reading output of task abc1234…')
  })

  test('Unknown tool — returns empty string', () => {
    const result = summarizeToolInput('CustomTool', { data: 'hello' })
    assert.equal(result, '')
  })
})

// ── Conclusive pattern detection (regex extraction) ────────

describe('Conclusive pattern detection (regex tests)', () => {
  // These are the same patterns used in SpecialistPoolService
  const CONCLUSIVE_PATTERNS: RegExp[] = [
    /```investigation-report\s*\n[\s\S]*?```/,
    /## Summary of Findings\b/,
    /## Root Cause\b/,
    /\b(?:In summary|In conclusion|To summarize),\s/,
    /## Recommendations?\b/
  ]

  const labels = [
    'investigation-report',
    'summary-of-findings',
    'root-cause',
    'natural-conclusion',
    'recommendations'
  ]

  function detectConclusivePattern(output: string): string | null {
    for (let i = 0; i < CONCLUSIVE_PATTERNS.length; i++) {
      if (CONCLUSIVE_PATTERNS[i].test(output)) {
        return labels[i]
      }
    }
    return null
  }

  test('detects investigation-report block', () => {
    const output = '```investigation-report\n{"problem":"test"}\n```'
    assert.equal(detectConclusivePattern(output), 'investigation-report')
  })

  test('detects Summary of Findings header', () => {
    const output = 'Analysis complete.\n## Summary of Findings\nThe issue...'
    assert.equal(detectConclusivePattern(output), 'summary-of-findings')
  })

  test('detects Root Cause header', () => {
    const output = '## Root Cause\nThe error stems from...'
    assert.equal(detectConclusivePattern(output), 'root-cause')
  })

  test('detects "In summary" natural conclusion', () => {
    const output = 'In summary, the authentication module needs refactoring.'
    assert.equal(detectConclusivePattern(output), 'natural-conclusion')
  })

  test('detects "In conclusion" natural conclusion', () => {
    const output = 'In conclusion, the fix is straightforward.'
    assert.equal(detectConclusivePattern(output), 'natural-conclusion')
  })

  test('detects "To summarize" natural conclusion', () => {
    const output = 'To summarize, there are three key changes needed.'
    assert.equal(detectConclusivePattern(output), 'natural-conclusion')
  })

  test('detects Recommendations header', () => {
    const output = '## Recommendations\n1. Add null check\n2. Update tests'
    assert.equal(detectConclusivePattern(output), 'recommendations')
  })

  test('detects Recommendation (singular) header', () => {
    const output = '## Recommendation\nUpgrade to latest SDK.'
    assert.equal(detectConclusivePattern(output), 'recommendations')
  })

  test('returns null for non-conclusive output', () => {
    const output = 'Still investigating the issue. Looking at file structure.'
    assert.equal(detectConclusivePattern(output), null)
  })

  test('returns null for empty output', () => {
    assert.equal(detectConclusivePattern(''), null)
  })

  test('does not match partial headers', () => {
    const output = '## Summary of Fin'
    assert.equal(detectConclusivePattern(output), null)
  })

  test('prioritizes investigation-report over other patterns', () => {
    const output = '```investigation-report\n{}\n```\n## Root Cause\nSomething'
    assert.equal(detectConclusivePattern(output), 'investigation-report')
  })
})

// ── Topological sort (algorithm extraction) ────────────

describe('Topological sort', () => {
  interface Task {
    id: string
    dependsOn: string[]
  }

  function topologicalSort(tasks: Task[]): Task[] {
    const taskMap = new Map(tasks.map((t) => [t.id, t]))
    const visited = new Set<string>()
    const result: Task[] = []

    const visit = (id: string): void => {
      if (visited.has(id)) return
      visited.add(id)
      const task = taskMap.get(id)
      if (!task) return
      for (const dep of task.dependsOn) {
        visit(dep)
      }
      result.push(task)
    }

    for (const task of tasks) {
      visit(task.id)
    }

    return result
  }

  test('returns tasks in dependency order', () => {
    const tasks: Task[] = [
      { id: 'c', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'a', dependsOn: [] }
    ]
    const sorted = topologicalSort(tasks)
    const ids = sorted.map((t) => t.id)
    assert.deepEqual(ids, ['a', 'b', 'c'])
  })

  test('preserves order for independent tasks', () => {
    const tasks: Task[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
      { id: 'c', dependsOn: [] }
    ]
    const sorted = topologicalSort(tasks)
    assert.equal(sorted.length, 3)
  })

  test('handles diamond dependency', () => {
    const tasks: Task[] = [
      { id: 'd', dependsOn: ['b', 'c'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'a', dependsOn: [] }
    ]
    const sorted = topologicalSort(tasks)
    const ids = sorted.map((t) => t.id)
    // 'a' must come before 'b' and 'c', 'd' must be last
    assert.ok(ids.indexOf('a') < ids.indexOf('b'))
    assert.ok(ids.indexOf('a') < ids.indexOf('c'))
    assert.ok(ids.indexOf('b') < ids.indexOf('d'))
    assert.ok(ids.indexOf('c') < ids.indexOf('d'))
  })

  test('handles single task', () => {
    const tasks: Task[] = [{ id: 'solo', dependsOn: [] }]
    const sorted = topologicalSort(tasks)
    assert.equal(sorted.length, 1)
    assert.equal(sorted[0].id, 'solo')
  })

  test('handles empty task list', () => {
    const sorted = topologicalSort([])
    assert.equal(sorted.length, 0)
  })

  test('skips missing dependencies gracefully', () => {
    const tasks: Task[] = [
      { id: 'b', dependsOn: ['missing'] },
      { id: 'a', dependsOn: [] }
    ]
    // Should not throw — just skips the missing dep
    const sorted = topologicalSort(tasks)
    assert.equal(sorted.length, 2)
  })

  test('complex chain with multiple dependency levels', () => {
    const tasks: Task[] = [
      { id: 'e', dependsOn: ['c', 'd'] },
      { id: 'd', dependsOn: ['b'] },
      { id: 'c', dependsOn: ['a', 'b'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'a', dependsOn: [] }
    ]
    const sorted = topologicalSort(tasks)
    const ids = sorted.map((t) => t.id)
    // Verify all dependency constraints
    assert.ok(ids.indexOf('a') < ids.indexOf('b'))
    assert.ok(ids.indexOf('a') < ids.indexOf('c'))
    assert.ok(ids.indexOf('b') < ids.indexOf('c'))
    assert.ok(ids.indexOf('b') < ids.indexOf('d'))
    assert.ok(ids.indexOf('c') < ids.indexOf('e'))
    assert.ok(ids.indexOf('d') < ids.indexOf('e'))
  })
})

// ── tierToModelAction (pure function) ──────────────────

describe('tierToModelAction', () => {
  // Replicated from specialist-pool.service.ts since it's module-private
  function tierToModelAction(tier: string): string {
    switch (tier) {
      case 'haiku': return 'specialist:simple'
      case 'sonnet': return 'specialist:moderate'
      case 'opus': return 'specialist:complex'
      default: return 'specialist:moderate'
    }
  }

  test('haiku maps to specialist:simple', () => {
    assert.equal(tierToModelAction('haiku'), 'specialist:simple')
  })

  test('sonnet maps to specialist:moderate', () => {
    assert.equal(tierToModelAction('sonnet'), 'specialist:moderate')
  })

  test('opus maps to specialist:complex', () => {
    assert.equal(tierToModelAction('opus'), 'specialist:complex')
  })

  test('unknown tier defaults to specialist:moderate', () => {
    assert.equal(tierToModelAction('unknown'), 'specialist:moderate')
    assert.equal(tierToModelAction(''), 'specialist:moderate')
  })
})

// Report handled by test runner
